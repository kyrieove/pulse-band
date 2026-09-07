# Pulse v2 Native Device Core 实施计划

工作目录：`C:\dev\pulse-band2`
仓库：`kyrieove/pulse-band-v2`（**private**，独立仓库，跟 `kyrieove/pulse-band` 无关）
分支：`main`

**目标（第一版，范围收窄）**：

> 对于**已经有 authkey、已经装好手环 App** 的设备，让 Pulse Dev 不依赖 OronBox 也能跑通
> 「手环快应用请求 → Pulse 回额度」这一条链路。

不是「取代 OronBox 的全部功能」，也不是「新用户能从零配对」。那些是后面的事。

> **修订说明（2026-09-08，第二版）**：第一版有若干「已查明的事实」与代码不符，
> 照着做会在接入阶段卡住。本版逐条对代码核实后重写，被推翻的结论在 §1.6 列出。
> 关键教训：**上一版用了一条只匹配两段式方法名的正则去枚举 RPC 命令，
> 漏掉了所有三段式方法**（`device.interconnect.send`、`device.sync.time`）。

---

## 0. 边界

### 做什么

```
今天:  Pulse (Electron) ──回环TCP+行JSON──► oronbox.exe    ──SPP──► Band 10
目标:  Pulse Dev        ──回环TCP+行JSON──► pulse-core.exe ──SPP──► Band 10
                         ↑ 协议不变，但契约要按 §1.3 校正
```

### 不做什么

1. **不迁移 Tauri，不动 Electron。**
2. **不改 `src/renderer/` 任何文件。**
3. **不做 device info / battery / storage / watchface / health / RPK install。**
4. **不建 7 个 System 目录。** 出现第二个实现再拆。
5. **一次都不许推到 `kyrieove/pulse-band`。**

### 关于「只改两个常量」

上一版把它写成硬约束，是错的。**它是一个尽量保持的小范围目标，不是禁止修改客户端的理由。**
当 `oronbox-client.ts` 的实现与新 core 有真实冲突时，改客户端是正当的 —— 但每一处改动
都要在 commit message 里说明为什么不能只改 core。

---

## 0.1 隔离：两个互斥的里程碑

上一版说「对生产影响为零」，这个表述是错的 —— **按本计划自己的前提，生产 Pulse 依赖 OronBox，
卸载它必然破坏生产。** 所以必须拆成两个独立的里程碑：

| 里程碑 | 内容 | 对生产的影响 |
|---|---|---|
| **M1 · Pulse Dev 独立运行** | Pulse Dev + pulse-core 跑通额度往返，OronBox 仍装在机器上 | 不修改生产的任何文件；共享 OronBox 和手环两个物理资源 |
| **M2 · 正式替换** | 生产 Pulse 切到 pulse-core，卸载 OronBox | **会改变生产行为，是一次单独的迁移决策** |

**本计划只覆盖 M1。** M2 需要在 M1 验收之后重新评估，不在这份文档里。

### 已经堵上的三条串台路径

| 路径 | 不改会怎样 | 已改成 |
|---|---|---|
| npm 包身份 | 两边 dev 实例共用 `%APPDATA%\pulse-band` 的 userData | `name` = `pulse-band-v2` |
| electron-builder 身份 | v2 的包会被 NSIS 当升级，覆盖用户已装的 Pulse | `productName` = `Pulse Dev`，`appId` = `com.codeisland.pulsedev` |
| core 运行目录 | 写进 `%LOCALAPPDATA%\Pulse\` 会污染生产状态 | `%LOCALAPPDATA%\PulseDev\run\` |

**这三个标识符不许改回去。**

### 隔离不了的：OronBox 和手环

这两个是共享的物理资源，改配置解决不了。进程检查**只能证明检查那一刻没看到它们**，
不能保证测试期间用户不会启动生产程序，也不能证明蓝牙链路一定空闲。

所以纪律是：

- 实机阶段开始前跑前置检查（§0.5）
- 发现 Pulse 或 oronbox 在跑 → **停下来让用户自己退，不许 `taskkill`**
- 每次实机测试结束**必须释放 SPP 链路**（显式 close，不要靠进程退出兜底）
- 跑完不用恢复 OronBox：用户下次点连接时 `ensureDaemon()` 会自己拉起来

---

## 0.5 闸门与前置检查

用户开发期间不开 Pulse；机器上 Pulse 和 OronBox 都**没有开机自启**
（注册表 Run 键和启动文件夹均无条目），所以「不打开」是可靠前提。

| 阶段 | 条件 |
|---|---|
| 0 建私有仓库 | ✅ **已完成** |
| 1 RPC 契约层 + 假设备完整往返 | ✅ 无人值守，全部有代码依据 |
| 2 协议证据收集（抓包） | 🚧 需要装 `btvs.exe`，装之前问 |
| 3 帧层（只实现证据确认的部分） | ✅ 无人值守 |
| 4 RFCOMM 连接与首包方向 | ⚠️ 需手环 |
| 5 认证握手 | ⚠️ 需手环 |
| 6 **额度往返（核心里程碑）** | ⚠️ 需手环 |
| 7 daemon 打包 + 恢复测试 | ⚠️ 需手环 |
| M2 正式替换 / 卸载 OronBox | 🚧 **不在本计划范围** |

### 前置检查（阶段 2、4、5、6、7 每次开始前必跑）

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
```

空 → 继续。非空 → **不许 kill**，写 `STATUS.md` 请用户自己退出，然后停止。

阶段 2 的 OronBox 基线抓包是有意启动 OronBox 的独立步骤，按该阶段的交接顺序执行；
自研 core 实机测试期间仍要求 OronBox 不运行。

### 手环保护条款（连接尝试与主动发包分别计数）

连接失败限制从自研 core 首次连接尝试开始生效；发包失败限制从首次主动探测包开始生效。
**各实机阶段共用以下计数和停止规则，不因切换阶段或重启测试而清零**：

- **连续 3 次连接尝试失败** → 停止，写 `STATUS.md`；连接成功才重置连接失败计数。
  此计数独立于发包计数，避免尚未发包时无限重试。
- **连续 3 次发包得不到可区分的响应**（超时、断链、或响应与输入无关）→ **停止**，
  写 `STATUS.md`，不许进重试循环。不区分「失败原因是否相同」；收到可区分的响应
  才重置发包失败计数。记录计数与停止原因，触发停止后等待问题处理再恢复测试。
- 单次无人值守不超过 2 小时
- 手环需要重新配对才能恢复 → 🚧 立刻停，这要人操作
- 每次退出前显式关闭 socket，释放 SPP 链路

### 遇到闸门怎么做

把「已完成到哪 / 卡在哪一步 / 需要人做什么 / 下一条命令」四行写进
`future_version/STATUS.md`，然后停止。不许跳过闸门去做后面的阶段。

---

## 1. 事实与假设（严格区分）

### 1.1 authkey：本机已有，但获取路径不止一条

本机这份可以直接读：

```
%APPDATA%\OrPudding\OronBox\shared_preferences.json
  → flutter.paired_devices（JSON 字符串数组，取第一项再 parse）
    { name, addr, connectType: "spp", authkey: <32 hex 字符>, codename: "o66" }
```

**但仓库里已经有 `src/main/services/band-key-extract.ts`** —— 从 Mi Fitness 日志里提取
authkey 的完整功能（.zip / 文件夹 / .log 三种输入）。它的文件头明确写着：

> 只解析、只显示。用户拿到 key 之后仍然在 OronBox 里输入并连接
> （**那是唯一验证过的配对路径**）。

所以：**第一版的适用前提是「已配对、已有 key」。** 新用户如何配对，本计划不解决，
也因此**不要删除文档里「安装 OronBox」的说明**（上一版把这个写成发布完成条件，是错的）。

**纪律**：MAC 和 authkey 一律从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读，
禁止硬编码，禁止提交进 git（已在 `.gitignore`）。

### 1.2 RPC 方法全集（11 个，已核实）

用 `grep -oE "'[a-z][a-zA-Z.]+'"` 重新枚举，不再限制段数：

| 方法 | 谁在用 | v2 怎么办 |
|---|---|---|
| `daemon.info` | **`checkProtocolVersion()` 每次连接后必调** | ✅ **必须实现**，返回 `{protocolVersion: 6}` |
| `daemon.stop` | 彻底退出流程 | ✅ 必须实现 |
| `device.connect` | 连接手环 | ✅ |
| `device.disconnect` | 断开 | ✅ |
| `device.status` | 查询状态 | ✅ 返回 `{connected, device?}` |
| `device.interconnect.send` | **发数据给手环快应用**，参数 `{package, payload}` | ✅ **核心** |
| `device.sync.time` | — | ❌ **禁止实现也禁止调用**：OronBox 的 syncTime 有 +4h 硬编码 bug（见 `fetch-bridge-direct.ts` 文件头） |
| `plugin.list` / `plugin.open` / `plugin.close` | OronBox 插件系统 | ⚠️ 逐项决定：core 无插件系统，返回空列表还是报 `method_not_found`，要看客户端怎么处理 |
| `settings.set` | OronBox 设置 | ⚠️ 同上 |

**阶段 1 要逐项确认后四个的降级行为**，不能想当然。

### 1.3 RPC 线协议（已按代码校正）

`docs/ORONBOX_DAEMON_RPC.md` 和 `FETCHBRIDGE_PROTOCOL.md` **都不存在**（代码注释引用了两个
没写的文档）。以下以实际代码为准。

**端点文件** `%LOCALAPPDATA%\PulseDev\run\core.json`：

```json
{ "port": 51234, "token": "…", "pid": 1234, "protocolVersion": 6 }
```

⚠️ **版本检查不看这个文件的 `protocolVersion`。** 客户端连上后调 `daemon.info`，
读**它返回值里的** `protocolVersion`，必须严格等于 6。调不通或值不等 → 客户端进 degraded。
（上一版把这条写反了，见 `oronbox-client.ts` 的 `checkProtocolVersion()`。）

**传输**：回环 TCP，UTF-8，行分隔 JSON。

```
请求  {"id":"r1","method":"device.connect","params":{},"token":"…"}
响应  {"id":"r1","ok":true,"result":{ … }}
      {"id":"r1","ok":false,"error":{"code":"…","message":"…"}}
事件  {"messageType":"event","event":"…", …其余字段平铺… }
```

**`device.state` 事件的真实形状**（上一版写错了）：

```json
{"messageType":"event","event":"device.state","state":{
   "currentDevice": { },
   "protocolState": "ready",
   "connecting": false,
   "error": ""
}}
```

`connected` 的判据是 `protocolState === 'ready'`，不是一个 `connected` 布尔字段。
见 `oronbox-bridge.ts` 的 `applyDeviceState()`。

⚠️ **安全**：OronBox 的这个 `state` 来自 `_deviceStateJson`，**里面含 authkey 明文**，
客户端靠 `safeDevice()` 只取安全字段。**pulse-core 不要复制这个缺陷** —— 事件里根本不要放 key。

**`device.interconnect` 事件**：带 `packageName` 字段，客户端据此计数和路由。

### 1.4 应用层协议已经实现了，Rust 不要碰

`src/main/services/fetch-bridge-direct.ts` 已经用 TypeScript 实现了手环快应用的
握手和请求响应：`__hs__` 握手 + caps 协商（v3）、`fetch` 请求、单帧响应、
chunk / ack 声明。**这一层留在 Electron，不搬进 Rust。**

pulse-core 对 interconnect 的职责因此很窄：**只搬运，不解析 payload 内容。**

但「不解析」不等于「不用定义表示」。字节怎么放进 JSON 是硬契约，已从代码核实：

**payload 是 JSON 整数数组（每项 0–255），不是 base64，不是字符串。**

收（core → 客户端），事件字段名是 `packageName`：

```json
{"messageType":"event","event":"device.interconnect",
 "packageName":"com.codeisland.band",
 "deviceId":"…",
 "payload":[123,34,116,97,103,34,58,34,102,101,116,99,104,34,125]}
```

客户端做 `Array.isArray(payload)` 检查 → `Buffer.from(payload)` → UTF-8 → `JSON.parse`。
不是数组直接静默丢弃；不是合法 JSON 也静默丢弃。

发（客户端 → core），调用参数字段名是 **`package`**：

```json
{"id":"r7","method":"device.interconnect.send",
 "params":{"package":"com.codeisland.band",
           "payload":[123,34,116,97,103,34,58,34,102,101,116,99,104,34,125]},
 "token":"…"}
```

⚠️ **两侧字段名不对称**：事件里是 `packageName`，调用参数里是 `package`。
这不是笔误，是 OronBox 的既有行为，pulse-core 必须照抄，否则 `fetch-bridge-direct.ts` 接不上。

超时 15 秒。见 `fetch-bridge-direct.ts` 的 `send()` 和 `onMessage()`。

但设备侧的 interconnect 仍是未知量，阶段 6 要解决：protobuf 消息类型和字段、
包名路由（是否需要注册/订阅）、分片与序号与加密怎么组合。

### 1.5 传输帧格式：**假设，不是事实**

上一版把下面这张表列成「已查明的事实」，并署了 Gadgetbridge 的链接。**这是错的** ——
实际抓取那个页面时，它明确回复协议细节不在该页；那张表来自搜索结果的聚合摘要
（含第三方博客与论文），不是那个 URL 的内容。

以下**全部按待验证假设处理**：

```
magic (2B)  = A5 A5 ?
type  (1B)  = 00 NAK | 01 ACK | 02 CMD | 03 DATA ?
seq   (1B)  ?
len   (2B)  little-endian ?
crc   (2B)  little-endian，CRC16-CCITT，poly 0x1021，init 0xFFFF ?
payload (N B) = protobuf ?
```

即使布局对，仍然缺：**CRC 的覆盖范围**（从哪个字节到哪个字节）、**输入/输出是否反射**、
**最终异或值**，以及各 type 的具体载荷格式。

SPP UUID `00001101-0000-1000-8000-00805F9B34FB` 是标准 SPP，这一条是事实。

⚠️ **最危险的假进展**：编码器和解码器共用同一个错误假设，round-trip 测试照样全绿。
所以帧层（阶段 3）必须建立在阶段 2 的抓包证据上，并强制要求**来源独立、预期字节确定**的测试向量。

### 1.6 上一版被推翻的结论

| 上一版写法 | 实际 |
|---|---|
| `daemon.info` 随 OronBox 消失 | 是版本检查的入口，必须实现 |
| 端点文件的 `protocolVersion` 是检查对象 | 检查的是 `daemon.info` 的返回值 |
| 发数据调 `device.interconnect` | 实际是 `device.interconnect.send`，参数 `{package, payload}` |
| `device.state` 平铺 `connected` / `device` | 嵌套在 `state` 下，判据是 `protocolState === 'ready'` |
| `daemon.stop` 不需要 | 退出流程要用 |
| 命令一共 5 个 | 11 个（上一版正则漏了三段式方法名） |
| 帧格式是已查明事实 | 是待验证假设，来源署错了 |
| 「对生产影响为零」 | 终点必然影响生产，拆成 M1 / M2 |
| 发布时删掉「安装 OronBox」文档 | 第一版仍依赖 OronBox 完成配对，不能删 |
| 3~6 个周末 | 那是探索预算，不是交付承诺 |

### 1.7 其他地雷

1. **`btleplug` 不能用** —— 只做 BLE，这里是 Bluetooth Classic。
2. **`node --test` 不支持 TypeScript parameter property**。纯逻辑抽到 `*-policy.ts`，
   跟现有 `oronbox-policy.ts` / `antigravity-policy.ts` 一个套路。
3. **electron-builder 打了 tag 会隐式发布**，`dist` 脚本已带 `--publish never`，别去掉。
4. **手环同时只接受一个 SPP 链路。**

---

## 许可证纪律（每阶段适用）

- **不阅读** OronBox（AGPL-3.0）、AstroBox-NG（AGPL-3.0）、Gadgetbridge（GPLv3）的**源代码**。
- **可以阅读**：它们的 wiki、issue、协议文档，以及第三方逆向分析文章。
  协议事实（包格式、字段顺序、opcode、CRC 参数）不受版权保护。
- 每条协议事实写进 `docs/protocol/*.md`，**注明来源和日期，并区分「公开文档」还是「自己抓包」**。
  自己抓包是最干净的来源。
- 禁止把任何 AGPL/GPL 代码翻译成 Rust 后改变量名。

---

## 阶段 0：建独立私有仓库

**✅ 已完成（2026-09-08）。** 仓库 <https://github.com/kyrieove/pulse-band-v2>（private），
首个提交 54c51ae，保留了与 pulse-band 的共享历史。

---

## 阶段 1：RPC 契约层 + 假设备完整往返（✅ 不碰蓝牙）

**为什么先做这个**：它是唯一**全部有代码依据**的部分（§1.2 / §1.3 / §1.4 都是从
`oronbox-client.ts`、`oronbox-bridge.ts`、`fetch-bridge-direct.ts` 读出来的），
不含任何关于手环协议的假设。设备层的一切都还是猜测，先写它等于在沙子上盖楼。

- [ ] `cargo new --bin core --name pulse-core`，放仓库根的 `core/`
- [ ] `core/src/rpc.rs`：监听 `127.0.0.1:0`，行分隔 JSON，token 校验
- [ ] 写端点文件 `%LOCALAPPDATA%\PulseDev\run\core.json`
- [ ] `daemon.info` 返回 `{protocolVersion: 6}` ← **接入的第一道门**
- [ ] `daemon.stop` 干净退出
- [ ] `--fake` 模式：`device.connect` / `device.status` 返回固定假数据，
      按 §1.3 的真实形状发 `device.state` 事件（`state.protocolState = "ready"`）
- [ ] **假手环**：`--fake` 下由 core 主动发一条 `device.interconnect` 事件，
      payload 是 `__hs__` 握手包的整数数组（照 §1.4 的编码），
      然后是一条 `{tag:"fetch", id, url:"/api/status/compact", options:{...}}` 请求
- [ ] 接住客户端回来的 `device.interconnect.send`，把 payload 转回 JSON 打印/断言
- [ ] **逐项确认 `plugin.list` / `plugin.open` / `plugin.close` / `settings.set` 的降级行为**：
      读 `oronbox-bridge.ts` 里这些调用的错误处理，决定返回空值还是 `method_not_found`，
      结论写进 `docs/protocol/rpc-contract.md`
- [ ] 改 `oronbox-client.ts` 的两个常量指向 pulse-core（**这是允许的改动**）

**验证**：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
npm run dev
```

**完成标准（不只是"显示已连接"）**：

1. Pulse Dev 启动后**不进 degraded 状态**
2. 设备页显示假设备为已连接
3. **假手环发出的 fetch 请求，经过真实的 `fetch-bridge-direct.ts` 处理，
   core 收到了带真实额度数据的响应**：payload 能转回合法 JSON，`resp.ok === true`，
   响应 ID 与请求 ID 匹配，额度字段存在且符合现有协议定义，并与本次请求所使用的
   数据源结果一致。记录对照依据；不能只凭成功标志判定额度正确

第 3 条是这一阶段的核心。它在完全不碰蓝牙的前提下，验证了整条客户端契约。
“不碰蓝牙”不代表完全离线：若真实额度需要访问外部服务，验收仍依赖该服务可用。
固定测试数据可以用于契约测试，但不能代替这里的真实额度验收。
**这一阶段卡住时，先区分 RPC 契约、启动流程与额度数据源问题，再按证据定位；
不能把外部服务不可用直接判定为 §1.3 / §1.4 的契约错误。**

---

## 阶段 2：协议证据收集（🚧 装工具前先问）

**为什么在实现帧层之前**：§1.5 那张 A5A5 表是假设。布局、CRC 覆盖范围、反射参数、
最终异或全部未知。先写编解码器只能证明自己跟自己一致。

- [ ] 🚧 **装 `btvs.exe`（Bluetooth Test Platform）之前，先写 `STATUS.md` 问用户** ——
      这是往系统里装 Microsoft 的蓝牙调试组件，不是无人值守该自己决定的事
- [ ] 按以下顺序完成基线抓包，期间自研 core 不连接手环：
  1. 前置检查通过后，仅启动 OronBox 作为基线连接程序
  2. 抓取 OronBox 完整连接手环的过程，用 Wireshark 打开并确认捕获到了可分析的传输数据
  3. 在 OronBox 中断开手环并正常退出，确认链路已释放
  4. 再跑前置检查；仍有进程则按 §0.5 停止，不进入自研 core 实机测试
- [ ] 从抓包确认，逐项写进 `docs/protocol/transport.md`，每条注明「自己抓包 + 日期」：
  - magic 是不是 `A5 A5`
  - type / seq / len 的位置和字节序
  - **CRC 的覆盖范围**（从第几字节到第几字节）、**输入输出是否反射**、**最终异或值**
  - 各 type 的载荷格式
  - **首包方向**：连接建立后是手环先发还是主机先发（这里能直接看出来，
    比阶段 4 自己试要可靠）
- [ ] 无法从抓包确认的项，明确标记为「仍是假设」，不要填猜测值

**证据整理标准**：`docs/protocol/transport.md` 里每一条要么有抓包证据，要么标着
「仍是假设」，并记录原始抓包的本地位置及可定位的包号或字节范围。

**完成标准（进入阶段 3 的条件）**：已确认实现帧编解码所需的帧边界、长度规则、
必要字段布局，以及校验机制和必要参数（若确有 CRC，包括覆盖范围、反射和最终异或）。
至少有一个可用作独立测试向量的完整帧。若关键项仍是假设或抓包无法提供这些信息，
记录缺口和下一项取证动作，留在本阶段继续取证；只完成标注不算通过。

**脱敏规则**（本阶段起对所有 `docs/protocol/*.md` 生效）：
authkey、会话密钥、挑战/应答的原始字节、设备 MAC ——
一律写成 `<authkey:16B>`、`<mac>` 这类占位符，**只记结构和长度，不记值**。
需要真实字节做测试向量时，放进 `core/tests/fixtures/`（已在 `.gitignore`）。

---

## 阶段 3：帧层（✅ 离线，只实现已确认的部分）

- [ ] 若阶段 2 确认使用 CRC，在 `core/src/crc.rs` 按确认的参数实现，
      并为该算法提供**来源独立的已知答案向量**，记录来源和参数。
      只有确认使用 CRC-16/CCITT-FALSE 时，才以 ASCII `"123456789"` → `0x29B1`
      验证该实现；若确认其他算法，使用对应向量，不能用测试值反推协议。
      若校验机制不是 CRC，则实现已确认的机制，并使用对应的独立向量
- [ ] `core/src/frame.rs`：`encode` / `decode`，**只实现 transport.md 里有抓包证据的部分**。
      标着「仍是假设」的字段不要写进编解码器，留 TODO
- [ ] 用阶段 2 抓到的**真实帧**做测试向量，预期字节写死

**测试**：

1. 已确认校验算法的独立已知答案向量
2. 真实帧向量：decode 出的字段与抓包里人工核对的值逐项相等
3. round-trip
4. 校验错误的帧被拒绝
5. 半包 / 粘包

**完成标准**：1~5 全部通过，不允许用 ignore 跳过验收。独立向量验证算法和协议理解，
round-trip、错误帧、半包和粘包测试验证实现行为，不能相互替代。
**没有真实帧向量就不算帧层完成。**

**CRC 不做全参数配置**：若确认使用 CRC，只实现阶段 2 已确认的参数。真需要改再改。

---

## 阶段 4：RFCOMM 连接与首包方向（⚠️ 需手环）

**保护条款从 4a 的第一次连接尝试就生效**（见 §0.5）：连接失败和发包失败分别计数，
跨阶段不清零。4a 只做连接、还没发包时，受连接失败计数约束。

- [ ] **4a 链路**：Winsock `AF_BTH` / `SOCK_STREAM` / `BTHPROTO_RFCOMM`，
      `SOCKADDR_BTH { btAddr, serviceClassId: SPP UUID, port: 0 }`（`port=0` 让 SDP 解析通道）。
      结论只有一个：`connect()` 是否返回成功。
- [ ] **4b 观察**：连上后带 10 秒超时读，**只记录观察结果，不下结论**：
      - 有数据 → 记 hexdump
      - 无数据 → 记「10 秒观察窗口内未收到数据」。
        **这不能推出"需要主机先发"** —— 也可能是链路没真正就绪、或需要先完成某个下层步骤。
        首包方向以阶段 2 的抓包为准。
- [ ] **4c 探测**：探测帧**必须有明确来源** —— 从阶段 2 抓包里复制 OronBox 发的第一个包，
      或从 transport.md 里已确认的格式构造。**禁止凭空构造探测帧。**
      「没回 NAK」不能作为 ACK 正确的证据；要找的是**可区分的响应**
      （内容随输入变化，或不同输入给出不同错误码）。
- [ ] 每次退出前显式 `closesocket`

**完成标准**：4a 成功；4b 的观察结果记录在案；4c 拿到至少一个可区分的响应。

**如果 4a 失败**：
1. `No RFCOMM channel available` → 跑前置检查确认 OronBox 真退干净了（含托盘），
   再确认手环在 Windows 蓝牙设置里是已配对
2. 手环不在附近 / 蓝牙关着 → 写 `STATUS.md` 停下，这不是代码问题
3. 触发 §0.5 的停止规则就停，不要继续试

---

## 阶段 5：认证握手（⚠️ 需手环）

- [ ] 用 `device.json` 里的 16 字节 authkey
- [ ] 每一步的请求响应记进 `docs/protocol/auth.md`，**按阶段 2 的脱敏规则**：
      只记结构、长度、算法，**不记密钥和挑战应答的真实字节**
- [ ] 会话密钥协商成功后，加解密封装进 `core/src/session.rs`

**完成标准**：断开重连三次都能自动完成认证；且能拿到一个
**只有已认证对端才会得到**的响应（不是「没报错」）。

**卡住时**：回阶段 2 的抓包，对照 OronBox 的握手补齐 `auth.md`。
抓包是自己的观测数据，许可证上最干净，优先于读任何人的源码。

---

## 阶段 6：额度往返（⚠️ 需手环）—— **核心里程碑**

**这是判断项目是否真的可行的地方。**

阶段 1 已经用假设备验证了客户端侧契约，这一步是把真实设备接上去。要解决的是设备侧：

- [ ] interconnect 的 protobuf 消息类型和字段
- [ ] 包名路由（`com.codeisland.band`），是否需要注册或订阅
- [ ] 分片 / 序号 / 确认与加密如何组合
- [ ] 把设备侧数据转成 §1.4 那个整数数组形状

**完成标准**：Pulse Dev 连着 pulse-core，**手环上的 Pulse App 显示出真实额度数字**，
且连续跑 10 分钟不掉线。

**在这一步跑通之前，不要开始阶段 7。**

---

## 阶段 7：daemon 打包 + 恢复测试（⚠️ 需手环）

- [ ] `pulse-core.exe` 通过 electron-builder 的 `extraResources` 打进 Pulse Dev 安装包
- [ ] 断线重连：拔蓝牙 / 手环走出范围 / 杀掉 core 进程，三种都能恢复
- [ ] `daemon.stop` 干净退出并释放 SPP 链路
- [ ] 跑 `node --test scripts/test-pc-v1.1.mjs`（19 个测试）确认没打破既有逻辑

**完成标准（= M1 验收）**：OronBox 进程不存在时 Pulse Dev 全流程正常，三种断线场景都能自愈。
**OronBox 仍然装在机器上，生产 Pulse 照常可用。**

---

## M2（不在本计划范围）

生产 Pulse 切到 pulse-core、卸载 OronBox、发布正式版 —— M1 验收之后的**单独决策**，
需要重新评估新用户配对路径（§1.1）和 RPK 安装如何闭环。

---

## 时间

**「3~6 个周末」是探索预算，不是交付承诺。**

真正能估算的只有阶段 1：

| 阶段 | 估计 |
|---|---|
| 1 RPC + 假设备往返（不碰蓝牙） | 一个晚上到一天 |
| 2 抓包取证 | 半天，取决于 btvs 装得顺不顺 |
| 3~7 | **阶段 6 跑通之前，任何估计都是猜测** |

---

## 每阶段的通用要求

1. 一个阶段一组 commit，message 说清楚**为什么**，不只是做了什么。
2. 每阶段留下**一个能跑的验证**。不写框架、不写脚手架。
3. 没达到「完成标准」就不要进下一阶段。
4. 协议新事实写进 `docs/protocol/`，注明来源（**公开文档 / 自己抓包**）和日期，
   并按 §阶段 2 的脱敏规则处理敏感字段。
5. **区分「事实」和「假设」。** 拿不准的一律按假设处理，并说明怎么验证。
   文档里不允许出现第三种状态。
6. commit 的署名按**执行者自己的身份**填写，不要照抄本文档作者的 trailer。
