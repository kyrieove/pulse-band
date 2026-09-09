# Pulse 2.0 组件设计规范 (Component Specifications)

本文档详细定义 Pulse 2.0 包含的 17 项核心 UI 组件的尺寸、间距、排版、状态流转、微交互以及在 Light 与 Dark 主题下的具体实现表现。

---

## 1. 核心状态机模型 (Core State Machines)

### 1.1 手环连接状态规范 (Connection State Machine)

手环连接卡片及指示器必须严格按以下 7 态状态机渲染，严禁任何假成功状态：

| 状态 Key | 状态中文名 | 状态指示 Icon | 语义色彩 | Spinner | 主按钮文案与动作 | 状态说明文案 |
|---|---|---|---|---|---|---|
| `idle` | 未连接 | `BluetoothOff` | `--status-idle` | 否 | “连接手环” (Primary) | “手环处于待机离线状态，点击开始建立连接” |
| `starting` | 启动服务中 | `Loader2` | `--status-working` | 是 (匀速旋转) | “取消” (Secondary) | “正在拉起底层后台设备服务进程…” |
| `searching` | 查找手环中 | `Radio` | `--status-working` | 是 (脉冲呼吸) | “取消” (Secondary) | “正在扫描并寻找小米手环 10 蓝牙广播…” |
| `connecting` | 建立连接中 | `RefreshCw` | `--status-working` | 是 (匀速旋转) | “取消” (Secondary) | “正在通过 RFCOMM 串口通道握手…” |
| `authenticating` | 验证身份中 | `KeyRound` | `--status-working` | 是 (缓动旋转) | “取消” (Secondary) | “正在校验 AuthKey 安全签名与会话凭据…” |
| `connected` | 已连接 | `CheckCircle2` | `--status-success` | 否 | “断开连接” (Secondary/Ghost) | “已与小米手环 10 建立双向安全加密通信链路” |
| `error` | 连接异常 | `AlertCircle` | `--status-error` | 否 | “重新连接” (Primary) | 动态解析错误：“AuthKey 失效” 或 “信道被占用，请连接新手机” |

---

## 2. 核心组件逐项规范 (17 项)

### 2.1 Sidebar (侧边导航栏)
- **用途**：应用全局主导航（仅有一级导航：概览、手环、设置）与底部悬浮窗快捷开关。
- **视觉层级**：基础结构层，垂直铺满视窗左侧。
- **尺寸**：固定宽度 `200px`，高度 `100%`。
- **Spacing**：外边距 `p-3 (12px)`，导航项之间 `gap-1.5 (6px)`。
- **Typography**：
  - 分组标题：“功能导航” `text-xs (11px)`，Bold，Uppercase，Tracking-wider。
  - 导航项目：`text-sm (13px)`，Medium。
- **状态行为**：
  - Default: 文字 `--text-secondary`，无背景。
  - Hover: 背景 `--bg-app`，文字 `--text-primary`，过渡 `150ms`。
  - Active (选中态): 背景 `--bg-elevated`，文字 `--accent-primary`，边框 `1px solid var(--border-strong)`，阴影 `--shadow-sm`，右侧带活跃高光点。
  - Focus: 键盘可聚焦，高亮 focus ring。
- **Light / Dark 差异**：
  - Light: 背景 `#FFFFFF`，右边框 `1px solid rgba(15, 23, 42, 0.08)`。
  - Dark: 背景 `#10131B`，右边框 `1px solid rgba(248, 250, 252, 0.08)`。

---

### 2.2 TopBar / TitleBar (自绘标题栏)
- **用途**：Windows 无边框窗口控制、窗体拖拽区（`-webkit-app-region: drag`）、主副标题呈现、窗口三联控制按钮。
- **视觉层级**：顶部吸顶，高度 `40px`。
- **尺寸**：宽度 `100%`，高度 `40px`，内边距 `px-4 (16px)`。
- **Spacing**：图标与主标题间距 `8px`，主副标题间距 `6px`。
- **Typography**：
  - 应用主名：“Pulse” `text-sm (13px)`，Semibold，`--text-primary`。
  - 当前副标题：`text-xs (11px)`，Regular，`--text-muted`。
- **状态行为**：
  - 窗口最小化/最大化/关闭按钮为 `no-drag`。
  - 关闭按钮 Hover 变为赤红 `--status-error`，文字转纯白。
- **Light / Dark 差异**：
  - Light: 底色 `#FFFFFF`，底部边框 `1px solid rgba(15, 23, 42, 0.06)`。
  - Dark: 底色 `#10131B`，底部边框 `1px solid rgba(248, 250, 252, 0.06)`。

---

### 2.3 BandConnectionCard (手环连接核心卡片)
- **用途**：概览页第一视觉中心，统领手环连接生命周期与主操作。
- **视觉层级**：一级主卡片，极高的视觉显著度。
- **尺寸**：宽度 `100%`，内边距 `p-5 (20px)`，圆角 `--radius-lg (14px)`。
- **Spacing**：上下两层结构，头部高度 `36px`，主内容间距 `16px`。
- **Typography**：
  - 设备名称：“Xiaomi Smart Band 10” `text-lg (16px)`，Semibold。
  - 状态文案：`text-sm (13px)`，Medium。
  - 技术细节（MAC / 协议）：`text-mono-sm (11px)`，`--text-muted`。
- **状态表现**：
  - Idle: 柔和冷灰边框，中性徽章，Primary 按钮“连接手环”。
  - Connecting / Authenticating: 柔和海蓝边框，带微弱脉冲光晕，内嵌 `ConnectionProgress`，按钮置为“取消”。
  - Connected: 柔和翠绿边框，StatusBadge 显“已连接”，展示同步状态与断开按钮。
  - Error: 柔和赤红警示边框，展示错误说明卡片与“重试”按钮。
- **Light / Dark 差异**：
  - Light: 底色 `#FFFFFF`，阴影 `--shadow-card`。
  - Dark: 底色 `#141824`，卡片外圈带 `0 0 0 1px var(--border-default)`。

---

### 2.4 ConnectionProgress (连接阶段多步反馈指示条)
- **用途**：在连接发起时直观分步展示当前所处的握手阶段，消解用户等待焦虑。
- **视觉层级**：嵌于 `BandConnectionCard` 内部的二级动效组件。
- **尺寸**：高度 `28px`，宽度 `100%`，圆角 `--radius-full`。
- **Spacing**：步骤圆点间距 `12px`，连接线高度 `2px`。
- **Typography**：步骤标签 `text-xs (11px)`，Mono，Tabular-nums。
- **状态流转**：
  - 节点状态：`Pending`（虚线灰点）➔ `Current`（高亮脉冲并带 Spinner）➔ `Completed`（实心翠绿勾号）。
- **Light / Dark 差异**：
  - Light: 进度槽底色 `#F1F5F9`，高光线 `#0284C7`。
  - Dark: 进度槽底色 `#1D2333`，高光线 `#38BDF8`。

---

### 2.5 AgentCard (AI Agent 监控卡片 - 默认态)
- **用途**：概览页第二核心视觉区，监视已检测到的本地 Agent（Claude Code、Codex CLI、Antigravity）。
- **视觉层级**：核心数据卡片。
- **尺寸**：宽度 `100%`，内边距 `p-4 (16px)`，圆角 `--radius-md (10px)`。
- **Spacing**：头部左右对齐，主体展示剩余额度环与重置时间，间距 `12px`。
- **Typography**：
  - Agent 名称：`text-base (14px)`，Semibold。
  - 核心配额百分比：`text-display (20px)`，Bold，Tabular-nums。
  - 次级信息与重置倒计时：`text-xs (11px)`，Medium，`--text-secondary`。
- **5 种状态设计**：
  1. **Idle (就绪待命)**：状态点常灰，显示上次会话时间与剩余额度。
  2. **Running (执行中)**：状态点海蓝呼吸闪烁，标明正在调用的工具名（如 `Bash: npm test`），数字计时器动态递增（如 `01:42s`）。
  3. **Quota Warning (额度紧张 $\le 20\%$)**：额度条和标签转为琥珀色警告色。
  4. **Quota Critical (额度濒危 $\le 5\%$)**：额度条和标签转为赤红色，附带重置时间高亮提示。
  5. **Expanded (展开态)**：触发展开至 `AgentCardExpanded`。
- **Light / Dark 差异**：
  - Light: 底色 `#FFFFFF`，Hover 产生柔和升起感 `--shadow-card`。
  - Dark: 底色 `#161B28`，Hover 产生边缘微光描边。

---

### 2.6 AgentCardExpanded (AI Agent 监控卡片 - 展开态)
- **用途**：点击 AgentCard 触发，展开展示深度技术指标。
- **视觉层级**：展开抽屉/详情区，嵌入在卡片内。
- **尺寸**：高度平滑过渡（`max-h-[280px]`），内边距 `pt-3 mt-3`，由一条细腻微虚线分隔。
- **Spacing**：指标网格 `grid grid-cols-3 gap-3`。
- **Typography**：
  - 周期指标项标签：`text-xs (11px)`，`--text-muted`。
  - 指标真实数值：`text-sm (13px)`，Bold，Tabular-nums。
- **包含数据**：5 小时滑动窗口 Token 用量、今日总调用量、最近一次数据推送到手环的时间戳、Hook 注入状态。
- **Light / Dark 差异**：
  - Light: 展开底板采用 `#F8FAFC`，增强层级落差。
  - Dark: 展开底板采用 `#121622`。

---

### 2.7 StatusBadge (语义状态徽章)
- **用途**：用于全局各种设备、网络、Agent 状态的紧凑标签。
- **视觉层级**：原子组件。
- **尺寸**：高度 `22px`，内边距 `px-2.5 py-0.5`，圆角 `--radius-full`。
- **Spacing**：内嵌圆点与文字间距 `5px`。
- **Typography**：`text-xs (11px)`，Semibold，Tracking-tight。
- **色彩映射**：
  - Success: 浅绿色背景 (`10% alpha`) + 深绿色文字 + 翠绿点。
  - Working: 浅青色背景 (`10% alpha`) + 深青色文字 + 呼吸青点。
  - Warning: 浅橙色背景 (`10% alpha`) + 深橙色文字 + 琥珀点。
  - Error: 浅红色背景 (`10% alpha`) + 深红色文字 + 赤红点。
  - Neutral/Idle: 浅灰背景 (`10% alpha`) + 灰文字 + 冷灰点。

---

### 2.8 QuotaIndicator (专业配额进度条)
- **用途**：可视化展示 Agent 5 小时周期配额消耗情况。
- **视觉层级**：数据可视化原子组件。
- **尺寸**：条形高度 `6px`，宽度 `100%`，圆角 `--radius-full`。
- **Spacing**：上方数值与条形间距 `6px`。
- **表现逻辑**：
  - 剩余 $> 20\%$: 填充条采用 `--quota-normal`。
  - 剩余 $5\% \sim 20\%$: 填充条采用 `--quota-warning`。
  - 剩余 $< 5\%$: 填充条采用 `--quota-critical`。
  - 动画：宽度变化遵循 `--motion-base (250ms cubic-bezier)` 缓动。

---

### 2.9 PrimaryButton (主要操作按钮)
- **用途**：核心引导操作（如“连接手环”、“重新连接”）。
- **视觉层级**：高权重按钮。
- **尺寸**：高度 `36px`，内边距 `px-4 (16px)`，圆角 `--radius-md (10px)`。
- **Typography**：`text-sm (13px)`，Semibold。
- **状态行为**：
  - Default: 背景 `--accent-primary`，文字纯白。
  - Hover: 背景 `--accent-hover`，过渡 `150ms`。
  - Active: 微缩放 `scale(0.98)`。
  - Disabled: 不透明度 `40%`，`cursor: not-allowed`。
  - Loading: 内嵌 `Loader2` 居中匀速旋转，隐藏文字或伴随“处理中…”。
- **Light / Dark 差异**：
  - Light: 采用深湛蔚蓝 `#0284C7`。
  - Dark: 采用科技高亮天蓝 `#38BDF8`，文字采用黑夜背景色 `#0B0D13`（保证极高对比度）。

---

### 2.10 SecondaryButton (次要操作按钮)
- **用途**：辅助操作（如“断开连接”、“取消”、“刷新”、“复制脱敏日志”）。
- **视觉层级**：中/低权重按钮。
- **尺寸**：高度 `36px`，内边距 `px-3.5 (14px)`，圆角 `--radius-md (10px)`。
- **Typography**：`text-sm (13px)`，Medium，`--text-primary`。
- **状态行为**：
  - Default: 背景透明，边框 `1px solid var(--border-strong)`。
  - Hover: 背景 `--bg-app`，边框颜色加深。
  - Active: `scale(0.98)`。
  - Disabled: 置灰。

---

### 2.11 SettingsGroup (设置项分组卡片)
- **用途**：设置页中的配置组容器（外观、Agent、手环同步、高级维护）。
- **视觉层级**：容器卡片。
- **尺寸**：宽度 `100%`，圆角 `--radius-lg (14px)`，内边距 `p-4 (16px)`。
- **Spacing**：内部各配置行之间 `divide-y divide-border-default`，单行高度 `48px`。
- **Typography**：分组标题 `text-sm (13px)`，Bold，Uppercase，`--text-muted`。
- **层级区分**：
  - “外观”、“Agent”、“手环同步”为常规权重；
  - “高级维护”卡片放在页面最底部，背景更为收敛，边框更淡，避免抢夺日常设置焦点。

---

### 2.12 Toggle (现代平滑开关)
- **用途**：二元状态切换（如悬浮窗开关、Agent 监控显示开关）。
- **视觉层级**：输入微控件。
- **尺寸**：底座槽 `36px × 20px`，滑块圆核 `16px × 16px`。
- **Spacing**：内边距 `2px`。
- **状态行为**：
  - Off: 底座背景为中性冷灰，圆核居左。
  - On: 底座背景变为 `--accent-primary`，圆核平滑滑移至右侧，耗时 `150ms cubic-bezier(0.4, 0, 0.2, 1)`。

---

### 2.13 EmptyState (优雅空状态)
- **用途**：未检测到任何可用 Agent、未配对手环时的引导界面。
- **视觉层级**：工作区中央占位。
- **尺寸**：内边距 `py-12 px-6`，居中对齐。
- **组件结构**：
  - 顶部微弱圆底图标容器（`44px × 44px`，无刺眼渐变）。
  - 核心引导标题：`text-sm (14px)`，Semibold。
  - 步骤说明文案：`text-xs (12px)`，`--text-secondary`，限制最大宽度 `360px`。
  - 动作 CTA 按钮（如“前往手环设置”、“重新扫描 Agent”）。

---

### 2.14 ErrorState (错误处理容器)
- **用途**：通信中断、Token 失效、蓝牙硬件未就绪时的容灾展示。
- **视觉层级**：警示反馈。
- **尺寸**：内边距 `p-3.5 (14px)`，圆角 `--radius-md (10px)`。
- **设计规范**：
  - 底色：`rgba(239, 68, 68, 0.08)`（柔和微红）。
  - 边框：`1px solid rgba(239, 68, 68, 0.25)`。
  - 左侧：`AlertCircle` 矢量警告图标。
  - 内容：清晰指引物理排查步骤（例如提示“请在手环上点击‘连接新手机’”），提供“重试”或“复制排查报告”快捷按钮。

---

### 2.15 CollapsibleAdvancedSection (可折叠高级操作区)
- **用途**：收纳“推送其他快应用”、底层蓝牙串口调试等专家功能，防止干扰普通用户。
- **视觉层级**：**默认必须强制折叠**，视觉权重极低。
- **尺寸**：宽度 `100%`，圆角 `--radius-md (10px)`。
- **交互规范**：
  - 折叠触发条：左侧为标题“高级工具与快应用管理”，右侧为 `ChevronDown` 图标（展开时平滑顺时针旋转 180 度）。
  - 展开内容：平滑推开，背景微暗，展示快应用 `.rpk` 投放区与手动调试工具，绝不成为页面第一眼视觉。

---

### 2.16 MiniBar (桌面迷你悬浮小岛)
- **用途**：置顶于 Windows 桌面的非侵入式极简悬浮胶囊，无需切换窗口即可掌握活跃状态。
- **视觉层级**：Windows 顶层透明穿透窗口。
- **尺寸**：
  - 折叠态标准尺寸：`320px × 36px`，极致圆角 `--radius-full`。
- **Spacing**：内边距 `px-3 (12px)`，元素间距 `8px`。
- **交互规范**：
  - 单击或双击：呼出并置顶 Pulse 2.0 主界面（默认打开概览页）。
  - 支持桌面边缘微吸附。
- **Light / Dark 差异**：
  - Light MiniBar: 超细白磨砂玻璃 `rgba(255, 255, 255, 0.85)`，`backdrop-filter: blur(20px)`，边缘为 `1px solid rgba(15, 23, 42, 0.12)`，高质感漫反射阴影。
  - Dark MiniBar: 暮黑磨砂玻璃 `rgba(18, 22, 32, 0.78)`，`backdrop-filter: blur(24px)`，边缘带上高光发丝。

---

### 2.17 MiniBarAgentItem (MiniBar 内部单体项目)
- **用途**：在 MiniBar 内部呈现单项已启用 Agent 的极简状态。
- **视觉层级**：紧凑单行原子项。
- **尺寸**：最大宽度 `110px`，单行高度 `24px`。
- **显示元素**：
  - Agent 极简缩写标（如 `Cl`、`Cx`、`Ag`）；
  - 活跃指示灯（运行中蓝色闪烁、待机灰点）；
  - 剩余额度紧凑百分比（如 `84%`，Tabular-nums）；
  - 若正在执行任务，展示计时器（如 `12s`）或截断的工具名。
