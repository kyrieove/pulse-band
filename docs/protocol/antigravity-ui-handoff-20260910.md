# 交接：Pulse 2.0 桌面端 —— 真实 Logo 接入 + 首次配置向导重构

交接日期：2026-09-10
基线提交：`a605b41`（分支 `main`）
交接范围：**任务 A 真实 Logo**、**任务 B 首次配置向导 7 步 → 4 步**
明确不在范围：断线重连行为（已决定保持现状）

---

你是接手本仓库的开发者。**先读 `AGENTS.md`（14 条工程纪律），本任务全程受它约束。** 违反纪律的提交一律不接受。

## 0. 环境与基线（事实，请自行核对）

- 仓库：`C:\dev\pulse-band2`，分支 `main`，当前 HEAD 应为 `a605b41`。先跑 `git log --oneline -3` 确认。
- 构建：`npm run build`（tsc + vite）。测试：`npm test`、`cargo test --all`（在 `core/` 下执行）、`git diff --check`。
- 工作区有一个**未跟踪**目录 `OronBox-Plugin-MiWear-InterconnectFetch/`（逆向参考源码）——**不要 `git add` 它**。
- 不要新建第二套状态管理、第二套 IPC、第二套轮询、第二套安装管线。一律复用已有能力。
- **禁止修改**：`core/src/live.rs`、`core/src/session.rs`、`core/src/rfcomm.rs`、`core/src/install/xiaomi/*`
  （真实设备安装链路已真机跑通，见 `docs/protocol/install-runtime-audit-20260910.md` 第 11 节）。

---

## 任务 A：三个 Agent 使用真实 Logo

### 现状（已核实，不要重新猜）

- 概览卡片与悬浮窗目前用的是统一的 `lucide-react` 图标（`Activity`），不是各产品 Logo。
- 项目内**已存在**三个独立图标（尺寸已实测）：

| 文件 | 尺寸 | 实测情况 |
|---|---|---|
| `band-app/src/common/agent-claude.png` | 24×24 | Anthropic 星芒标，橙色，配色正确 |
| `band-app/src/common/agent-codex.png` | 48×48 | OpenAI 花结标，**纯白色**，浅色主题下不可见 |
| `band-app/src/common/agent-antigravity.png` | 32×32 | 渐变拱形，**是否官方原版未核实** |

- 手环端使用它们时**没有任何 CSS filter/tint**（`band-app/src/pages/index/index.ux` 直接 `<image src=...>`），
  说明颜色已烙在图片里；用户也提示过手环端图标"部分经过改色和合成"，不适合直接充当桌面高清 Logo。
- 项目内**没有更高分辨率版本**（已用 `find` 全量确认过全仓库图片资源）。

### 要求

1. **来源优先级**：先项目内资源 → 再去**官方来源**获取。本任务**允许联网**。
2. 联网获取时的硬性要求：
   - 只取**厂商官方**品牌资源（厂商官网 / 官方品牌页 / 官方 press kit / 官方仓库），
     **不要**用第三方图库、图标聚合站、AI 生成图或社区重绘版。
   - 保留原始配色与宽高比，**不得**改色、加描边、加背景、做合成。
   - **记录每个资源的来源 URL 与获取日期**，写进交付报告；无法追溯到官方来源的一律标注"未核实"
     并退回使用项目内资源，不要使用来源不明的图。
   - 资源**本地打包**（放入项目静态资源目录，经 vite 打包），不引用外链。
3. 分辨率：桌面端当前渲染尺寸是 32×32 容器（`src/renderer/components/pulse/AgentCard.tsx` 头部）。
   优先使用 SVG 或 ≥128px 的 PNG，避免用 24×24 放大导致模糊。
   **禁止**用小图拉伸冒充高清。
4. **Codex 的纯白色图标在浅色主题下不可见——这是必须处理的真实问题。**
   先核实它是否真的全白（读像素验证），然后选一条并说明理由：
   - 按主题分别使用对应版本（深色主题用白色版本、浅色主题用深色/品牌色版本）；或
   - 使用单色遮罩 + 品牌色着色（品牌色可参考 `src/renderer/components/pulse/QuotaCards.tsx`
     里已有的 per-agent 色值表）。
   **禁止**不处理直接放上去（会看不见），也禁止自己"画"一个近似标冒充原版。
5. Antigravity 的图标必须给出核实结论与依据（官方来源 URL）。无法核实就写"未核实"，
   **不要**声称已确认为官方原版。
6. 若某产品的官方资源确实拿不到或不可用，**如实报告并保持该产品现状**，不要伪造、不要用近似图顶替。
7. 这三个标识是第三方商标，仅用于标识对应产品。**不得修改图形本身**（含改色、变形、加特效）。

---

## 任务 B：首次配置向导 7 步 → 4 步

### 现状（已核实，动手前请自行复核一遍）

步骤定义在 `src/renderer/components/setup/types.ts` 的 `INITIAL_SETUP_STEPS`，共 **7 步**：
`prepare`、`import_log`、`save_credentials`、`windows_pairing`、`rfcomm_auth`、`install_app`、`verify_quota`。

各步骤实现的真实 IPC 调用数（`grep -c 'window.pulse'`）：

| 文件 | 行数 | `window.pulse` 调用数 |
|---|---|---|
| `LogImportStep.tsx` | 154 | **0** |
| `CredentialSaveStep.tsx` | 137 | **0** |
| `WindowsPairingStep.tsx` | 158 | **0** |
| `RfcommAuthStep.tsx` | 158 | **0** |
| `InstallAppStep.tsx` | 172 | 3（已实现一键安装） |
| `VerifyQuotaStep.tsx` | 137 | **0** |

即：**7 步里有 5 步是纯占位空壳**。这不是"重排界面"的任务，而是**把空壳接上真实能力**。

### ⚠️ 必须先确认的硬缺口（本任务的关键风险）

**项目里没有任何代码写 `%LOCALAPPDATA%\PulseDev\run\device.json`。** 已核实：

- 该文件只被**读取/判断存在**：`src/main/services/oronbox-client.ts:167`（`fs.existsSync`）、
  `core/src/live.rs::read_device_auth_mac()`。
- pulse-core **连接手环时必须**从它读取，格式契约如下（`core/src/live.rs` 逐字校验）：

```json
{ "authkey": "<32 位 hex>", "addr": "<手环 MAC>" }
```

  - `authkey` 必须正好 32 个 hex 字符；
  - `addr` 会被过滤出非 hex 字符，要求恰好 12 个 hex 字符。
- 日志解析器 `src/main/services/band-key-parse.ts` **只产出 deviceKey / encryptKey，不产出 MAC**。
- 项目里也**没有任何获取手环 MAC 的能力**：`core --probe`（`core/src/rfcomm.rs:70`）
  自身**也依赖 device.json 已存在**。

**因此**：只做"导入日志"无法产出一个可用的连接配置。你必须在报告中明确回答：
**手环 MAC 从哪里来？写 device.json 由谁负责？** 并且：

- 如果现有输入（日志文件内容 / Windows 已配对蓝牙设备 / 系统蓝牙 API）里**确实能拿到** MAC，
  先给出可核验证据（具体字段名、或可复现的命令与真实输出），再实现；
- 如果拿不到，**必须先停下并明确指出这个缺口**，不要用假 MAC、不要让用户手填一个未经校验的值、
  不要假装步骤已完成。
- 若需要新增能力（例如枚举 Windows 已配对蓝牙设备），**先说明该能力当前的状态与实现路径**，
  并遵守 `AGENTS.md` 第 4 条四层架构边界（Renderer 不直接碰系统 API，须经 Main）。

### 目标流程（固定 4 步）

```
导入手机日志 → 连接手环 → 安装快应用 → 验证额度
```

**第 1 步 导入手机日志**：用户选择/拖入日志，后台完成密钥提取、校验与保存（即写出上面那份 device.json）。

- 提供简短的"去哪儿拿日志"帮助。
- **不向 Renderer 暴露密钥**。现有 `band:extract-key` 的返回值里含有密钥；
  若向导不需要这些值，就不要传过去；确需传递时按 `AGENTS.md` 第 10 条做敏感词扫描
  （`token` / `secret` / `credential` / `privateKey` / `mac` / `deviceAddress`）。
- 提取与保存**真实成功**后才能进入下一步。
- 已有有效配置时允许直接复用，不强制重做。

**第 2 步 连接手环**：用户点「连接手环」，后台完成 Windows 配对 + RFCOMM 连接 + 认证，
**不拆成独立步骤**。

- 复用 `window.pulse.connectBand()`（`src/preload/index.ts`，真实链路）。
- 提示文案："如电脑或手环出现配对请求，请按提示确认"，**不要假定每次都会弹窗**。
- 以 core 上报的**真实就绪状态**判断成功（`onOronboxState` 的 `connection.state === 'connected'`
  且 `protocolState === 'ready'`）；**不得**用本地计时器或乐观状态冒充。
- 失败可原地重试，不丢失第 1 步成果。

**第 3 步 安装快应用**：默认安装随程序发布的 Pulse RPK，**一键**完成。

- 复用已有：`window.pulse.appInstall.getBundledInfo()` / `installBundled()`
  （主进程 `src/main/services/app-install-service.ts`）。
- 不要求普通用户填写包名/版本号，不要求另找安装包。
- 传输结束但设备尚未返回结果时，显示「**正在确认安装结果**」。
- **只有 core 返回 `coreStatus === 'completed'` 才算安装成功**（该字段来自设备真实上报的
  `type=20 id=2` + 已安装列表核验）。**不得**用 `status`、进度 100% 或计时器冒充成功。
- 已真实确认安装当前版本时，可直接继续；失败原地重试，不重走前两步。

**第 4 步 验证额度**：

- 提示用户在手环上打开 Pulse，确认额度显示。
- **分开判断**"电脑是否取到额度"与"手环是否完成同步"，不要合并成一个结论。
- 没有设备回执能力时可以用**用户确认**，但必须标明"由用户确认"，不能冒充设备回执。
- 暂无额度源时允许「稍后验证」，保留已有配置与安装成果；
  **稍后验证不得标记为验证成功**，之后可以继续验证。
- 数据来源可复用 `window.codeisland.getMinibarState()`（含 `quotas`，
  键为 `claude` / `codex` / `antigravity`）或 `window.pulse.getDiagnostics()`。

**首次打开与恢复**：

- 主窗口读完配置后，只在**无可用配置**时提示「开始配置 / 稍后配置」。
- 已配置但暂时断线，只提示连接，**不要求重走向导**。
- MiniBar 不弹配置向导，也不依赖向导才能使用。
- 后续步骤依赖真实前置条件，不能任意跳过。
- 返回 / 关闭 / 重新打开保留已完成成果；点「配置手环」**不立即删除已有配置**。

---

## 明确不在本任务范围（不要动）

- **断线重连行为**：产品已决定保持现状（用户主动断开 → 不自动重连；
  已连接时意外断线 → 最多自动重试 3 次、间隔 3 秒）。
  **不要**新增"手动/自动"选项，**不要**改 `core/src/live.rs` 的重连逻辑。
- `core/src/session.rs:179` 的 companion 名 `"OronBox"`（冻结文件，改动需重做真机认证验收）。
- 已完成的这几项（均已实机验证，不要回退）：额度悬浮窗入口与位置夹取、双周期（5h/7d）额度展示、
  「推送其他快应用」常驻安装区。

---

## 验证要求（逐项执行，并贴出真实输出）

1. `npm test`、`npm run build`、`cargo test --all`（在 `core/`）、`git diff --check` —— 全部通过。
2. **实机 UI 验证**：用 CDP 驱动真实运行的 Pulse Dev，不要只看构建通过。
   - `npm run build` 后启动：`./node_modules/.bin/electron.cmd . --remote-debugging-port=9333`
   - **坑 1**：`src/main/index.ts` 有 `app.requestSingleInstanceLock()`。若已有实例在跑，
     新实例会立刻退出、9333 不监听（启动日志为空，很难察觉）。此时加
     `--user-data-dir="<临时目录>"` 启动（Electron 单实例锁按 user-data-dir 划分）。
   - **坑 2**：生产构建加载 `file://` 静态资源，**没有 HMR**。改完代码必须
     **重新 `npm run build` 并对窗口执行 `Page.reload`（ignoreCache）**，否则测的是旧 bundle。
   - **坑 3**：悬浮窗的 `isExpanded` 是 main 进程状态，重载渲染层不会复位，测试时要显式切换。
   - Target 定位：`http://127.0.0.1:9333/json/list`，主窗口 URL 含 `?screen=main`、
     悬浮窗含 `?screen=minibar`。
   - **窗口隐藏时 target 依然存在**，不能用 target 列表判断显隐；
     要读 `await window.pulse.isMiniBarVisible()`。
   - `Toggle` 组件（`src/renderer/components/pulse/ui.tsx`）渲染为
     `<input type=checkbox class="sr-only">`，CDP 里 `.click()` 可切换。
   - 截图存 `debug-window-*.png`（该模式已被 `.gitignore` 覆盖）。
   - 验证完**只清理你自己启动的实例**（按命令行里你自己的 user-data-dir 过滤），
     **不要**杀用户正在运行的实例。
3. 四步向导必须**按真实结果**验证，不能只看界面能点：
   密钥提取真实成功、连接拿到真实的 `ready`、安装拿到 `coreStatus === 'completed'`、
   额度验证区分"用户确认"与"设备回执"。

---

## 交付报告格式（缺项视为未完成）

1. **真实调用链**，逐层标注 `implemented / mock / missing / unknown`。
2. **修改文件清单**，逐项说明改了什么、为什么。
3. **四分类**：Implemented / Mock-Placeholder / Not implemented / Next step。
   **禁止**使用"完成安装能力""完成连接能力""完成闭环"这类扩大性描述。
4. **提交前五问**：①是否连接真实设备 ②是否调用真实 Core ③是否存在 Mock
   ④哪些状态仍只是占位 ⑤下一阶段缺什么。
5. **验证结果分三类**：代码检查 / 自动化测试 / 实机验证。
   **实机验证没做就写没做**，不得用构建通过代替功能完成。
6. **缺口清单**：特别是"手环 MAC 从哪来""device.json 由谁写"的结论与依据。
7. **敏感词扫描结果**（`token` / `secret` / `credential` / `privateKey` / `mac` /
   `deviceAddress` / `install.local`）。
8. 资源来源清单（任务 A）：每个 Logo 的来源 URL、获取日期、是否官方、核实结论。
9. 提交信息用 `feat(renderer): ...` / `fix(setup): ...` 风格。
   **只提交到自己分支或本地，不要 push**，等用户确认。

---

## 参考提交链（不要回退这些改动）

```text
a605b41 chore(main): drop the no-op auto_reconnect setting call
f49111f feat(renderer): show 5h and 7d quota periods together
a93c612 feat(renderer): restore floating quota window entry and real RPK install area
5d5336e docs(protocol): record successful real-device RPK install
```

安装协议背景见 `docs/protocol/install-runtime-audit-20260910.md`（第 9–11 节为真机实测记录）。
