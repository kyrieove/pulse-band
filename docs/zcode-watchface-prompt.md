# zcode 执行提示词 —— 表盘（Watch Face）板块接入客户端

> 用法：先在终端执行分支命令，再把「======」之间的全部内容整体贴给 zcode。

```bash
git checkout -b feat/watchface-ui
```

======

## 背景与角色

仓库 `C:\dev\pulse-band2`（Rust core + Electron 主进程 + React 渲染层 + 快应用手环端）。
小米手环 10 的**表盘能力在 Rust core 侧已经做完并真机验证过**（commit `8ed4695`，device-verified 3/3）。
现在缺的是上层三段：**主进程 service → preload 暴露 → 渲染层页面**。你的任务就是把这三段接上，并在侧边栏加一个「表盘」页。

你在分支 `feat/watchface-ui` 上工作。**main 分支上有另一个 agent 正在并行改 UI，不要切回 main，不要 rebase，不要动下面「禁区」里的文件。**

## 禁区（碰了就是冲突，一律不要改）

- `src/renderer/components/setup/SetupWizard.tsx`
- `src/renderer/components/minibar/MiniBar.tsx`
- `src/renderer/components/pulse/`下的 `OverviewPage.tsx` / `AgentCard.tsx` / `AgentSection.tsx` / `SettingsPage.tsx` / `BandManagementPage.tsx` / `OtherAppInstall.tsx` / `agent-quota-utils.ts`
- `src/renderer/hooks/useQuotaState.ts`
- `band-app/` 整个目录
- `core/` 整个目录（表盘协议已完成且真机验证过，**只读不改**）

`src/renderer/App.tsx` 和 `src/renderer/components/layout/Sidebar.tsx` 你需要改，但**只允许加行，不允许改动或重排已有代码**（加一个 page 分支、加一个 nav item），把改动面压到最小以便后续合并。

## 已核实的 Core RPC 契约（照这个写，不要自己猜）

Core 走本地 TCP JSON-RPC（换行分隔），请求体形如 `{ id, method, params, token }\n`。
端点信息在 `%LOCALAPPDATA%\PulseDev\run\core.json`（含 `port` 和 `token`）。
**主进程里已有现成客户端：`src/main/services/oronbox-client.ts` 的 `OronBoxClient.call<T>(method, params)`。直接用它，不要自己开 socket。**
调用范式照抄 `src/main/services/core-app-install-bridge.ts`（那是 `device.app.install.*` 的桥接，结构一模一样）。

### 1. `device.watchface.list`

- params：无
- 成功：`{ ok: true, result: { watchfaces: [...] } }`
- 每个 item 的字段（来自 `core/src/rpc.rs:377` 起的 Fake 分支，是真实字段形状）：

```
id                string    表盘 id
name              string    表盘名
is_current        bool      是否当前正在使用
can_remove        bool      是否可删除（内置表盘为 false）
version_code      number
can_edit          bool
background_color  string
background_image  string
style             string
```

- 失败：`{ ok: false, error: { code: 'watchface_list_failed', ... } }`

### 2. `device.watchface.set`

- params：`{ id: string }`（空字符串会被 core 拒为 `invalid_params`，前端要先挡住）
- 成功：`{ ok: true, result: { watchface: <同上的 item> } }`
- 失败 code：`watchface_set_failed`

### 3. `device.watchface.install`

- params：`{ path: string, md5: string, id?: string }`
  - `path`：表盘文件的本地绝对路径
  - `md5`：**完整文件的 MD5，32 位小写 hex**（core 里叫 `data_id`）。格式不对 core 直接拒 `invalid_params`，所以主进程侧要负责算这个 md5，不要让渲染层算。
  - `id`：可选，显式指定表盘 id
- 成功：`{ ok: true, result: { watchface_id, result_code, result_code_meaning } }`
  - `result_code === 2` → `INSTALL_SUCCESS`（新装成功）
  - 其他 → `INSTALL_USED`（设备上已存在该表盘）—— **这是成功路径，不是错误，UI 必须区别于失败显示**
- 失败 code：`watchface_install_failed`

## 硬约束

1. **安装没有进度事件。** `install_watchface_file` 是阻塞式调用，全程无 progress 推送（真机验证脚本用的是 300 秒超时）。所以 UI **不许画假进度条**，只能用「安装中…（可能需要几分钟，请保持手环连接）」这种长时 busy 态 + 可取消/可放弃的说明。超时请设到 **300000 ms**。
2. **未连接手环时不要放可点的按钮。** 仓库设计规范 `docs/design/pulse-2.0-design-system.md:34` 明确写着「严禁展示不可用功能入口：表盘市场、表盘自定义导入等未完备功能不得在界面呈现不可用按钮」。未连接时整页显示「需要先连接手环」+ 一个跳转到「手环」页的链接，而不是灰掉的表盘按钮。
3. **同步更新那条设计规范。** 本次表盘能力已真机验证，规范第 6 条的措辞与现状矛盾了。在 `docs/design/pulse-2.0-design-system.md` 里把该条改成「表盘**市场**与社区资源导入仍未完备，不得呈现入口；已真机验证的本地表盘列表 / 切换 / 安装可以呈现」。**只改这一条，不要重写文档。**
4. **不新增第三方依赖。** md5 用 Node 内置 `crypto`。
5. 每完成一段单独 commit（service / preload / renderer 各一个），message 前缀 `feat(watchface-ui)`。
6. 做完必须 `npm run build` 退出 0，把输出贴出来。

## 要做的事

### 第 1 段：主进程 service

新建 `src/main/services/watchface-service.ts`：

- 封装三个 RPC（`list` / `set` / `install`），用 `OronBoxClient.call`。
- `install` 接收本地文件路径，在这一层用 `crypto.createHash('md5')` 算完整文件的 32 位小写 hex，再拼进 params。
- 统一错误形状：返回 `{ ok: true, data }` 或 `{ ok: false, code, message }`，让渲染层不需要认 core 的原始错误结构。
- 在主进程注册 IPC（channel 命名跟现有惯例走：`pulse:watchface:list` / `:set` / `:install`）。注册位置照抄 `pulse:app-install:*` 那几个 handler 所在的文件。

### 第 2 段：preload

在 `src/preload/index.ts` 的 `pulse` 对象里加一个 `watchface` 命名空间，形状对齐已有的 `appInstall`：

```ts
watchface: {
  list: () => ipcRenderer.invoke('pulse:watchface:list'),
  set: (id: string) => ipcRenderer.invoke('pulse:watchface:set', { id }),
  install: (filePath: string) => ipcRenderer.invoke('pulse:watchface:install', { filePath }),
},
```

渲染层拿本地文件绝对路径要用已有的 `getPathForFile`（Electron ≥32 没有 `File.path`）。

### 第 3 段：渲染层页面

1. `Sidebar.tsx`：在 `PulsePage` 类型里加 `'watchface'`，在 `MENU_ITEMS`（「概览」「手环」那一组）后面加一项 `{ id: 'watchface', label: '表盘', icon: <从 lucide-react 选一个，已 import 的有 Watch，可用 Palette 或 Clock> }`。**只加，不动已有项。**
2. `App.tsx`：加 `{page === 'watchface' && <WatchFacePage ... />}` 分支。同时 `getInitialScreen()` 里的 `if (s === 'band' || s === 'settings')` 要把 `'watchface'` 也放进去，否则带参数启动会掉回概览。
3. 新建 `src/renderer/components/pulse/WatchFacePage.tsx` 和 `src/renderer/hooks/useWatchFace.ts`。

页面内容按状态分层，**每个状态只给一个明确的主操作**：

| 状态 | 页面呈现 |
|---|---|
| 手环未连接 | 「需要先连接手环」+ 跳转「手环」页 |
| 读取中 | 骨架/加载态 |
| 读取失败 | 错误摘要 + 「重试」 |
| 已连接且有列表 | 表盘网格；当前表盘有明确标记；点击非当前项 → 「设为当前表盘」 |
| 切换中 | 该项 busy，其余不可点 |
| 安装中 | 长时 busy 态（见硬约束 1） |
| 安装完成 | 区分 `INSTALL_SUCCESS` 与 `INSTALL_USED` 两种文案，都用成功色 |
| 安装失败 | 错误色 + 错误原因 + 「重试」 |

**样式必须复用现有 token**（`var(--bg-subtle)`、`var(--text-primary)`、`var(--accent-wash)`、`var(--status-error)`、`var(--status-success)` 等），不要引入新配色、不要写死颜色值。参考 `BandManagementPage.tsx` 的卡片写法。

`can_remove: false` 的内置表盘：不提供删除入口（core 也没暴露删除 RPC）。

## 交付要求

给我一份简短报告，只要这五块：

1. 每段改了哪些文件、新建了哪些文件。
2. `device.watchface.install` 的 md5 你在哪一层算的、怎么算的。
3. 未连接 / 读取失败 / 安装中 / `INSTALL_USED` 这四个状态各自的实际界面文案。
4. `npm run build` 的实际输出（退出码 + 产物文件名）。
5. **明确列出没验证的东西**：真机表盘列表、真机切换、真机安装、长时安装的实际耗时与超时行为。你没有手环，不要把「代码上应该可以」写成「已验证」。

======

## 附：合并时的注意事项（给我自己看的，不要贴给 zcode）

- main 上另一个 agent 还剩 `ui-fix-6`（SetupWizard.tsx）和 `ui-fix-7`（MiniBar.tsx），与本分支零重叠。
- 唯一可能的冲突点是 `App.tsx`：ui-fix-6 若给 `<SetupWizard>` 加 props 会改文件底部，表盘加的 page 分支在中部，相隔十几行，git 可能判为同一冲突块。手工解，两边改动互不排斥。
- 合并顺序建议：等 main 上 ui-fix-6/7 提交完，再 `git merge main` 进本分支解一次冲突，最后合回 main。
- 真机验证没过就不要合，整条分支可以直接丢弃。
