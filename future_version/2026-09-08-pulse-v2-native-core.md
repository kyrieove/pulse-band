# Pulse v2 Native Device Core 实施计划

工作目录：`C:\dev\pulse-band2`
仓库：`kyrieove/pulse-band-v2`（**private**，独立仓库，跟 `kyrieove/pulse-band` 无关）
分支：`main`
目标：**用一个 Rust 写的 sidecar 进程替掉 OronBox，最终把 OronBox 从机器上卸载。**

---

## 0. 边界（先读这一段）

### 做什么

把当前链路里的 `oronbox.exe` 换成自己写的 `pulse-core.exe`：

```
今天:  Pulse (Electron) ──回环TCP+行JSON──► oronbox.exe    ──SPP──► Band 10
目标:  Pulse (Electron) ──回环TCP+行JSON──► pulse-core.exe ──SPP──► Band 10
                         ↑ 这一段的协议不变
```

### 不做什么（硬约束，违反即回滚）

1. **不迁移 Tauri，不动 Electron。** 这个项目跟前端框架无关。
2. **不改 `src/renderer/` 任何文件。** UI 一行不动。
3. **不改 `src/main/services/oronbox-client.ts` 的通信逻辑。** 阶段 4 只改两个常量（exe 路径、端点文件路径），阶段 5 只改文件名。
4. **不建 7 个 System 目录。** 第一阶段只需要 auth 和 interconnect 两块逻辑，写在需要它们的文件里。出现第二个实现再拆目录。
5. **不做 device info / battery / storage / watchface / health / RPK install。** 它们对"删掉 OronBox"零贡献。
6. **一次都不许推到 `kyrieove/pulse-band`。** `pulse-band2` 是目录复制来的，它的 `.git` 里 origin **现在还指着 `kyrieove/pulse-band`**。阶段 0 的第一件事就是改掉这个 remote；改完之前不要执行任何 `git push`。

### 许可证纪律（每个阶段都适用）

- **不阅读** OronBox（AGPL-3.0）、AstroBox-NG（AGPL-3.0）、Gadgetbridge（GPLv3）的**源代码**。
- **可以阅读**：它们的 wiki、issue、协议文档，以及第三方的逆向分析文章。协议事实（包格式、字段顺序、opcode、CRC 参数）不受版权保护。
- 每发现一条协议事实，写进 `docs/protocol/*.md`，注明来源（公开文档 / 自己抓包）和日期。这份文档是"独立实现"的证据链。
- 禁止把任何 AGPL/GPL 代码翻译成 Rust 后改个变量名。

---

## 0.1 隔离铁律（最高优先级，违反即回滚）

`C:\dev\pulse-band` 里那套是**用户每天在用的生产环境**。本项目对它的影响必须为零。

### 已经堵上的三条串台路径

| 路径 | 原来会怎样 | 已改成 |
|---|---|---|
| npm 包身份 | 两个 dev 实例共用 `%APPDATA%\pulse-band` 的 userData（MiniBar 位置、bridge 模式、hook 配置） | `name` 改成 `pulse-band-v2` |
| electron-builder 身份 | v2 装出来的包会**覆盖升级掉用户已装的 Pulse** | `productName` = `Pulse Dev`，`appId` = `com.codeisland.pulsedev` |
| core 运行目录 | 写进 `%LOCALAPPDATA%\Pulse\` 会污染生产状态 | 改成 `%LOCALAPPDATA%\PulseDev\run\` |

**这三个标识符不许改回去。** 任何时候发现 v2 又叫 `Pulse` 或 appId 变回 `com.codeisland.windows`，立刻停下。

### 仍需人工纪律的两条

1. **OronBox 是共享的。** `taskkill /F /IM oronbox.exe` 会让用户正在跑的 Pulse 断开手环。
   - 只在阶段 2 及之后、**用户在场**时才允许 kill
   - 每次实机测试结束，**必须把 OronBox 拉回来**：`"C:\Program Files\OronBox\oronbox.exe" --nogui daemon run`
   - 收工前确认用户的 Pulse 能重新连上手环

2. **手环是共享的，同时只接受一个 SPP 链路。** Rust PoC 占着链路时，生产 Pulse 连不上。测试完必须断开释放。

### 绝对禁止

- 向 `kyrieove/pulse-band` push 任何东西
- 修改 `C:\dev\pulse-band` 下的任何文件
- 在 pulse-band2 里跑 `npm run dist` 之后去**安装**产物（会多装一个 Pulse Dev，虽然不覆盖，但没必要）
- 动用户已装的 `C:\Users\ASUS\AppData\Local\Programs\Pulse\`

---

## 0.5 闸门（无人值守时的停车位）

每个阶段标了三种执行条件。**遇到 🚧 必须停下来等人，不要自己往下走。**

| 阶段 | 条件 | 说明 |
|---|---|---|
| 0 建私有仓库 | ✅ 无人值守 | 纯 git / gh 操作。`gh auth status` 若未登录 → 停下报告 |
| 1 工具链 + 帧层（全离线） | ✅ 无人值守 | 不需要手环。`winget` 若要求提权就停下报告 |
| 2 SPP 实机连接 | ⚠️ 需要实机 | 手环必须在附近、蓝牙开着；且必须先 kill OronBox |
| 3 认证握手 | ⚠️ 需要实机 | 卡住要装 `btvs.exe` 抓包时 → 🚧 停下来问 |
| 4 daemon 化 + 打通 Pulse | 🚧 **需要批准** | 会改用户正在用的 Pulse 配置，不许擅自开始 |
| 5 卸载 OronBox + 发布 | 🚧 **需要批准** | 破坏性操作，任何情况下都不许无人值守 |

**遇到闸门怎么做**：把「已完成到哪 / 卡在哪一步 / 需要人做什么 / 下一条命令是什么」四行写进 `future_version/STATUS.md`，然后停止。

**不许为了显得有进展而跳过闸门去做后面的阶段。**

**今晚无人值守的合理终点**：阶段 0 + 阶段 1 全部完成，`cargo test` 绿，停在阶段 2 之前，`STATUS.md` 写好。

---

## 1. 已查明的事实（不要重新调查）

### 1.1 authkey 已存在，明文，16 字节

```
C:\Users\ASUS\AppData\Roaming\OrPudding\OronBox\shared_preferences.json
  → flutter.paired_devices  （JSON 字符串数组，取第一项再 JSON.parse）
    { name, addr, connectType: "spp", authkey: <32 hex 字符>, codename: "o66" }
```

Xiaomi 认证密钥通常需要重新实现小米账号 OAuth 才能拿到，**这一份已经配好了**。

**纪律：MAC 和 authkey 一律从配置读，禁止硬编码进源码，禁止提交进 git。**
配置文件放 `%LOCALAPPDATA%\PulseDev\run\device.json`，并把它加入 `.gitignore`。

### 1.2 Pulse 实际只用 5 个设备命令

从 `src/main/services/oronbox-bridge.ts` 实测得到，全部命令是：

| 命令 | 用途 | v2 是否需要 |
|---|---|---|
| `device.connect` | 连接手环 | ✅ |
| `device.disconnect` | 断开 | ✅ |
| `device.status` | 查询当前状态 | ✅ |
| `device.state`（事件） | 状态变化推送 | ✅ |
| `device.interconnect`（事件+调用） | **真正的数据通道**，Pulse 应答手环快应用的请求 | ✅ |
| `app.rpk` | 装手环 App | ❌ 延后 |
| `plugin.open` / `plugin.close` / `settings.set` / `daemon.info` / `daemon.stop` | OronBox 自有 | ❌ 随 OronBox 消失 |

### 1.3 RPC 线协议（Rust 侧必须实现的完整契约）

`docs/ORONBOX_DAEMON_RPC.md` **不存在**（代码注释引用了一个没写的文档）。契约以下面这份为准，由 `oronbox-client.ts` 实测得到。

**端点文件**，daemon 启动后写入：

```json
{ "port": 51234, "token": "…", "pid": 1234, "protocolVersion": 6 }
```

- `protocolVersion` 必须**严格等于 6**，否则客户端进 degraded 状态。
- 客户端会检查 `pid` 是否存活来判断端点是否陈旧。

**传输**：回环 TCP（`127.0.0.1:port`），UTF-8，**行分隔 JSON**（每条消息一行，`\n` 结尾）。

**请求**（客户端 → core）：

```json
{"id":"r1","method":"device.connect","params":{},"token":"…"}
```

**响应**（core → 客户端）：

```json
{"id":"r1","ok":true,"result":{ … }}
{"id":"r1","ok":false,"error":{"code":"…","message":"…"}}
```

**事件**（core → 客户端，无 id，主动推送）：

```json
{"messageType":"event","event":"device.state","connected":true,"device":{ … }}
```

事件的其余字段平铺在同一层，客户端会把除 `messageType`/`event` 外的所有字段作为 data 转发。

`device.status` 的 result 形状：`{ connected: boolean, device?: {...} }`（见 `oronbox-bridge.ts:351`）。

### 1.4 Xiaomi SPP 传输帧格式（公开资料）

```
magic (2B)  = A5 A5
type  (1B)  = 00 NAK | 01 ACK | 02 CMD | 03 DATA
seq   (1B)
len   (2B)  little-endian，payload 长度
crc   (2B)  little-endian，CRC16-CCITT，poly 0x1021，init 0xFFFF
payload (N B) = protobuf
```

SPP UUID：`00001101-0000-1000-8000-00805F9B34FB`（标准 Serial Port Profile）。

Xiaomi Smart Band 10 在 Gadgetbridge 支持列表内 —— 协议行为可查，不是未知领域。

来源：<https://gadgetbridge.org/basics/topics/xiaomi-protobuf/>、<https://gadgetbridge.org/gadgets/wearables/xiaomi/>

### 1.5 已知地雷

1. **手环同时只接受一个 SPP 链路。** 跑任何 Rust PoC 前必须 `taskkill /F /IM oronbox.exe`。
   历史上那个 `SPP connect failed: CONNECT_FAILED: No RFCOMM channel available` 报错，最可能就是链路被占。**这个错误用 Rust 重写不会消失**，它是 SDP 查找失败，不是语言问题。
2. **`btleplug` crate 不能用** —— 只做 BLE，协议对不上。这里是 Bluetooth Classic。
3. **`node --test` 不支持 TypeScript parameter property**（`constructor(private x: T)`）。需要被测试直接 import 的纯逻辑，抽到独立的 `*-policy.ts`，跟现有 `oronbox-policy.ts` / `antigravity-policy.ts` 一个套路。
4. **electron-builder 打了 tag 会隐式发布**，`dist` 脚本已带 `--publish never`，别去掉。

---

## 阶段 0：建独立私有仓库

**✅ 已完成（2026-09-08），zcode 从阶段 1 开始。** 仓库 <https://github.com/kyrieove/pulse-band-v2>（private），首个提交 54c51ae。

- [x] `cd C:\dev\pulse-band2`
- [x] `git remote -v` —— 确认当前 origin 是 `kyrieove/pulse-band`（就是要改掉的那个）
- [x] `gh auth status`；未登录就写 `STATUS.md` 停下
- [x] 建仓库（**private**，不要加 `--source` / `--push`，remote 下一步手动接）：

```bash
gh repo create kyrieove/pulse-band-v2 --private --description "Pulse v2: native Rust device core, replacing OronBox"
```

- [x] 改 remote：

```bash
git remote set-url origin https://github.com/kyrieove/pulse-band-v2.git
```

- [x] `git remote -v` —— **两行都必须是 `pulse-band-v2`**。只要还看得到 `pulse-band.git`，立刻停下。
- [x] `.gitignore` 追加 `core/target/` 和 `device.json`；确认已覆盖 `node_modules/`、`dist/`、`dist-electron/`、`release/`、`.cache/`
- [x] `git add -A && git commit`（`future_version/` 里 ChatGPT 原始方案和本计划一起进第一个 commit）
- [x] `git push -u origin main`

**验证**：

```bash
gh repo view kyrieove/pulse-band-v2 --json name,isPrivate,defaultBranchRef
```

**完成标准**：`isPrivate` 为 `true`，且 GitHub 上能看到 `future_version/` 里的两份文档。

**保留历史，不要 `git init` 重来。** 共享历史是将来能把 v2 合回 `pulse-band` 的前提。

**禁止**：不要向 `kyrieove/pulse-band` 推任何东西（分支、tag 都不行）。

---

## 阶段 1：工具链 + 帧层（✅ 全离线，不需要手环）

**目标**：Rust 项目立起来，A5A5 帧的编解码和 CRC16 写完并测过。这一整阶段不碰蓝牙。

- [ ] `winget install Rustlang.Rustup`（本机当前**没有** Rust 工具链）。若要求 UAC 提权而无法自动完成 → 写 `STATUS.md` 停下。
- [ ] `cargo new --bin core --name pulse-core`，放在仓库根的 `core/`
- [ ] 依赖只加 `windows`（features: `Win32_Networking_WinSock`, `Win32_Devices_Bluetooth`, `Win32_Foundation`）
- [ ] 生成 `%LOCALAPPDATA%\PulseDev\run\device.json`：从 OronBox 的 `shared_preferences.json` 读 `flutter.paired_devices`（JSON 字符串数组，取第一项再 parse），把 `addr` / `authkey` / `codename` 写过去。**这一步不需要连手环，只是读文件。**
- [ ] `core/src/frame.rs`：
  - `encode(type: u8, seq: u8, payload: &[u8]) -> Vec<u8>`
  - `decode(buf: &[u8]) -> Result<(Frame, usize), FrameError>`，要能处理半包（返回还差多少字节）
  - CRC16-CCITT，poly `0x1021`，init `0xFFFF`
- [ ] 单测（不需要真实抓包，参数是已知的）：
  1. round-trip：encode 后 decode 回来，字段全等
  2. CRC 错误的帧被 decode 拒绝
  3. 半包：喂前 3 字节返回「需要更多」，补齐后成功
  4. 粘包：两个帧拼在一起，连续 decode 出两个
- [ ] 把帧格式写进 `docs/protocol/transport.md`，注明来源是公开文档（见 §1.4）

**验证**：

```bash
cd core && cargo test
```

**完成标准**：4 个测试全绿。

**禁止**：这一阶段不要写任何 socket 代码，不要碰认证，不要碰 protobuf。

---

## 阶段 2：SPP 实机连接（⚠️ 需要手环在旁）

**目标**：连上手环，收到第一个真实的 `A5 A5` 帧。这是整个项目的可行性判决点。

**前置**：手环在附近、蓝牙开着、已在 Windows 蓝牙设置里处于已配对状态。

- [ ] `core/src/transport.rs`：Winsock 连接，MAC 和 authkey 从 `device.json` 读（**禁止硬编码，禁止进 git**）

```rust
// socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM)
// SOCKADDR_BTH {
//     addressFamily: AF_BTH,
//     btAddr: u64,                       // MAC 小端打包成 u64
//     serviceClassId: SPP UUID,          // 00001101-0000-1000-8000-00805F9B34FB
//     port: 0,                           // 0 = 让 SDP 自动解析 RFCOMM 通道
// }
// connect(...) 之后就是普通阻塞 socket，直接 recv
```

- [ ] 连上后 `recv` 并 hexdump 前 32 字节，同时喂给阶段 1 的 `decode`
- [ ] 收到 CMD/DATA 帧后回 ACK（type=`0x01`，同一个 seq）
- [ ] 把抓到的真实帧存成 `core/tests/fixtures/`，补一个用真实数据跑的 round-trip 测试

**验证**：

```bash
taskkill /F /IM oronbox.exe
cd core && cargo run
```

**完成标准**：hexdump 前两个字节是 `a5 a5`，且 `decode` 成功解出该帧；手环对我们发的 ACK 没有回 NAK。

**如果连接失败**：
1. `No RFCOMM channel available` → 先确认 OronBox 真的退干净了（含托盘进程），再确认手环在 Windows 蓝牙设置里是已配对
2. 手环不在附近 / 蓝牙关着 → 写 `STATUS.md` 停下，这不是代码问题
3. 连续三次不同原因失败 → 停下来问，不要继续试

---

## 阶段 3：认证握手

**目标**：完成认证，进入已认证会话。**这是风险最高的一段。**

- [ ] 用 `device.json` 里的 16 字节 authkey
- [ ] 实现挑战/应答握手，把每一步的请求和响应记进 `docs/protocol/auth.md`
- [ ] 会话密钥协商成功后，后续帧的加解密封装进 `core/src/session.rs`

**验证**：发一个只有已认证对端才会被应答的请求，收到非错误响应。

**完成标准**：断开重连三次，三次都能自动完成认证。

**卡住的处理**（超过两个周末没进展就执行，不要死磕）：

1. 装 Bluetooth Test Platform 的 `btvs.exe`（Microsoft 出品，输出可用 Wireshark 打开）
2. 抓一次 OronBox 完整连接手环的过程
3. 对照 wireshark 里的握手包，补齐 `docs/protocol/auth.md`
4. 抓包是**自己的观测数据**，是许可证上最干净的来源，优先于读任何人的源码

---

## 阶段 4：daemon 化 + 打通 Pulse

**目标**：`pulse-core.exe` 说 §1.3 那套 RPC，Pulse 指过去就能用。

- [ ] `core/src/rpc.rs`：监听 `127.0.0.1:0`（系统分配端口），行分隔 JSON
- [ ] 启动时写 `%LOCALAPPDATA%\PulseDev\run\core.json`：`{port, token, pid, protocolVersion: 6}`
- [ ] token 校验：每条请求的 `token` 必须匹配，不匹配回 `{"ok":false,"error":{"code":"unauthorized"}}`
- [ ] 实现 5 个命令 + `device.state` / `device.interconnect` 事件推送
- [ ] 改 `src/main/services/oronbox-client.ts` 的**两个常量**：
  - `ORONBOX_EXE` → `pulse-core.exe` 的路径
  - `DAEMON_ENDPOINT_FILE` → `%LOCALAPPDATA%\PulseDev\run\core.json`
  - spawn 参数从 `--nogui daemon run` 改成 core 自己的参数
- [ ] `pulse-core.exe` 通过 electron-builder 的 `extraResources` 打进安装包

**验证**：

```bash
taskkill /F /IM oronbox.exe
npm run dev
```

在设备管理页点连接。

**完成标准**：OronBox 进程不存在的情况下，UI 显示已连接，且额度数据推到手环、手环上的 Pulse App 能正常显示。

**禁止**：不要顺手改 `oronbox-bridge.ts` 的业务逻辑，它调的方法名不变。

---

## 阶段 5：切换、清理、发布

- [ ] `git mv src/main/services/oronbox-client.ts src/main/services/core-client.ts`，同步改 import 和类名（`OronBoxClient` → `CoreClient`）
- [ ] `oronbox-bridge.ts` → `device-bridge.ts`，删掉 FetchBridge 插件相关分支（那是 OronBox 特有的）
- [ ] 更新 `docs/手环配对指南.md` 和 `docs/故障排查.md`：删掉所有"安装 OronBox"的步骤
- [ ] 跑 `node --test scripts/test-pc-v1.1.mjs`（19 个测试）确认没打破既有逻辑
- [ ] 卸载 OronBox，重启机器，完整走一遍：启动 Pulse → 连接手环 → 看到额度
- [ ] 在 `kyrieove/pulse-band-v2` 上发 `v2.0.0`
- [ ] 是否把 v2 合回 `kyrieove/pulse-band` → 🚧 单独决定，不在本计划范围内

**完成标准**：机器上不存在 `C:\Program Files\OronBox`，Pulse 全流程正常。

---

## 时间估计

| 阶段 | 估计 |
|---|---|
| 0 建私有仓库 | 15 分钟 |
| 1 工具链 + 帧层（离线） | 一个晚上 |
| 2 SPP 实机连接 | 一个下午 |
| 3 认证握手 | 1~2 个周末（风险集中在这） |
| 4 daemon 化 | 一个周末 |
| 5 清理发布 | 半个周末 |

**合计 3~6 个周末。** 唯一可能大幅超支的是阶段 3。

---

## 每阶段的通用要求

1. 一个阶段一个 commit（或一组），commit message 说清楚**为什么**，不只是做了什么。
2. 每个阶段必须留下**一个能跑的验证**（`cargo test` 或一条实机验证命令）。不写框架、不写脚手架。
3. 阶段没达到"完成标准"就不要进下一阶段。
4. 发现协议新事实 → 立刻写进 `docs/protocol/`，带来源和日期。
5. commit message 结尾加：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
