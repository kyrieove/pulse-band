# zcode 指令 —— 键盘与焦点（astra P2 第 13 项）

> 贴「======」之间的内容。你在 **feat/watchface-ui 分支**上工作。

======

## 背景

`docs/ui-improvement-review-2026-09-11.md` 第 13 项，先读那一节原文。P1 批次和 P2 的第 7、8 项已完成。

这一项的价值在于：**它不依赖视觉审美判断，可以客观验证**——能不能只用键盘走完流程，是能被测出来的。

## 范围

- **你负责**：`src/renderer/components/minibar/MiniBar.tsx`、`src/renderer/components/setup/SetupWizard.tsx`、`src/renderer/components/layout/Sidebar.tsx`、`src/renderer/index.css`
- **不要碰**：`src/main/minibar-window.ts`、`src/main/services/minibar-geometry.ts`（另一个 agent 正在改多显示器停靠）

**`index.css` 的字体栈不许动。** 你上一轮已经正确识别出「汉字 Light 是设计意图、与审查建议冲突」——那个决定还没做，在主线拍板前不要碰 `--pulse-font-sans` 和 `font-synthesis-weight`。你在这个文件里只能改焦点样式与减弱动态规则。

## 要做的事

### 1. MiniBar 圆环的键盘操作

现状：圆环是可聚焦的 `div role="button"`，但没有 Enter / Space 激活处理——能 Tab 上去，按键没反应。

让键盘能完成：展开详情、固定、关闭。行号会漂移，自己定位（搜 `role="button"` 和圆环渲染分支，横向纵向两处都有）。

### 2. 向导的焦点管理

现状：`SetupWizard` 有模态语义，但没有焦点迁入、焦点约束（focus trap）、关闭后焦点恢复。

打开时焦点移入，Tab 循环限制在向导内，Esc 或关闭后焦点回到触发它的元素。

### 3. 导航与主题的选中语义

现状：侧边栏导航和主题选择主要靠颜色和勾选表达状态，没有语义属性。

补 `aria-current` / `aria-pressed` 之类的选中语义，让状态不只存在于颜色里。

### 4. 减弱动态

现状：`prefers-reduced-motion` 规则只覆盖了 MiniBar 详情卡的部分过渡。

减弱动态开启时保留**文字状态**，去掉持续的呼吸与旋转动画。不要连同必要的状态提示一起删掉——用户仍然需要知道现在是「思考中」还是「已完成」。

## 边界

1. **不要为了无障碍重构组件结构。** 能加属性和事件处理解决的，不要改成另一套组件。
2. **不要引入无障碍库。** 焦点约束几十行原生代码能写完。
3. 圆环现在是 `div role="button"`，如果改成真 `<button>` 更省事且更正确，可以改——但要确认不破坏现有的拖拽、悬停、右键行为，并在报告里说明。

## 要求

1. 每项单独 commit，前缀 `feat(ui-a11y)`。
2. `npm run build` 必须退出 0。**不要用管道取退出码**，单独跑一次。
3. 工作区有一批与本任务无关的既有改动，**只 stage 你自己改的文件**。

## 交付要求

1. 每项改了哪些文件、用了什么方案。
2. 圆环你是加事件还是换成 `<button>`，为什么。
3. `npm run build` 的真实退出码。
4. **明确列出需要人工键盘实测的步骤清单**——写成主线可以照着走一遍的形式，例如「① 焦点进 MiniBar 圆环 ② 按 Enter 应展开详情 ③ 按 Esc 应收起」。这一项的验收只能靠人真的用键盘走一遍，你自己没法证明。
5. 没验证的东西：读屏器（NVDA / 讲述人）朗读顺序、原生透明窗口能否获得键盘焦点、系统减弱动态设置的实际效果。

======
