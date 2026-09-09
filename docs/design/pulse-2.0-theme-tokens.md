# Pulse 2.0 主题与设计令牌规范 (Theme Tokens Specification)

本文档定义 Pulse 2.0 的所有语义化设计令牌 (Semantic Tokens)，作为主窗口和桌面悬浮窗 (MiniBar) 统一的视觉变量基石。

---

## 1. 核心设计哲学 (Design Philosophy)

1. **Light Theme 为默认原语**：采用现代桌面系统（macOS / Windows 11 Fluent 2 / Linear）的明亮灰白层次，非生硬纯白，呈现高级物理纸张与细腻微边框质感。
2. **Dark Theme 独立沉淀**：基于深石板灰与冷夜黑层次递进，拒绝简单机械反色，拒绝刺眼高饱和纯黑 (`#000000`) 与廉价紫粉渐变。
3. **语义驱动 (Semantic First)**：UI 元素严格消费语义 Token，绝不直接硬编码 Hex 值。
4. **无障碍对比度 (WCAG 2.1 AA)**：正文与背景对比度保证 $\ge 4.5:1$，大标题及辅助状态 $\ge 3:1$。

---

## 2. 语义化色彩令牌对照表 (Semantic Color Tokens)

| Token 名称 | 语义用途 | Light Theme (默认) | Dark Theme | 对比度等级 |
|---|---|---|---|---|
| `--bg-app` | 应用全局最底层画布背景 | `#F8FAFC` (Slate 50) | `#0B0D13` (Deep Obsidian) | 页面基底 |
| `--bg-surface` | 主卡片、侧边栏、列表底板 | `#FFFFFF` (Pure White) | `#141824` (Midnight Slate) | 表面层级 |
| `--bg-elevated` | 悬浮卡片、下拉菜单、Popover | `#FFFFFF` (White + Shadow) | `#1D2333` (Elevated Slate) | 浮动层级 |
| `--text-primary` | 一级文本、主要标题、关键数值 | `#0F172A` (Slate 900) | `#F8FAFC` (Slate 50) | $\ge 12:1$ (AAA) |
| `--text-secondary` | 次级文本、标签名、说明文案 | `#475569` (Slate 600) | `#94A3B8` (Slate 400) | $\ge 5.8:1$ (AA) |
| `--text-muted` | 占位符、辅助时间戳、禁用文字 | `#94A3B8` (Slate 400) | `#64748B` (Slate 500) | $\ge 4.5:1$ (AA) |
| `--border-default` | 默认卡片边框、浅色分割线 | `rgba(15, 23, 42, 0.08)` | `rgba(248, 250, 252, 0.08)` | 结构分割 |
| `--border-strong` | 交互元素边框、活跃卡片边框 | `rgba(15, 23, 42, 0.16)` | `rgba(248, 250, 252, 0.18)` | 轮廓强调 |
| `--accent-primary` | 品牌重点色（科技蔚蓝，纯正现代） | `#0284C7` (Sky 600) | `#38BDF8` (Sky 400) | 交互主色 |
| `--accent-hover` | 重点色悬停态 | `#0369A1` (Sky 700) | `#0EA5E9` (Sky 500) | 反馈高亮 |
| `--status-success` | 连接成功、就绪良好 | `#16A34A` (Green 600) | `#22C55E` (Green 500) | 语义绿色 |
| `--status-working` | Agent 执行中、工具调用中 | `#0284C7` (Sky 600) | `#38BDF8` (Sky 400) | 运行青蓝 |
| `--status-warning` | 警告、重试中、协议降级 | `#D97706` (Amber 600) | `#F59E0B` (Amber 500) | 警告琥珀 |
| `--status-error` | 连接失败、服务离线、认证错误 | `#DC2626` (Red 600) | `#EF4444` (Red 500) | 危险赤红 |
| `--status-idle` | 空闲休眠、未连接、离线态 | `#64748B` (Slate 500) | `#64748B` (Slate 500) | 中性冷灰 |
| `--quota-normal` | 额度充足 ($> 20\%$) | `#16A34A` (Green 600) | `#22C55E` (Green 500) | 额度绿色 |
| `--quota-warning` | 额度紧张 ($5\% \sim 20\%$) | `#D97706` (Amber 600) | `#F59E0B` (Amber 500) | 额度橙黄 |
| `--quota-critical` | 额度耗尽 / 濒危 ($< 5\%$) | `#DC2626` (Red 600) | `#EF4444` (Red 500) | 额度赤红 |

---

## 3. Agent 专属品牌识别色 (Agent Brand Identifiers)

保持克制，仅用作 Agent 标识徽标的小面积点缀与呼吸光晕，严禁全背景大面积紫粉渐变：

| Agent | Brand Color (Light) | Brand Color (Dark) | Subdued Tint (Light) | Subdued Tint (Dark) |
|---|---|---|---|---|
| **Claude Code** | `#C2410C` (Rust Orange) | `#FB923C` (Warm Apricot) | `rgba(194, 65, 12, 0.08)` | `rgba(251, 146, 60, 0.12)` |
| **Codex CLI** | `#0F766E` (Deep Teal) | `#2DD4BF` (Bright Mint) | `rgba(15, 118, 110, 0.08)` | `rgba(45, 212, 191, 0.12)` |
| **Antigravity** | `#1D4ED8` (Royal Cobalt) | `#60A5FA` (Electric Sky) | `rgba(29, 78, 216, 0.08)` | `rgba(96, 165, 250, 0.12)` |

---

## 4. 几何、排版与视觉效果令牌 (Geometry, Typography & Effects)

### 4.1 圆角系统 (Radius Tokens)
- `--radius-xs`: `4px`（徽章、内嵌小标签、滑块指示针）
- `--radius-sm`: `6px`（辅助按钮、输入框、Tooltip）
- `--radius-md`: `10px`（主按钮、常规嵌套卡片、Tab 切换项）
- `--radius-lg`: `14px`（外层核心信息卡片、模态框）
- `--radius-xl`: `18px`（窗口主容器容器区、MiniBar 胶囊组件）
- `--radius-full`: `9999px`（药丸胶囊、状态指示圆点、开关滑块）

### 4.2 间距与尺寸栅格 (Spacing Grid)
基于 4px / 8px 律动：
- `space-1`: `4px`
- `space-2`: `8px`
- `space-3`: `12px`
- `space-4`: `16px`
- `space-5`: `20px`
- `space-6`: `24px`
- `space-8`: `32px`
- `space-10`: `40px`

### 4.3 排版阶梯 (Typography Scale)
- **字体栈**：
  - 西文与界面：`"Segoe UI Variable Display", "Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  - 代码与数字：`"Cascadia Code", "JetBrains Mono", Consolas, monospace`（所有数值与计时器强制开启 `font-variant-numeric: tabular-nums`）
- **字号与行高**：
  - `text-display`: `20px` / `28px` (Semibold, 用于大卡片关键数值或核心标题)
  - `text-lg`: `16px` / `24px` (Semibold, 页面标题、卡片主标题)
  - `text-base`: `14px` / `20px` (Medium/Regular, 主操作按钮、主要文本)
  - `text-sm`: `12px` / `16px` (Medium/Regular, 次级标签、状态描述、列表属性)
  - `text-xs`: `11px` / `14px` (Regular/Semibold, 徽章、时标、单色辅助提示)
  - `text-mono-sm`: `12px` / `16px` (Font Mono, MAC 地址、计时器、百分比)

### 4.4 阴影与微光系统 (Shadows & Elevation)
- **Light Theme**:
  - `--shadow-sm`: `0 1px 2px 0 rgba(15, 23, 42, 0.05)`
  - `--shadow-card`: `0 1px 3px 0 rgba(15, 23, 42, 0.08), 0 1px 2px -1px rgba(15, 23, 42, 0.04)`
  - `--shadow-elevated`: `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.03)`
  - `--shadow-minibar`: `0 8px 24px -4px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9)`
- **Dark Theme**:
  - `--shadow-sm`: `0 1px 2px 0 rgba(0, 0, 0, 0.3)`
  - `--shadow-card`: `0 4px 16px -2px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--border-default)`
  - `--shadow-elevated`: `0 12px 32px -4px rgba(0, 0, 0, 0.65), 0 0 0 1px var(--border-strong)`
  - `--shadow-minibar`: `0 16px 36px -10px rgba(0, 0, 0, 0.7), inset 0 1px 0.5px rgba(255, 255, 255, 0.2)`

### 4.5 图标规范 (Iconography)
- 仅使用专业矢量描边图标库（Lucide Icons），**严禁在界面组件中使用 Emoji**。
- 尺寸阶梯：
  - `icon-sm`: `14px × 14px`（辅助徽章、小型开关指示器）
  - `icon-base`: `16px × 16px`（按钮图标、表单前缀、导航栏）
  - `icon-lg`: `20px × 20px`（卡片标题前缀、状态主指示器）
  - `icon-xl`: `28px × 28px`（空状态插画指示器）
- 线宽：统一 `stroke-width: 1.75px`（高分屏与标准屏兼顾细腻感）。

### 4.6 动画与过渡时长 (Motion & Transitions)
- `--motion-instant`: `100ms cubic-bezier(0.4, 0, 0.2, 1)`（按钮按下、Toggle 开关位移）
- `--motion-fast`: `150ms cubic-bezier(0.4, 0, 0.2, 1)`（Hover 底色切换、边框高光）
- `--motion-base`: `250ms cubic-bezier(0.16, 1, 0.3, 1)`（卡片折叠/展开、页面淡入）
- `--motion-pulse`: `1.5s ease-in-out infinite`（运行呼吸灯指示圆点）
- 必须尊重系统 `@media (prefers-reduced-motion: reduce)`，在用户开启无障碍减弱动态效果时将过渡时长降为 `0ms` 并关闭无限循环动画。
