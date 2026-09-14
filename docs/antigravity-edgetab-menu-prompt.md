# Antigravity 指令 —— 修复 edge-tab 右键菜单不可用

> 贴「======」之间的内容。你在 **feat/watchface-ui 分支**上工作（不是 main，前一轮的分支指示已作废）。

======

## 缺陷（已核实，不用重新调查）

MiniBar 收起成「边缘标签」（edge-tab）后，右键菜单**完全看不见**。

| 事实 | 证据 |
|---|---|
| 纵向 edge-tab 物理窗口 **18 × 48** | `minibar-geometry.ts:19-20` |
| 横向 edge-tab 物理窗口 **48 × 18** | `minibar-geometry.ts:21-22` |
| 右键菜单 **172 × 230** | `MiniBar.tsx:486-487` |
| 菜单 X 按 370px 展开窗口算，得 92 | `MiniBar.tsx:491-493` |
| `setWindowExpanded` 在 edge-tab 态直接 `return`，窗口永不变宽 | `minibar-window.ts:320` |

菜单被系统按窗口边界裁掉。渲染层单方面改坐标无意义——172px 的菜单塞不进 18px 的窗口。

## 你的范围

这次主进程和渲染层的菜单部分都归你，因为耦合太紧，拆开会来回等：

- **你负责**：`src/main/minibar-window.ts`、`src/main/services/minibar-geometry.ts`、`src/renderer/components/minibar/MiniBar.tsx`
- **另一个 agent 负责**（一行都不要碰）：`src/renderer/index.css`、`src/renderer/components/pulse/AgentCard.tsx`、`src/renderer/components/pulse/AgentSection.tsx`、`src/renderer/components/pulse/OverviewPage.tsx`

## 两个方案，你评估后选一个并说明理由

**方案 A：右键时临时展宽窗口。** edge-tab 态收到右键，把窗口临时 resize 到能容纳菜单（约 190×250），菜单关闭后恢复 18×48。要处理的边角：展宽方向不能越过屏幕边缘、菜单关闭/失焦/点击菜单项后都要复位、复位期间不能被 `saveBounds()` 把临时尺寸写进持久化文件。

**方案 B：edge-tab 态改用 Electron 原生菜单。** 用 `Menu.popup()`，系统菜单不受窗口边界裁切，18px 窗口上也能正常弹出。代价是丢掉现在的黑底半透明自定义样式，edge-tab 下的菜单外观会和展开态不一致。

**我的倾向是 B**（改动小、边角少、不碰窗口几何），但你比我更清楚现有菜单项的行为，最终你定。选 A 就把复位路径写清楚。

## 要求

1. **横向和纵向 edge-tab 都要修**，两个方向都有这个缺陷。
2. 展开态（full 模式）的菜单现在是好的，**不要改它的样式或坐标**。
3. 每件事单独 commit，前缀 `fix(minibar-menu)`。
4. `npm run build` 必须退出 0。**不要用管道取退出码**（`npm run build | tail` 拿到的是 `tail` 的），单独跑一次。
5. 工作区有一批与本任务无关的已有改动（`AGENTS.md`、`README.md`、`package*.json`、`promo/` 等），**只 stage 你自己改的文件**。

## 交付要求

1. 选了 A 还是 B，理由。
2. 改了哪些文件哪几行。
3. `npm run build` 的真实退出码。
4. 没验证的东西。这个缺陷**必须真实跑应用才能确认修好**——收起成边缘标签、右键、看菜单是否出现且可点。你只做了构建的话，明说「未实测」，不要写「已修复」。

======
