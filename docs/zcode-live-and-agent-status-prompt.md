# zcode 指令 —— Live 标记名副其实 + 「检测 Agent 接入」分组改版

> 接着上一轮的 `fix/session-detection` 分支继续做。

======

## 背景

上一轮你做完了 hook 事件补全、推送节流和「Agent 接入」分组。主线看过实际界面后提了两个要求。

**先记住上一轮你自己核实出来的事实**（主线的分析有三处已过时，你是对的）：
- `minibar-window.ts:486` 早有 `sessionManager.on('update', ...)`，会话变化本来就即时推送
- `SessionManager` 本来就是 EventEmitter
- `claude-hook-server.ts:84` 早有 `UserPromptSubmit → thinking` 映射

所以 Antigravity 的 5–6 秒**全部来自 5 秒轮询**，与推送层无关。

## 第 1 件：Live 标记必须名副其实

**现状**：`resolveQuotaTrustState`（`agent-quota-utils.ts`）只看额度的 `authoritative`，跟会话检测毫无关系。界面上却显示 `Live`，主线认为这是误导。

**要求**：Live 必须同时满足「额度实时」和「会话实时」。但**不要简化成 Live / 估算两档**——Antigravity 的额度是权威的，只是会话慢，标成「估算」等于谎称它的额度是猜的。

**做成三档**：

| 标记 | 条件 |
|---|---|
| **实时** | 额度 `authoritative` **且** 该 agent 的会话检测是事件驱动 |
| **轮询** | 额度 `authoritative`，但会话靠轮询（有固定延迟） |
| **估算** | 额度本身非权威（优先级最高，压过会话维度） |

`需登录` / `暂无数据` / `连接中断` 这些既有状态保持不变，优先级仍然高于上面三档。

**判定依据**（自己核实，别照抄）：

- **Claude**：hook 已安装 → 事件驱动；未安装 → 轮询（transcript 思考期不落盘，实际连轮询都测不到 thinking）
- **Codex**：`codex-tailer.ts` 用了 `fs.FSWatcher`，属事件驱动 —— **但你要确认 watcher 是主通路还是只做兜底**，如果实际以 `pollInterval` 为主，那它就是轮询
- **Antigravity**：`ACTIVE_MS = 5_000` 轮询，明确不是事件驱动

**实现要点**：这个判定需要主进程把「会话检测方式」告诉渲染层。现在 quota 数据里没有这个字段。你要决定怎么传——加进 `MinibarState`、还是单独一个 IPC。选你认为侵入最小的，在报告里说明。

**不要**在渲染层硬编码「codex 一定是事件驱动」这类假设，那和现在的 `Live` 写死是同一个错误。

## 第 2 件：「Agent 接入」分组改版

**改成**：

1. 标题从「Agent 接入」改为「**检测 Agent 接入**」
2. 下面**分三行**，每个 agent 一行，各自显示：接入状态 + **原因**
3. 「修复」按钮**只挂在 Claude 那一行**

### 为什么按钮只给 Claude

三个 agent 的成因不同，只有 Claude 修得了：

- Claude 不实时 → 装 hook，**能修**
- Codex → 没有 hook 机制，取决于它自己写文件的时机，**修不了**
- Antigravity → 5 秒轮询是对语言服务器 RPC 频率的权衡，**不是故障，没东西可修**

给另外两行放「修复」按钮，点完纹丝不动，用户会以为按钮坏了。仓库设计规范第 6 条也写着「严禁展示不可用功能入口」（`docs/design/pulse-2.0-design-system.md:34`）。

### 每行要写什么

状态词和第 1 件的三档保持一致（**实时 / 轮询**）。原因要具体，不要写「正常」这种废话：

- Claude 已装 hook → 「实时 · hook 已安装」
- Claude 未装 → 「轮询 · 未安装 hook，思考中的状态检测不到」+ 右侧「修复」按钮
- Codex → 说明它靠什么机制、有什么限制
- Antigravity → 说明是 5 秒轮询、这是设计权衡不是故障

文案自己拟，但**必须说人话**，让用户看完知道「这个 agent 为什么是这个状态、我能不能做点什么」。

安装成功后仍要提示「请重开 Claude Code 会话后生效」。

## 范围

- **你负责**：`src/renderer/components/pulse/agent-quota-utils.ts`、`SettingsPage.tsx`、`OverviewPage.tsx`（Live 徽标处）、`src/renderer/components/minibar/MiniBar.tsx`（Live 徽标处）、以及为传递「检测方式」所需的主进程/preload 改动
- **不要碰**：`band-app/`、`SettingsScreen.tsx`（死文件）、`antigravity-session.ts` 和 `antigravity-policy.ts`（上一轮已评估过不动）

## 要求

1. 每件事单独 commit，前缀 `feat(live)` / `feat(agent-status)`。
2. `npm run build` 退出 0，`npm test` 全绿。**都不要用管道取退出码**。
3. 工作区有一批与本任务无关的既有改动，**只 stage 你自己改的文件**。
4. 不要为这两件事引入新配色，样式复用现有 token。

## 交付要求

1. 「会话检测方式」你用什么通路传到渲染层，为什么选它。
2. Codex 的 `FSWatcher` 你核实的结论：主通路还是兜底？据此判定它是实时还是轮询。
3. 三行的实际文案，逐字写出来。
4. `npm run build` 和 `npm test` 的真实结果。
5. 没验证的东西——三档标记在真实运行下的实际表现（尤其装/卸 hook 后 Claude 那档是否真的切换），需主线实测。

======
