# Pulse 2.0 桌面额度悬浮窗（MiniBar）技术审计与实现文档

> 本文档记录 Pulse 2.0 桌面额度悬浮组件从设计原则、调用链架构、窗口物理几何、数学轮廓、交互状态机、数据流解析到验证套件的技术实现，供架构审查与同行技术评审。

---

## 一、系统定位与工程背景

### 1.1 演进目标
悬浮窗定位为系统级微件：
**“吸附于屏幕左右边缘的黑色竖向侧栏 + 三个 Agent 额度圆环 + 向桌面内侧展开的单项详情卡 + 可收起为边缘微胶囊标签”**。

视觉与排版目标：
- 贴边侧栏轮廓采用平滑反向凹 S 曲线切入屏幕边界，无水平顶盖与凸起鼓包。
- 详情卡紧凑排版，5 小时与 7 天双周期层级一致，取消过大字体。
- 右键菜单具备多通道关闭能力（点击外部、右键关闭、窗口失焦、Esc 键）。

### 1.2 工程纪律与范围防爆（严格遵守仓库 AGENTS.md）
- **客观记录事实**：剩余百分比为真实计算（`100 - used`），缺失额度显示 `—`，第三方官方未提供 7 天额度时标明 `官方未提供此周期额度`，缺失重置时间标明 `重置时间未知`。
- **边界隔离**：修改范围仅限悬浮窗 UI、动效、交互逻辑与主进程窗口管理；未变动 Core 核心、蓝牙底层协议、设备通信协议或额度采集服务。
- **敏感信息隔离**：经静态正则扫描，敏感词（Token、Secret、Credential、PrivateKey、MAC、DeviceAddress、install.local）不流向 Renderer，不出主进程。

---

## 二、四层架构与端到端实际调用链

```text
[Renderer 渲染层]
  MiniBar.tsx, agent-quota-utils.ts
  - 负责 UI 渲染、动效控制、右键菜单、指针事件捕获
  - 仅通过 window.codeisland 安全 IPC 桥与主进程通信
        │
        ▼ (window.codeisland)
[Preload 桥接层]
  src/preload/index.ts
  - 暴露: getMinibarState, setMinibarExpanded, setMinibarDisplayMode,
          notifyDragStart, notifyMenuOpen, onWindowBlur, closeMinibar
        │
        ▼ (ipcRenderer.send / invoke)
[Main 主进程服务层]
  src/main/minibar-window.ts, src/main/services/minibar-geometry.ts
  - 管理 BrowserWindow 物理边界、屏幕多显示器边缘吸附
  - 监听 window blur 并向渲染层分发 minibar:window-blur
  - 接收 minibar:menu-open 并聚焦窗口以支持失焦检测
  - 消费 SessionManager 与 StatusServer 并推送状态
        │
        ▼
[Core / Hardware 底层]
  pulse-core 与手环通信（本轮不涉及）
```

---

## 三、窗口物理管理与几何计算系统 (`minibar-geometry.ts`)

### 3.1 核心尺寸常量
- **收起侧栏态**：宽 `COLLAPSED_WIDTH = 80 DIP`，高 `COLLAPSED_HEIGHT = 340 DIP`
- **向桌面展开态**：宽 `EXPANDED_WIDTH = 370 DIP`，高 `EXPANDED_HEIGHT = 340 DIP`
  - 详情卡宽 264 DIP + 间距/尖角 26 DIP + 侧栏 80 DIP = 370 DIP
- **微型边缘胶囊标签态**：宽 `EDGE_TAB_WIDTH = 18 DIP`，高 `EDGE_TAB_HEIGHT = 48 DIP`

### 3.2 展开/收起屏幕贴边像素守恒
- 设收起态锚点为 $(x_0, y_0)$，窗口右边缘绝对屏幕物理坐标为 $R = x_0 + W_{\text{collapsed}}$。
- 展开时：$x_{\text{expanded}} = R - W_{\text{expanded}} = x_0 + 80 - 370 = x_0 - 290$。
- 展开态右边缘：$x_{\text{expanded}} + W_{\text{expanded}} = (x_0 - 290) + 370 = x_0 + 80 = R$。
- 贴紧屏幕边缘的一侧物理像素位移保持 $\Delta R = 0$。

---

## 四、侧栏流线轮廓与 S 曲线几何

### 4.1 几何区域划分
1. **原生窗口边界**：宽 80 DIP，高 340 DIP。
2. **黑色直线主体**：宽度固定为 **59 DIP**（垂直直线段在 $x=21$，$y \in [31, 309]$）。
3. **中心线**：
   - **右吸附**：黑色主体容器位于 $x \in [21, 80]$（`left-[21px]`，宽 59 DIP），中心线在 $x = 21 + 59/2 = 50.5\text{ DIP}$。
   - **左吸附**：黑色主体容器位于 $x \in [0, 59]$（`left-0`，宽 59 DIP），中心线在 $x = 0 + 59/2 = 29.5\text{ DIP}$。
   - 三个圆环中心、百分比中心、周期标签中心均基于该容器水平居中，严格共线。

### 4.2 S 曲线切线连续性（Cubic Bezier Ogee Curve）

根据用户通过调校台视觉拟合确定的路径参数：
- **右吸附路径**：
  - 完整闭合：`M 80,0 C 80,18 21,-9 21,31 L 21,309 C 21,349 80,322 80,340 Z`
- **左吸附路径**（镜像）：
  - 完整闭合：`M 0,0 C 0,18 59,-9 59,31 L 59,309 C 59,349 0,322 0,340 Z`

---

## 五、交互与右键菜单关闭机制

### 5.1 右键菜单关闭通道
1. **窗口失焦 (Blur)**：主进程 `minibarWin.on('blur')` 派发 `minibar:window-blur`，渲染层订阅并关闭菜单。
2. **指针捕获阶段拦截 (Pointerdown Capture)**：
   - 监听 `pointerdown` 事件，`capture: true`；
   - 若点击目标不属于 `.minibar-context-menu`，立即调用 `closeContextMenu()`；
   - 若为右键点击（`e.button === 2`），执行 `preventDefault()` 与 `stopPropagation()`，阻断同一次点击原地重新弹出新菜单。
3. **焦点管理**：在 `handleContextMenu` 显式打开菜单时调用 `window.codeisland.notifyMenuOpen()`（触发 `minibarWin.focus()`），普通悬停不调用 `focus()`，避免打扰用户前台应用。
4. **键盘 Esc 键**：按下 Esc 优先关闭菜单，不影响卡片固定状态（Pin）。
5. **滑块与菜单项交互**：透明度滑块与各选项均位于 `.minibar-context-menu` 内，交互时不会误触发关闭。

---

## 六、详情卡排版与字号规范

- **卡片整体尺寸**：宽 264 DIP，高 246 DIP（垂直位置 `top-[47px]`，与中间圆环中心 $y=170$ 居中对齐）。
- **字体层级（5h 与 7d 统一规范）**：
  - 标题（Agent 名称）：15 DIP，字重 500。
  - 周期名称：12 DIP，字重 400，颜色 `white/50`。
  - 剩余百分比：20 DIP，字重 500，`tabular-nums`，紧凑间距。
  - 相对倒计时：13 DIP，字重 400，`tabular-nums`，颜色 `white/80`。
  - 进度条：统一 3px 高度，圆角饱满。
  - 绝对重置时间：12 DIP，字重 400，`tabular-nums`，颜色 `white/40`，独立单行靠右。

---

## 七、质量验证记录

```bash
1. node --test scripts/test-minibar-layout.mjs # [PASS] 11 项断言全部通过
2. npm test                                    # [PASS] 99 项全量测试全部通过
3. npm run build                               # [PASS] TypeScript + Vite 编译通过
4. 敏感词扫描                                   # [PASS] 无凭证与敏感字段泄露
```

### 当前状态说明
- 单元测试与构建已在当前 Node 20 / Electron 33 环境下验证。
- 实际 GUI 运行效果与多屏拖动交互仍需启动应用在目标 Windows 环境下人工核验。
