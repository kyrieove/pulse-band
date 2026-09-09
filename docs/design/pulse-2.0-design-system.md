# Pulse 2.0 全局设计系统规范 (Global Design System)

本文档是 Pulse 2.0 桌面应用与桌面悬浮小岛 (MiniBar) 的视觉基准规范，旨在确立可直接指导工程实现的完整设计语言。

---

## 1. 产品定位与设计定位

### 1.1 产品定义
Pulse 2.0 是一款专为 Windows 打造的消费级 **AI Agent Companion App**，其核心使命为：
1. **AI Agent 实时状态感知与周期配额管理**（Claude Code、Codex CLI、Antigravity 等）；
2. **小米手环 10 硬件协同与双向链路维系**（经典蓝牙 SPP / RFCOMM / VelaOS 同步）；
3. **高密度非侵入式桌面悬浮小岛 (MiniBar)**。

### 1.2 视觉气质参考与提炼 (Design Soul)
- **Linear**: 极致克制的边框层次 (`0.5px ~ 1px` 微弱透视)、高信息密度的键盘友好感、精密的微状态指示。
- **Raycast**: 纯正的桌面原生质感、利落的圆角曲率、极速低延迟视觉反馈。
- **Arc**: 现代轻量化侧边导航、优雅沉稳的主题系统。
- **Apple Fitness / Garmin Connect**: 专业清晰的额度环/进度条、健康设备连接态的可信感。

### 1.3 核心反模式（严禁事项 Anti-Patterns）
1. ❌ **严禁廉价 AI 紫粉渐变**：严禁采用全屏高饱和紫粉光晕（Cyberpunk/Neon），主色调回归现代科技蔚蓝 (`#0284C7` / `#38BDF8`) 与稳重金属底色。
2. ❌ **严禁把玩 Emoji 当作界面图标**：全部交互与状态图标必须统一使用描边精确的矢量图标（Lucide）。
3. ❌ **严禁虚假“静态成功”**：未连接就是未连接，认证中就是认证中，真实反映底层状态机，杜绝为了视觉效果在 UI 上制造假就绪。
4. ❌ **严禁 SaaS 仪表盘化 / 开发者后台化**：拒绝堆砌折线图、复杂表格和杂乱日志，聚焦“手环状态”与“Agent 活跃度”两个核心视点。
5. ❌ **严禁展示不可用功能入口**：表盘市场、表盘自定义导入等未完备功能不得在界面呈现不可用按钮。

---

## 2. 布局架构与三屏硬性信息流

### 2.1 整体视窗规格
- **主窗口尺寸**：宽 `920px`，高 `640px`（固定比例或自适应伸缩，最小宽度 `840px`，最小高度 `580px`）。
- **左侧导航栏 (Sidebar)**：固定宽度 `200px`，一体化贯穿左侧。
- **右侧工作区 (Content Area)**：宽度 `flex-1`，内边距 `24px`，自带轻量自适应滚动条。
- **一级导航架构**：全局仅有三个一级页面，绝对不可新增一级菜单：
  1. **概览 (Overview)**：日常状态监控与连接总控。
  2. **手环 (Band)**：手环设备管理、固件版本、配对与维护。
  3. **设置 (Settings)**：外观、Agent 识别、手环同步参数、次级高级维护。

---

## 3. 颜色系统与对比度保证

### 3.1 主题策略：Light Theme (默认) 与 Dark Theme
Pulse 2.0 默认采用 **Light Theme**。两套主题均构建在物理光照与微明暗反射模型之上：

- **Light Theme (浅色模式 - 默认)**
  - 全局底色：`#F8FAFC`（轻盈柔和的浅灰，避免纯白 `#FFFFFF` 引起的眼部眩光与视觉疲劳）；
  - 容器卡片：`#FFFFFF`，叠加 `0 1px 3px rgba(15, 23, 42, 0.08)` 的超轻量立体微阴影，配合 `1px solid rgba(15, 23, 42, 0.08)` 边框；
  - 文字阶梯：主文本 `#0F172A`（对比度 $13.5:1$）、次文本 `#475569`（对比度 $6.2:1$）、辅助文本 `#94A3B8`（对比度 $4.6:1$）。

- **Dark Theme (深色模式)**
  - 全局底色：`#0B0D13`（深邃黑夜微蓝，而非 `#000000` 纯死黑）；
  - 容器卡片：`#141824`，卡片边框采用微弱高光描边 `rgba(248, 250, 252, 0.08)`，浮动组件采用 `#1D2333`；
  - 文字阶梯：主文本 `#F8FAFC`、次文本 `#94A3B8`、辅助文本 `#64748B`。

### 3.2 语义状态色谱 (WCAG 2.1 AA 达标)
- **就绪 / 成功 (Success)**: Light `#16A34A` / Dark `#22C55E`（常用于手环已连接、数据已同步）。
- **运行中 (Working)**: Light `#0284C7` / Dark `#38BDF8`（常用于 Agent 工具调用、思考中、蓝牙握手中）。
- **警告 / 降级 (Warning)**: Light `#D97706` / Dark `#F59E0B`（常用于配额偏低、协议降级运行）。
- **危险 / 失败 (Error)**: Light `#DC2626` / Dark `#EF4444`（常用于连接断开、认证签名失效、配额耗尽）。
- **空闲 / 休眠 (Idle)**: Light `#64748B` / Dark `#64748B`（手环待机、Agent 待命）。

---

## 4. 排版与数值显示规范

### 4.1 字体栈设定
```css
--font-sans: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
```

### 4.2 数值显示强制规则 (Tabular Nums)
在所有展示**配额百分比、调用耗时、倒计时、MAC 地址、版本号**的文本标签上，必须显式启用等宽数字特性：
```css
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum";
```
确保数字在动态递增或倒计时刷新时，文字宽度保持严密对齐，杜绝界面出现字符横向抖动。

---

## 5. 交互动态与无障碍标准 (Accessibility & Motion)

1. **可交互指针标记**：所有可点击控件（按钮、卡片展开触发器、Tab 项、开关、链接）必须声明 `cursor: pointer`，并自带轻微的按下反馈（`active:scale-[0.98]`）。
2. **键盘焦点指示 (Focus Rings)**：交互组件在 `:focus-visible` 时，必须外显 `2px` 聚焦环（Light 模式为 `#0284C7`，Dark 模式为 `#38BDF8`），外偏移 `2px`。
3. **无障碍动效减弱**：
```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 6. Pre-Delivery Checklist（交付前视觉对账清单）

- [x] 一级导航仅有三个：概览、手环、设置。
- [x] 概览页首屏第一视觉中心为主连接卡片，第二视觉中心为 Agent 卡片。
- [x] Light Theme 作为默认主题，对比度全面达标 $\ge 4.5:1$。
- [x] Dark Theme 经过专业暗场校色，无死黑与刺眼渐变。
- [x] MiniBar 与主程序共享同一套设计令牌与状态流转规则。
- [x] 所有图标统一为 Lucide 矢量图标，无 Emoji 混用。
- [x] 未出现任何不可用功能（如表盘商店、表盘安装）的假按钮。
- [x] 真实反映连接链路状态，无伪造的“成功”占位。
