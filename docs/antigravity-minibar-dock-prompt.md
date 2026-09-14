# Antigravity 指令 —— MiniBar 启动停靠 + 主窗口状态栏下移

> 贴「======」之间的内容。你在 **main 分支**上工作。

======

## 范围与分工（先读，越界就是冲突）

仓库 `C:\dev\pulse-band2`。你有两件事：

- **A. MiniBar 启动停靠**：Pulse 每次启动时，MiniBar 悬浮窗停靠在屏幕左侧或右侧（纵向竖条），而不是顶部/底部（横向条）。见第 1–4 节。
- **B. 主窗口状态栏下移**：把顶栏里的 Agent 接入状态行挪到窗口底部。见第 5 节。

有另一个 agent 在并行改渲染层，**分工按文件切死**：

- **你负责**：`src/main/minibar-window.ts`、`src/main/services/minibar-geometry.ts`、`src/main/services/minibar-preference.ts`、`src/renderer/components/layout/TopBar.tsx`、`src/renderer/components/layout/ContentArea.tsx`、`src/renderer/App.tsx`
- **另一个 agent 负责**（你一行都不要碰）：`src/renderer/components/minibar/MiniBar.tsx`、`src/renderer/components/pulse/SettingsPage.tsx`、`src/preload/index.ts`、`src/renderer/env.d.ts`

越过这条线就会和另一条分支冲突。需要渲染层配合的地方，**你只定义好主进程要发出/接收的契约，写在报告里**，不要自己去改渲染层。

## 已核实的现状（不要重新调查这几条，直接用）

1. `minibar-window.ts:44` 的默认值 `let currentDockSide: DockSide = 'right'` —— **默认值本来就是侧边，不是 bug 所在。**
2. `minibar-window.ts:384` 启动时 `if (saved.dockSide) { currentDockSide = saved.dockSide; }` 会用持久化值覆盖默认值。
3. 持久化文件是 `app.getPath('userData')/minibar-bounds.json`。本机实际内容：
   ```json
   {"x":1600,"y":170,"dockSide":"left","displayMode":"full"}
   ```
4. **矛盾点就在这里**：存的是 `left`（侧边），但用户实际看到的是横向条。说明启动路径上 `dockSide` 与最终渲染布局脱节了 —— 要么 `x/y` 被某段吸附/钳制逻辑重新判定成了 top/bottom，要么 `isHorizontalDock()` 的结果没有一致地传到窗口几何与推送给渲染层的 state。
5. `minibar-window.ts:338` 已有 `resetMiniBarDock()`（重置到主显示器右侧），`minibar-window.ts:587` 已注册 IPC `minibar:reset-dock`，但 **preload 与渲染层都没有暴露它，是一条死通道**。

## 要做的事

### 1. 先定位真因，再动手

在 `minibar-window.ts` 与 `minibar-geometry.ts` 里把启动链路走一遍：`loadSavedBounds()` → `currentDockSide` 赋值 → `isHorizontalDock()` → 初始 `initW/initH` → `clampBoundsToWorkArea()` / `calculateCollapsedBounds()` → `pushState()` 发给渲染层的 `dockSide`。

**找出「存的是 left，最终却横向」是在哪一步丢的。** 把你的定位结论和证据（文件:行号）写进报告第 1 条。不要跳过这一步直接加 workaround。

### 2. 修掉它

修真因。如果真因是几何吸附把侧边判成了上下，就修判定；如果是 state 推送里 `dockSide` 与实际窗口尺寸不自洽，就让它们同源。

**不要**用「启动时无条件强制 right」来掩盖问题——那会让用户拖到左侧的偏好也失效。

### 3. 加一个启动停靠偏好

在 `minibar-preference.ts` 里增加一个持久化项，控制启动时的停靠行为，三个取值：

| 值 | 行为 |
|---|---|
| `remember`（默认） | 沿用上次停靠位置，但**只在左/右之间沿用**；上次若是 top/bottom，启动时归到 `right` |
| `left` | 每次启动固定左侧 |
| `right` | 每次启动固定右侧 |

`remember` 作为默认值，直接满足用户「每次启动在侧边」的诉求，同时不丢失左右偏好。用户运行期间照样可以把窗口拖到顶部/底部，只是**下次启动会回到侧边**。

### 4. 把 reset-dock 这条死通道接到契约上

`minibar:reset-dock` 的 IPC 已经在主进程注册好了。你不要去改 preload，但要在报告里明确写出渲染层需要的契约：channel 名、参数、返回值。另一个 agent 会照你的报告接出 UI 入口。

同时给启动停靠偏好补上读写 IPC（命名跟现有惯例走，例如 `minibar:get-dock-preference` / `minibar:set-dock-preference`），同样把契约写进报告。

## 硬约束

1. **不碰渲染层**，见上面的分工表。
2. 每件事单独 commit，message 前缀 `fix(minibar-dock)` 或 `feat(minibar-dock)`。
3. 做完 `npm run build` 必须退出 0。**注意：不要用管道取退出码**（`npm run build | tail` 拿到的是 `tail` 的退出码），单独跑一次确认。
4. 验证前先清残留进程：`Get-Process electron,pulse-core -EA SilentlyContinue | Stop-Process -Force`。
5. 本机当前的偏好文件已经是脏数据，测试时自己删掉重建：`%APPDATA%\pulse-band-v2\minibar-bounds.json`。
6. 工作区里有一批与本任务无关的已有改动（`AGENTS.md`、`README.md`、`package*.json`、`promo/` 等），**只 stage 你自己改的文件**。

## 5. 主窗口状态栏下移（第二件事，与第 1–4 节独立）

### 需求

用户要的是：顶栏左侧那条「● 3 个 Agent 已接入 · 收到快照 12:08」**整体移到窗口底部**，内容区相应向上扩展。

### 硬约束：窗口按钮必须留在顶部

`TopBar.tsx` 现在装了两样东西，**只有第一样要下移**：

| 元素 | 处置 |
|---|---|
| 左侧状态行（状态点 + 「N 个 Agent 已接入」+ 「收到快照 HH:MM」） | **移到窗口底部** |
| 右侧窗口三联按钮（最小化 / 最大化 / 关闭） | **留在顶部，不许动** |

原因是硬的，不是风格偏好：整个 `<header>` 带 `titlebar-drag` class，**这是这个无边框窗口唯一的拖拽区**。把它整条搬到底部，用户会同时失去拖动窗口和关闭窗口的能力。

### 要做的事

1. 把状态行从 `TopBar.tsx` 抽出来，新建 `src/renderer/components/layout/StatusBar.tsx`，props 保持现有的 `state` / `updatedAt` / `lastError` 三个，判定逻辑（`agentCount`、`dotClass`、`statusTitle`、`timeText`）原样搬过去，**不要改文案，不要改判定规则** —— 那些是上一轮 ui-fix-2 刚定下来的。
2. `TopBar.tsx` 只留拖拽区 + 三联按钮。顶栏高度从 `h-[44px]` 收窄到放得下按钮的程度（按钮本身 24px，给 32px 左右即可），`border-b` 保留或去掉由你判断，说明理由。
3. `StatusBar.tsx` 用 `border-t` 而不是 `border-b`，高度对齐顶栏收窄后的值，**不要加 `titlebar-drag`**（底部不该能拖窗口）。
4. `App.tsx`：把 `<StatusBar />` 放在 `<ContentArea>` 之后、右栏 flex 容器之内。

### App.tsx 改动压到最小

**另一个分支在 `App.tsx` 上已有提交（新增了表盘页分支）。** 你在这个文件里只做两件事：加一行 import、在 `</ContentArea>` 后面加一行 `<StatusBar ... />`，并把原来那行 `<TopBar ... />` 的 props 改短。

**不要重排 JSX、不要调整缩进、不要顺手整理 import 顺序** —— 每多改一行，后面合并时就多一处冲突。

### 验收

- 窗口仍然可以按住顶栏拖动，三联按钮仍在右上角且可用。
- 状态行出现在窗口底部，文案与判定（成功/异常/未获取到数据三种点色）和下移前完全一致。
- 内容区比改动前更高，没有出现双滚动条或底部被状态栏盖住内容。
- 浅色和深色主题都检查一遍。

## 交付要求

1. 真因定位结论 + 证据（文件:行号）。
2. 改了哪些文件哪几行，为什么。
3. 渲染层需要的完整 IPC 契约（channel 名 / 参数 / 返回值），另一个 agent 要照着接。
4. `npm run build` 的真实退出码（单独跑，不经管道）。
5. 第 5 节：顶栏收窄到多少、`border-b` 你怎么处理的、`App.tsx` 实际改了几行。
6. 没验证的东西：多显示器、DPI 缩放、拖拽吸附的实际手感、窗口在各边的贴合精度、状态栏在不同窗口尺寸下的表现。你没法只靠构建证明这些。

======
