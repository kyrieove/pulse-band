# pulse-core ↔ Pulse Dev RPC 契约（阶段 1）

来源标注：本文所有事实均来自**本仓库自己的代码**（`oronbox-client.ts`、`oronbox-bridge.ts`、
`fetch-bridge-direct.ts`、`band-app/src/pages/index/index.ux`、`status-server.ts`），逐行核对日期
**2026-09-08**。没有一条来自公开文档（OronBox 的 RPC 文档 `docs/ORONBOX_DAEMON_RPC.md` /
`FETCHBRIDGE_PROTOCOL.md` 在仓库里被引用但不存在）。手环侧蓝牙协议不在此文档范围（阶段 2 取证）。

## 1. 传输与鉴权

| 项 | 契约 | 来源 |
|---|---|---|
| 传输 | 回环 TCP，UTF-8，行分隔 JSON（`\n`） | `oronbox-client.ts` `call()`/`onData()` |
| 端点文件 | `%LOCALAPPDATA%\PulseDev\run\core.json`：`{port, token, pid, protocolVersion}` | 原 `daemon.json` 路径替换；隔离见计划 §0.1 |
| 版本检查 | 客户端连接后调 `daemon.info`，**只认返回值里的** `protocolVersion`，严格 `=== 6`；端点文件里的同名字段不参与判断 | `checkProtocolVersion()` |
| token | 每个请求都带 `token` 字符串（来自端点文件） | `call()` |
| 超时 | 请求默认 15s；`daemon.info` 10s；`device.connect` 60s；`device.interconnect.send` 15s | `call()` 各调用点 |
| 事件 | `{"messageType":"event","event":"…",其余字段平铺}`；客户端按 `event` 字段路由 | `onData()` |

## 2. 方法与降级行为（阶段 1 逐项确认）

「客户端行为」指调用点的真实错误处理路径，结论据此做出。

| 方法 | pulse-core 行为 | 依据（客户端行为） |
|---|---|---|
| `daemon.info` | 返回 `{pid, protocolVersion:6, platform, endpoint, uptimeSeconds}` | **必须实现**：`checkProtocolVersion()` 读 `protocolVersion`；`refreshDaemonHealth()` 读其余字段。调不通 → 客户端进 degraded |
| `daemon.stop` | 响应 `{}` 后删端点文件、优雅关连接、进程退出 | `stopDaemon()`；托盘「彻底退出」调用 |
| `device.connect` | 假设备：发 `device.state` connecting→ready 事件，返回设备对象 | `connectBand()` 60s 超时 |
| `device.disconnect` | 发 disconnected 事件，返回 `{}` | `disconnect` IPC + `stopDaemon()`（后者失败被吞） |
| `device.status` | `{connected, protocolState, device, error}` | `connectBand()`/`refreshBandState()`：判据是 `connected` 布尔 + `protocolState` |
| `device.interconnect.send` | 参数 `{package, payload}`；payload 是 JSON 整数数组（0–255），core 转回字节→UTF-8→JSON | `fetch-bridge-direct.ts` `send()`。**字段名不对称**：事件里叫 `packageName`，调用参数叫 `package` |
| `settings.set` | **返回 ok（no-op）** | `ensureReady()` 里此调用**没有 try/catch**，报错会让整个连接流程失败 → 不能返回 method_not_found |
| `plugin.list` | 返回 ok + 空数组 | `isPluginRunning()`/`refreshBridgePlugin()` 都 catch 后按「无插件」处理；空列表让 `bridge.installed=false`（诚实：core 无插件系统） |
| `plugin.open` / `plugin.close` | 返回 `method_not_found` | 调用点全部有 try/catch；`setBridgeMode()` 切插件模式会失败并提示——core 没有插件系统，这是预期降级 |
| `device.sync.time` | **返回 `method_not_found`，禁止实现** | 计划 §1.2：OronBox syncTime 有 +4h 硬编码 bug（`fetch-bridge-direct.ts` 文件头）；`syncBandTime()` catch 后只记 warn，不影响连接 |
| `install.local` | 返回 `method_not_found` | `pushRpk()` catch 后 UI 提示失败；阶段 1 不做 RPK |
| 其他 | `method_not_found` | 未知方法在客户端表现为普通调用失败 |

## 3. 事件形状

**`device.state`**（`applyDeviceState()` 消费；connected 判据是 `state.protocolState === 'ready'`）：

```json
{"messageType":"event","event":"device.state","state":{
  "currentDevice": {"name","addr","codename","connectType","disconnected"},
  "protocolState": "ready", "connecting": false, "error": ""}}
```

- `currentDevice` 会被 `safeDevice()` 白名单重建，`name`/`addr` 缺失则设备卡片不显示；
  `disconnected` 必须显式 `false`（`raw.disconnected !== false` 会把 undefined 当已断开）。
- **pulse-core 不在事件里放 authkey**（OronBox 的 `_deviceStateJson` 有此缺陷，靠客户端 `safeDevice()` 兜底；core 侧直接不发）。

**`device.interconnect`**（`DirectFetchBridge.onMessage()` / 请求计数消费）：

```json
{"messageType":"event","event":"device.interconnect",
 "packageName":"com.codeisland.band","deviceId":"…","payload":[…整数数组…]}
```

- payload → `Buffer.from` → UTF-8 → `JSON.parse`；非数组/非 JSON 静默丢弃。

## 4. 假手环报文（照抄 band-app，不自创）

握手（`index.ux` `doSendHandshake`）：

```json
{"tag":"__hs__","count":0,
 "caps":{"version":3,"chunk":true,"maxChunkSize":768,"encodings":["text","base64"],"ack":true}}
```

客户端应答（`handleHandshake`，count<2 时回）：`{"tag":"__hs__","count":count+1,"caps":LOCAL_CAPS}`。

fetch 请求（`index.ux` `icFetch`/`statusUrl`）：

```json
{"tag":"fetch","id":"r<n>","url":"http://127.0.0.1:8765/api/status/compact?all=1",
 "options":{"method":"GET"}}
```

fetch 响应（`handleFetch`）：`{tag:"fetch", id, resp:{ok,status,statusText,headers,body,raw}}`，
body 为 UTF-8 文本。status-server `?all=1` 的 lean 形状：`{ts, sessions:{claude,codex,antigravity},
limits:{claude,codex,antigravity}}`；session 固定为 `{status,tool}` 对象（**不会是 null**）；
limit 非 null 时含 `pct5h/pct7d/level5h/level7d/resetText/reset7dText/authoritative`，其中
`resetText`/`reset7dText` 经 `shortReset` 处理**可为 null**。

## 5. 阶段 1 验证记录（2026-09-08）

跑法与证据位置见 git commit；核心结论：

- **冒烟测试**（`node scripts/test-pulse-core.mjs`，需先 `cargo build --release`；不经 Electron，
  直连 core）：端点文件、token 校验、daemon.info v6、device.connect 状态事件序列、
  握手→fetch→响应断言、坏响应被拦、降级行为、daemon.stop 干净退出（端点文件删除）——全部 PASS。
- **Run A**（手动启动 core + `electron .`，CDP 驱动真实 UI 点击连接）：全链路往返，
  core 收到 `resp.ok===true` 的响应（833B），body 为 status-server 真实额度 JSON；
  与直接 `curl http://127.0.0.1:8765/api/status/compact?all=1` 对照：
  **18 个静态字段（三 agent × pct5h/pct7d/level5h/level7d/authoritative/reset7dText）全部一致**；
  resetText 为活倒计时，两次抓取间隔 ~1 分钟，差值恰为经过分钟数，属数据源正常行为。
  UI 设备页显示「PulseDev Fake Band · 已连接 (Connected)」「联网链路已就绪」，无 DEGRADED 横幅
  （截图 `debug-window-phase1-runA-connected.png`，gitignore 内）。
- **Run B**（不手动启动 core）：客户端 `ensureDaemon()` 自动 spawn pulse-core（core.log 落盘，
  electron 日志「daemon 已拉起 pid=…」），连接、往返、额度对照同 Run A 全部通过。
- **韧性观察**（计划外，纯回环）：`taskkill` 掉已连接的 core → 客户端记「RPC 断开，等待重连」→
  自动重新拉起新 core（新端口）→「RPC 已连接」；UI 正确回到未连接，等待下一次手动连接。
- 已知无害偏差：设置页的「OronBox 已安装」检查改为探测 pulse-core.exe 存在
  （`fs.existsSync(CORE_EXE)`）；renderer 按 §0 不允许改，标签文案保持原样。
- 环境备注：本机无 MSVC/Windows SDK，Rust 构建改用 rustup 的
  `stable-x86_64-pc-windows-gnu` 工具链（自包含 MinGW 链接器，用户级安装，无系统组件）。
