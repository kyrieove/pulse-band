# zcode 指令 —— MiniBar 纵向布局与停靠设置（渲染层侧）

> 贴「======」之间的内容。你在 **feat/watchface-ui 分支**上工作，不要切分支。

======

## 范围与分工（先读，越界就是冲突）

仓库 `C:\dev\pulse-band2`。目标：**Pulse 每次启动时，MiniBar 悬浮窗停靠在屏幕左侧或右侧（纵向竖条），而不是顶部/底部（横向条）。**

这件事被拆成两半并行做，**你只做渲染层这一半**：

- **你负责**：`src/renderer/components/minibar/MiniBar.tsx`、`src/renderer/components/pulse/SettingsPage.tsx`、`src/preload/index.ts`、`src/renderer/env.d.ts`
- **另一个 agent 负责**（你一行都不要碰）：`src/main/minibar-window.ts`、`src/main/services/minibar-geometry.ts`、`src/main/services/minibar-preference.ts`

越过这条线就会冲突。主进程那边正在修「存的 dockSide 是 left、实际却渲染成横向」的真因，并新增启动停靠偏好的 IPC。

## 已核实的现状（直接用，不用重查）

1. `MiniBar.tsx:130` 附近：`const isHorizontal = dockSide === 'top' || dockSide === 'bottom'`。
2. MiniBar 有**两套渲染分支**：横向在 `MiniBar.tsx:1201` 附近，纵向在 `MiniBar.tsx:1036` 附近（行号会随改动漂移，以实际为准）。
3. 本机持久化的偏好是 `{"dockSide":"left"}`，但实际显示为横向条 —— 真因由主进程那边定位与修复，**不是你的任务**。
4. 主进程已注册 IPC `minibar:reset-dock`（重置到主显示器右侧），但 **preload 和渲染层都没暴露，是死通道**。

## 要做的事

### 1. 先确认纵向分支本身是对的

astra 的 UI 审查把「纵向 MiniBar 与各贴边方向」列为**从未验证**项。主进程修完之后窗口会真的变成竖条，纵向分支会第一次被真实使用。

所以先把纵向渲染分支通读一遍，重点看：

- 三个 Agent 圆环在竖排下的间距、Logo 与百分比是否会挤在一起
- 展开详情卡在 `left` 停靠时往右弹、在 `right` 停靠时往左弹，是否会弹出屏幕外
- 固定/收起按钮在竖排下的位置与点击区域
- 收起态（edge-tab）在左右两侧的朝向

**发现问题就修，但只修纵向分支，不要顺手改横向分支的样式。**

### 2. 接出 reset-dock 入口

在 `preload/index.ts` 的 `pulse` 对象里暴露 `minibar:reset-dock`（形状对齐已有的 `setMiniBarVisible` 等），补 `env.d.ts` 类型，然后在 **MiniBar 的右键菜单**里加一项「重置悬浮窗位置」。

右键菜单的现有实现在 `MiniBar.tsx` 的 `contextMenu` 相关代码里，照现有菜单项的写法加，不要新建一套菜单。

### 3. 设置页加启动停靠选项

主进程那边会新增一个启动停靠偏好，三个取值：`remember`（默认，只在左右之间沿用；上次若是上下则归到右侧）、`left`、`right`。

**它的 IPC channel 名、参数和返回值，以另一个 agent 的报告为准。** 在拿到那份契约之前：

- 先把第 1、2 步做完并提交
- 第 3 步的 UI 可以先写好（在 `SettingsPage.tsx` 的「显示」分组里加一个三选一），但**接线部分等契约到手再填**，不要自己猜 channel 名

如果你开始做时契约已经给你了，就直接接上。

样式复用现有 token（`var(--bg-subtle)`、`var(--text-primary)`、`var(--accent-wash)` 等），参考同文件里「显示额度悬浮窗」那一项的写法，不要引入新配色。

## 硬约束

1. **不碰主进程**，见上面的分工表。
2. 每件事单独 commit，message 前缀 `feat(minibar-dock)` 或 `fix(minibar-dock)`。
3. 做完 `npm run build` 必须退出 0。**注意：不要用管道取退出码**（`npm run build | tail` 拿到的是 `tail` 的退出码），单独跑一次确认。
4. 验证前先清残留进程：`Get-Process electron,pulse-core -EA SilentlyContinue | Stop-Process -Force`。
5. 工作区里有一批与本任务无关的已有改动（`AGENTS.md`、`README.md`、`package*.json`、`promo/` 等），**只 stage 你自己改的文件**。
6. 这个分支上已有表盘功能的四个 commit，不要动它们。

## 交付要求

1. 纵向分支你实际检查了哪几点、发现了什么、改了什么（没发现问题就明说「通读后未发现问题」，不要为了交差硬改）。
2. reset-dock 的 preload 形状与右键菜单项落在哪。
3. 设置页那一项：UI 写到什么程度、接线有没有完成、卡在哪个契约上。
4. `npm run build` 的真实退出码（单独跑，不经管道）。
5. 没验证的东西：真实窗口里的纵向渲染、左右两侧的详情卡弹出方向、多显示器、DPI 缩放、鼠标穿透。**只做了构建就不要写「已验证」。**

======
