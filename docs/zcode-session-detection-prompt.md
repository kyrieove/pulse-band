# zcode 指令 —— 修复会话开始/结束识别不准

> 先执行 `git checkout main && git pull && git checkout -b fix/session-detection`，再贴「======」之间的内容。
> **此任务优先于真机验证。**

======

## 现象（真机实测）

1. Antigravity 开始任务后，**等 5–6 秒** PC 和手环才显示 running。
2. Claude Code 思考 30 秒，**PC 和手环完全没反应**，状态始终不变。

额度数字是准的，只有会话状态不准。

## 根因（已定位，附证据，不用重查）

四层叠加，**A 和 B 是主因**：

### A. Claude Code 的 hook 根本没安装

本机 `~/.claude/settings.json` 的 `hooks` 段是**空的**。所以 Claude 的状态完全依赖 `claude-desktop-tailer.ts`（每 500ms 轮询 transcript `.jsonl`）。

而 transcript 在**思考期间不写入新行**——Claude Code 是回合结束后才落盘。tailer 再快也读不到不存在的内容。这解释了「思考 30 秒零反应」。

工具调用能被捕获，是因为工具调用会立即写进 transcript，所以 `running_tool` 有效、`thinking` 无效。

### B. 就算装了 hook，也缺关键事件

`src/main/services/claude-hook-merge.ts:7`：

```ts
export const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
```

**缺 `UserPromptSubmit`。** `SessionStart` 只在会话首次启动时触发一次，不是每次提问。所以在一个已有会话里，「用户提问 → 我开始思考 → 第一个工具调用」这整段时间里**没有任何 hook 事件**，状态只能靠 tailer 猜。

`UserPromptSubmit` 是 Claude Code 支持的事件，且在提交瞬间触发——这正是「会话开始」的准确信号。

### C. Antigravity 轮询 5 秒

`src/main/services/antigravity-session.ts:17`：`const ACTIVE_MS = 5_000;`

### D. MiniBar 只靠 3 秒定时器，会话变化时不主动推

`src/main/minibar-window.ts:466`：`updateTimer = setInterval(pushState, 3000);`

我查过 `pushState()` 的全部调用点（L202/251/271/320/340/362/450/505/580），**没有一处是「会话状态变了」触发的**——全是窗口几何相关（拖拽、停靠、显示模式）。`session-manager.ts` 也没有任何变更通知机制（无 EventEmitter、无回调）。

**C + D 叠加最坏 8 秒**，与实测的 5–6 秒吻合。

## 要做的事

按这个顺序，**第 1、2 条是必做**：

### 1. `HOOK_EVENTS` 加 `UserPromptSubmit`，映射为 thinking

改 `claude-hook-merge.ts:7`，并在 `claude-hook-server.ts` 里加对应的状态映射（现有映射在 L78/89/111/121 附近）。

注意：`UserPromptSubmit` 不需要 matcher（`NEEDS_MATCHER` 只含 PreToolUse/PostToolUse，别动那个 Set）。

**已装过旧 hook 的用户需要重装才能拿到新事件**——检查 `claude-hook-install.ts` 的合并逻辑，确认重复安装是幂等的、且能补上新增事件，不会写出重复条目。

### 2. 会话状态变化时立即推送，不等定时器

给 `session-manager.ts` 加变更通知（EventEmitter 或回调都行，跟仓库现有风格走），`minibar-window.ts` 订阅它，在会话状态真正变化时调用 `pushState()`。

3 秒定时器**保留**作为兜底，但不再是唯一通路。

注意去抖：状态高频变化时不要把 IPC 打爆，但也不要为此引入超过 200ms 的延迟——那就白改了。

### 3. Antigravity 轮询间隔

`ACTIVE_MS = 5_000` 明显偏慢。但直接改小会增加对 Antigravity 进程的压力，**先评估再改**：看现有的 `ABSENT_MS` 退避设计和 `nextDelayOverride`（L157）的意图，判断能否做成「检测到活跃会话时临时提速、空闲时退回 5 秒」。

做不到就保持原值并说明理由——**不要为了数字好看盲目调小**。

### 4. 把 hook 安装入口加回设置页（主线明确要求，做）

**现状**：`getHookStatus` / `installHook` / `uninstallHook` 的 IPC、preload、主进程服务全都在，唯独界面入口丢了——它只存在于 `src/renderer/components/pulse/SettingsScreen.tsx`，而那个文件**无人引用**（UI 重构到 `SettingsPage.tsx` 时没迁移）。

**要做**：在 `SettingsPage.tsx` 的「运行诊断」分组**上方**新建一个「Agent 接入」分组，包含三样：

1. hook 当前状态：已安装 / 未安装（挂载时调 `getHookStatus` 读真实值）
2. 安装 / 卸载按钮（调 `installHook` / `uninstallHook`，操作后刷新状态）
3. 一行说明文字：未安装时 Claude Code 的会话状态识别不准

**要点**：
- 必须显示**当前状态**，不能只给一个按钮——用户要能一眼看出自己装没装。
- 安装成功后提示「请重开 Claude Code 会话」（hook 在会话启动时生效，不重开不生效）。
- 样式复用现有 token 和同页其它分组的写法，不要引入新配色。
- `SettingsScreen.tsx` 是死文件，**不要去改它，也不要删它**——清理死代码不在本次范围。

这一条是主线明确要求的功能补回，不属于被暂停的「UI 优化」。

### 5. Antigravity 的完成宽限期（评估，谨慎改）

`antigravity-policy.ts:13-14`：`IDLE_GRACE_MIN_MS = 4_000`、`IDLE_GRACE_MAX_MS = 40_000`。

会话转 IDLE 后要等这个宽限期才判定 completed。加上 5s 轮询和 3s 推送，**任务结束最坏 48 秒才显示「已完成」**。

宽限期本身是有意设计的（防止把中途停顿误判成结束），`nextIdleGrace()` 还会自适应。**先读懂那个策略再决定动不动**——如果它是按历史停顿时长自适应的，盲目调小会让长任务中途被误判成完成，那比慢更糟。

改不动就保持原值，在报告里说明这个 48 秒是怎么来的、为什么不能简单缩短。

## 验证方法

改完后请主线配合实测（你自己没法验）：

1. 装 hook（设置页或 `installHook`），重开一个 Claude Code 会话
2. 提一个不触发工具调用的问题（比如「解释一下这个项目的架构」），观察 **PC 和手环是否立即显示「思考中」**
3. 让 Antigravity 跑一个任务，掐表看多久显示 running
4. 会话结束后看是否及时转「已完成」

## 范围

- **你负责**：`src/main/services/claude-hook-merge.ts`、`claude-hook-server.ts`、`claude-hook-install.ts`、`session-manager.ts`、`antigravity-session.ts`、`antigravity-policy.ts`、`src/main/minibar-window.ts`、`src/renderer/components/pulse/SettingsPage.tsx`（仅第 4 条）
- **不要碰**：`band-app/`（手环端数据源是同一个 status-server，上游修好它自然跟着好）、`SettingsScreen.tsx`（死文件）、其它渲染层文件

## 要求

1. 每条单独 commit，前缀 `fix(session)`。
2. `npm run build` 必须退出 0。**不要用管道取退出码**，单独跑一次。
3. 工作区有一批与本任务无关的既有改动，**只 stage 你自己改的文件**。

## 交付要求

1. 每条改了哪些文件哪几行。
2. 第 2 条的去抖策略：阈值多少、为什么。
3. 第 3 条你改了还是没改，理由。
4. 第 4 条：「Agent 接入」分组的实际文案与状态显示方式。
5. 第 5 条：Antigravity 完成宽限期你怎么处理的。
6. `npm run build` 的真实退出码。
7. 没验证的东西——**这个 bug 是真机实测出来的，只有真机重测才算修好**。你没法自己验证 hook 是否触发，明说「需主线实测」。

======
