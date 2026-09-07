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
| 1 帧层（离线，含独立测试向量） | ✅ 无人值守，不碰蓝牙 |
| 2 RPC 契约层 + 假设备（离线） | ✅ 无人值守，不碰蓝牙 |
| 3 RFCOMM 连接与首包方向 | ⚠️ 需手环，通过前置检查 |
| 4 认证握手 | ⚠️ 需手环 |
| 5 **额度往返（核心里程碑）** | ⚠️ 需手环 |
| 6 打包成 daemon + 恢复测试 | ⚠️ 需手环 |
| M2 正式替换 / 卸载 OronBox | 🚧 **不在本计划范围**，需要单独决策 |

### 前置检查（阶段 3、4、5、6 每次开始前必跑）

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
```

空 → 继续。非空 → **不许 kill**，写 `STATUS.md` 请用户自己退出，然后停止。

### 手环保护条款（阶段 4 起）

逆向握手会向手环发不合法的帧。

- 连续 3 次无响应（超时或断链）→ **停止**，写 `STATUS.md`，不许进重试循环
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

**阶段 2 的第一件事就是逐项确认后四个的降级行为**，不能想当然。

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

pulse-core 对 interconnect 的职责因此很窄：

```
手环 ──► core ──► {messageType:"event", event:"device.interconnect",
                    packageName:"com.codeisland.band", payload:<不透明字节>}
手环 ◄── core ◄── device.interconnect.send { package, payload }
```

**core 只负责搬运，不解析 payload 内容。**

但设备侧的 interconnect 仍是未知量，阶段 5 要解决：protobuf 消息类型和字段、
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
所以阶段 1 强制要求**来源独立、预期字节确定**的测试向量（见阶段 1）。

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

## 阶段 1：帧层（✅ 全离线）

**目标**：帧编解码写完，并且**不是靠自我一致证明的正确**。

- [x] ~~安装 Rust~~ —— 已装：cargo 1.98.1 / rustc 1.98.1
- [ ] `cargo new --bin core --name pulse-core`，放仓库根的 `core/`
- [ ] `core/src/frame.rs`：`encode` / `decode`（decode 要能处理半包，返回还差多少字节）
- [ ] CRC16 单独成模块，参数可配（poly / init / 反射 / 最终异或），因为这些还没确认

**测试（前两个是硬要求）**：

1. **独立已知答案向量**：CRC-16/CCITT-FALSE 对 ASCII `"123456789"` 的标准校验值是 `0x29B1`。
   这个值来自 CRC 目录，与手环协议无关，**能证明 CRC 实现本身没写错**。
2. **一个来源独立、预期字节写死的完整帧向量**。阶段 3 抓到真实帧之前，
   这条测试可以先 `#[ignore]`，但**必须存在**，并在阶段 3 用真实数据填上后取消 ignore。
3. round-trip（encode→decode 字段全等）
4. CRC 错误的帧被拒绝
5. 半包：喂前 3 字节返回「需要更多」，补齐后成功
6. 粘包：两帧拼接，连续 decode 出两个

**验证**：`cd core && cargo test`

**完成标准**：1、3、4、5、6 全绿；2 存在且标了 ignore。

**禁止**：不写 socket 代码，不碰认证，不碰 protobuf。

---

## 阶段 2：RPC 契约层 + 假设备（✅ 全离线）

**目标**：pulse-core 能被 Pulse Dev 连上并通过版本检查，设备层用假实现顶着。
这一阶段把接入风险提前暴露，不用等手环。

- [ ] `core/src/rpc.rs`：监听 `127.0.0.1:0`，行分隔 JSON，token 校验
- [ ] 写端点文件 `%LOCALAPPDATA%\PulseDev\run\core.json`
- [ ] 实现 `daemon.info` 返回 `{protocolVersion: 6}` ← **接入的第一道门**
- [ ] `--fake` 标志：`device.connect` 等命令返回固定假数据，按 §1.3 的真实形状发
      `device.state` 事件（`state.protocolState = "ready"` 等）
- [ ] **逐项确认 `plugin.list` / `plugin.open` / `plugin.close` / `settings.set` 的降级行为**：
      读 `oronbox-bridge.ts` 里这些调用的错误处理，决定返回空值还是 `method_not_found`，
      把结论写进 `docs/protocol/rpc-contract.md`
- [ ] 改 `oronbox-client.ts` 的两个常量指向 pulse-core（**这是允许的改动**）

**验证**：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
npm run dev
```

**完成标准**：Pulse Dev 启动后 **不进 degraded 状态**，设备页显示假设备为已连接，
UI 不报错。整个过程手环没参与。

**这一阶段如果卡住，说明 §1.3 的契约还有没查出来的错 —— 那正是提前做它的原因。**

---

## 阶段 3：RFCOMM 连接与首包方向（⚠️ 需手环）

**目标**：拆成三个独立结论，不要合并判断。

上一版把「连上后收到 `a5 a5`」当成可行性判决，这是错的 ——
**没有证据表明手环会先说话。** 如果协议要求主机先发，阻塞 `recv` 会把正常链路误判成失败。

- [ ] **3a 链路**：Winsock `AF_BTH` / `SOCK_STREAM` / `BTHPROTO_RFCOMM`，
      `SOCKADDR_BTH { btAddr, serviceClassId: SPP UUID, port: 0 }`（`port=0` 让 SDP 解析通道）。
      结论只有一个：`connect()` 是否返回成功。
- [ ] **3b 首包方向**：连上后带 **10 秒超时**读。
      - 有数据 → 记录 hexdump，手环先说话
      - 超时无数据 → **不是失败**，记录「需要主机先发」，进 3c
      - 两种结果都要写进 `docs/protocol/handshake.md`
- [ ] **3c 有效交互**：根据 3b 的结论，构造第一个探测帧发出去，观察响应。
      「没回 NAK」**不能**作为 ACK 正确的证据 —— 设备可能只是忽略了它。
      要找的是一个**可区分的响应**（内容随输入变化，或错误码不同）。
- [ ] 每次退出前显式 `closesocket`，释放 SPP 链路
- [ ] 抓到的真实帧存进 `core/tests/fixtures/`，回填阶段 1 那条 `#[ignore]` 测试并取消 ignore

**完成标准**：3a 成功；3b 有明确结论并记录；3c 拿到至少一个可区分的响应；
阶段 1 的独立向量测试转绿。

**如果 3a 失败**：
1. `No RFCOMM channel available` → 跑前置检查确认 OronBox 真退干净了（含托盘），
   再确认手环在 Windows 蓝牙设置里是已配对
2. 手环不在附近 / 蓝牙关着 → 写 `STATUS.md` 停下，这不是代码问题
3. 连续三次不同原因失败 → 停下来问，不要继续试

---

## 阶段 4：认证握手（⚠️ 需手环）

- [ ] 用 `device.json` 里的 16 字节 authkey
- [ ] 每一步的请求和响应记进 `docs/protocol/auth.md`
- [ ] 会话密钥协商成功后，加解密封装进 `core/src/session.rs`

**完成标准**：断开重连三次，三次都能自动完成认证；
且能拿到一个**只有已认证对端才会得到**的响应（不是「没报错」）。

**卡住的处理**（超过两个周末没进展就执行）：
1. 装 Bluetooth Test Platform 的 `btvs.exe`（Microsoft 出品，输出可用 Wireshark 打开）
2. 抓一次 OronBox 完整连接手环的过程
3. 对照握手包补齐 `docs/protocol/auth.md`
4. 抓包是**自己的观测数据**，许可证上最干净，优先于读任何人的源码

---

## 阶段 5：额度往返（⚠️ 需手环）—— **核心里程碑**

**这是判断项目是否真的可行的地方，不是阶段 3。**

认证成功到手环快应用拿到额度之间，还隔着整个 interconnect 应用数据通道。要解决：

- [ ] interconnect 的 protobuf 消息类型和字段
- [ ] 包名路由（`com.codeisland.band`），是否需要注册或订阅
- [ ] 分片 / 序号 / 确认与加密如何组合
- [ ] 把设备侧数据转成 `fetch-bridge-direct.ts` 期待的事件形状（§1.4）

**完成标准**：Pulse Dev 连着 pulse-core，**手环上的 Pulse App 显示出真实额度数字**，
且连续跑 10 分钟不掉线。

**在这一步跑通之前，不要开始阶段 6。** 时间估计也要等这一步之后才有意义。

---

## 阶段 6：daemon 打包 + 恢复测试（⚠️ 需手环）

- [ ] `pulse-core.exe` 通过 electron-builder 的 `extraResources` 打进 Pulse Dev 安装包
- [ ] 断线重连：拔蓝牙 / 手环走出范围 / 杀掉 core 进程，三种情况都能恢复
- [ ] `daemon.stop` 能干净退出并释放 SPP 链路
- [ ] 跑 `node --test scripts/test-pc-v1.1.mjs`（19 个测试）确认没打破既有逻辑

**完成标准（= M1 验收）**：OronBox 进程不存在的情况下，Pulse Dev 全流程正常，
且三种断线场景都能自愈。**OronBox 仍然装在机器上，生产 Pulse 照常可用。**

---

## M2（不在本计划范围）

生产 Pulse 切到 pulse-core、卸载 OronBox、发布正式版 —— 这是 M1 验收之后的**单独决策**，
需要重新评估新用户配对路径（§1.1）和 RPK 安装如何闭环。

---

## 时间

**「3~6 个周末」是探索预算，不是交付承诺。**

真正能估算的只有前两个阶段：

| 阶段 | 估计 |
|---|---|
| 1 帧层（离线） | 一个晚上 |
| 2 RPC + 假设备（离线） | 一个晚上到一天 |
| 3~6 | **阶段 5 跑通之前，任何估计都是猜测** |

---

## 每阶段的通用要求

1. 一个阶段一组 commit，message 说清楚**为什么**，不只是做了什么。
2. 每阶段留下**一个能跑的验证**。不写框架、不写脚手架。
3. 没达到「完成标准」就不要进下一阶段。
4. 发现协议新事实 → 写进 `docs/protocol/`，注明来源（公开文档 / 自己抓包）和日期。
5. **区分「事实」和「假设」。** 拿不准的一律按假设处理，并说明怎么验证。
6. commit message 结尾加：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
