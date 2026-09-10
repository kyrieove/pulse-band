# Pulse 2.0 安装运行时管线真实性审计（2026-09-10）

审计对象：`core/src/install/`、`core/src/install/xiaomi/`、`core/src/live.rs`、
`core/src/main.rs`、`core/tests/app_install_test.rs`、TS Main 侧遗留装包通路。

审计基线提交：`30696db feat(core): complete xiaomi install runtime pipeline`

---

## 1. 端到端实际调用链（审计后事实）

```text
Renderer                    [implemented]  设备管理页连接按钮 / 设置页自选 .rpk
  ↓
Preload                     [implemented]  pulse:app-install:*、oronbox:install-*（后者已停用）
  ↓
Main Service                [implemented]  AppInstallService → CoreAppInstallBridge
  ↓
Core RPC                    [implemented]  device.app.install.prepare/chunk/commit/cancel
  ↓
GLOBAL_INSTALL_TRANSPORT    [mock]         默认 Mock；TS 侧从不调用 device.app.install.mode，
                                           因此 device 分支在运行时不启用
  ↓
XiaomiInstallRuntimeBridge  [missing]      仅被测试实例化；main.rs / rpc.rs / live.rs
                                           没有任何生产代码创建它
  ↓
Hardware Protocol / RFCOMM  [missing]      bridge 与 device_session 的 send_install_packet
                                           只入队，从不写 socket
  ↓
Device                      [missing]      未连接真实小米手环 10，无真实安装验证
```

结论：文档与提交信息中描述的
`RPK → Core RPC → XiaomiAppInstallProtocol → RuntimeBridge → DownlinkCtx → Frame(0x03)
→ AES-CTR → RFCOMM` 这条链路**在运行时不存在**，只有协议编码/解码层（`xiaomi/`）是真实可用的离线实现。

---

## 2. 能力评级

| 能力 | 评级 | 依据 |
|---|---|---|
| Frame / AES-CTR 业务帧 / RFCOMM 认证与数据泵 | **A** | 真机 `--live` 已验证（阶段 6，`fetchevidence-2026-09-09.pcapng`） |
| 快应用列表上报、id=6/7 激活、id=8/9 互联握手与 fetch | **A** | 同上，逐帧实证 |
| Xiaomi 安装协议编解码（WearPacket/Mass/L2/CRC32） | **B** | 源码证据（source-backed），设备未验证 |
| 安装 Rx 路由与普通业务隔离（InstallFrameRouter） | **B** | 离线测试可跑通，但全局队列存在串扰缺陷 |
| 安装运行时管线（RuntimeBridge → 真实 socket） | **C** | 仅测试可用；生产不可达，发送为入队占位 |
| 真实设备 RPK 安装 | **D** | 完全缺失，无真实抓包，未取得任何实机安装证据 |

---

## 3. 发现的问题（按严重度）

1. **[已修复] `execute_wait_result` 过早成功。**
   修复前对 `wait_install_result()` 的任何 `Ok(_)` 都置 `Completed`；而设备未上报时该函数
   返回 `Ok(status="waiting_device_result")`，等于把“设备没回话”判成安装成功。
   与交接文档纪律「超时是失败/未知结果，不能按传完字节数生成 installed」直接冲突。

2. **[已修复] live.rs 全局安装事件队列在 `--live` 下无界增长。**
   `run_pump_loop` 对每个 `type=0x03` 帧都 `clone` 一份投递到进程级全局队列，而该队列唯一的
   消费者（RuntimeBridge）没有生产实例，永不消费。长期运行会持续吃内存，并制造“安装链路已接通”的假象。

3. **[已修复] 安装结果不校验目标包名。**
   `decode_install_result` 只检查 `code`，任何包的 `id=2 / code=0` 都会被判成功。
   交接文档明确要求「最终必须核验响应目标及结果，不能只收到 id=2 就成功」。

4. **[已修复] 全局队列导致 flaky 测试。**
   `test_runtime_bridge_*` 并行运行时互相调用 `clear_global_install_events()`，会把对方刚派发的帧清掉。
   实测 40 次里 1 次假失败（`normal_message_queue` 长度 2 != 3）。已串行化并复测 40/40 通过。

5. **[未修复 · 架构缺口] 接收路径被拆成两个队列。**
   `BandDeviceTransport::receive_frame`（trait 实现）只消费 session 本地队列，
   而 live.rs 派发的帧进入全局队列。两者之间没有同步，因此 `execute_wait_result` 在真实链路上
   只能走到超时分支，看不到任何设备结果。

6. **[未修复 · 架构缺口] 加解密边界不一致。**
   `XiaomiAppInstallProtocol` 自建 Frame 时直接用 `L2Packet::to_bytes()`，不带 `01 02` 前缀、
   不走 AES-CTR；而 live.rs 的真实下行一律使用 `business_frame_payload`。
   同时 `wait_install_result` 解码 `resp_frame.payload`（密文），而 `poll_app_installer_result`
   用 `router.resolve_payload`（明文）——同一条链路上两种口径。

7. **[未修复 · 架构缺口] `runtime_bridge.rs` 内的 `DownlinkCtx` 是 `live::DownlinkCtx` 的同名副本。**
   两者不是同一类型（真实结构体额外持 `basic`，且 `Drop` 会 `closesocket`），无法直接互传，
   目前也没有转换代码。`send_install_packet` 只入队，不写 socket。

8. **[未修复 · 生产路径] Core RPC 装包默认落在 Mock 传输。**
   `GLOBAL_INSTALL_TRANSPORT` 默认 `Mock`，且 TS 侧从不调用 `device.app.install.mode`，
   因此 UI 走 `device.app.install.prepare` 时会拿到一个不接触设备的假会话（`status=preparing`）。
   Mock 的 `commit` 返回 `verifying`，不会返回 `completed`，故未构成“假装机完成”，
   但仍是一个未被显式标注的 mock 生产路径。

9. **[已修复] TS Main 仍存在 `install.local` 调用点。**
   `oronbox-bridge.ts` 的 `pushRpk` 会 `client.call('install.local')`，并由 `oronbox:install-rpk` /
   `oronbox:install-bundled-rpk` 两个 IPC 通道暴露给渲染进程（设置页「安装／重新安装手环端」按钮）。
   Pulse 2.0 硬约束禁止该调用，现已改为统一返回明确的 not implemented，不再触碰文件系统或启动 daemon。

10. **[残留 · 命名] `core/src/session.rs:179` 认证时仍以 `"OronBox"` 作为 companion 设备名上报手环。**
    该字段参与已真机验证 3/3 通过的认证流程，属于冻结文件（AGENTS.md 第 7 条），
    **本次未修改**。改动需重新做真机认证验收，列入后续命名清理子项目。

11. **[残留 · 证据] 无任何真实安装抓包。**
    `docs/protocol/captures/samples-manifest.json` 中唯一样本为 `synthetic_template`，
    `analysis_status = "replayed"`；`app-install-analysis.md` 将安装 opcode 明确列为
    【未知（Unknown / Unverified）】。

---

## 4. 任务 3 结论：是否需要新增 install verification 阶段

**不需要新增独立 verify/commit 指令。**
交接文档已明确：「源码没有要求按 Pulse 的五个 trait 方法分别发出五条硬件命令。
特别是独立 verify/commit 指令，当前证据没有确认存在，不能为了适配接口而发明。」

当前可用的、有真实抓包支撑的安装后核对手段只有一个：
`type=20, id=0`（QuickApp Installed List，真机抓包 Pkt #176 / #180）。
后续真机验收路径应当是「安装完成后查询已安装列表，核对目标包名与版本」，
而不是发明一个不存在的协议阶段。该能力目前在 `core/src/` 中**尚无任何实现**。

---

## 5. 本次修改文件

| 文件 | 修改 |
|---|---|
| `core/src/install/xiaomi/runtime_bridge.rs` | 修正过早 Completed；新增安装管线激活门禁；把不实的“已接入”注释改为 `not implemented` / `placeholder` 标注 |
| `core/src/install/xiaomi/protocol.rs` | 安装结果新增目标包名校验 |
| `core/src/install/xiaomi/device_session.rs` | 标注 `send_install_packet` 为入队占位 |
| `core/src/live.rs` | 仅在安装管线激活时派发入站帧（1 处条件，未触碰认证逻辑） |
| `core/tests/app_install_test.rs` | 串行化全局队列测试；新增 3 个防回归用例 |
| `src/main/services/oronbox-bridge.ts` | 停用旧版装包通道，移除 `install.local` 调用点 |

未修改：`core/src/session.rs`、`core/src/rfcomm.rs`、蓝牙通信层、设备协议层、已有稳定 IPC。
未新建任何第二套蓝牙连接。

---

## 6. 提交前五问对账

1. **当前功能是否连接真实设备？** 否。安装链路未接入真实 socket，未连接真实手环。
2. **当前功能是否调用真实 Core？** 协议编解码在 Core 内真实存在；但安装 RPC 默认走 Mock 传输，
   未触达真实设备能力。
3. **当前是否存在 Mock？** 存在。`GLOBAL_INSTALL_TRANSPORT` 默认 `Mock`；
   `MockAppInstallTransport`、`MockBandDeviceTransport`、`MockDeviceSession` 仅用于离线测试。
4. **哪些状态仍只是占位状态？** `RuntimeBridgeState::Sending/Transferring/WaitingResult` 由入队动作驱动
   而非设备确认；`send_install_packet` 为入队占位；`RuntimeBridge` 无生产实例。
5. **下一阶段缺少什么能力？** ①把 `live::DownlinkCtx` 真实接入安装下行并统一加解密边界；
   ②合并/同步安装接收队列，使设备上报能被协议层看到；③Core RPC 装包路径显式标注或切换传输后端；
   ④取得真实安装抓包；⑤实现已安装列表查询作为安装后核对手段；⑥真机端到端验收。

---

## 7. 验证结果

- `cargo test --all`：30 + 72 passed，0 failed
- flaky 复测：`app_install_test` 连跑 40 次，0 失败（修复前 1/40）
- `npm test`：88 passed，0 failed（exit 0）
- `npm run build`：通过（exit 0）
- `git diff --check`：无空白错误

---

## 8. 后续更新：生产接线已建立（2026-09-10 第 2 轮）

本节记录在上文审计之后完成的接线工作，**上文第 1 节"运行时不存在"的结论已被本节取代**。

已建立的真实路径：

```text
Renderer / Main
  ↓  device.app.install.* RPC
Core RPC (rpc.rs)
  ↓  --live 走 Core.install；--fake 走 GLOBAL_INSTALL_TRANSPORT(Mock)
XiaomiInstallTransport
  ↓
XiaomiInstallRuntimeBridge
  ↓
XiaomiInstallDeviceSession
  ↓  InstallWireSender
CoreBtInstallWire (live.rs)
  ↓  读取同一个 Arc<Mutex<Option<DownlinkCtx>>>（不复制 sock/enc_key/seq_out）
business_frame_payload + frame::encode + send_all
  ↓
RFCOMM
```

接收侧：

```text
rfcomm recv -> frame decode -> business decrypt (live.rs)
  -> [门禁开启时] dispatch 明文 L2 -> InstallFrameRouter -> install_response_queue
  -> wait_install_result
```

关键变化：
- `Core.bt` 改为 `Arc<Mutex<Option<DownlinkCtx>>>`，安装层持有同一句柄，仍是唯一连接。
- `XiaomiInstallDeviceSession::send_install_packet` 不再是入队占位：明文 L2 经
  `business_frame_payload` 加密、`seq_out` 真实递增后 `send_all` 写入 socket。
- 安装帧派发门禁只在安装进行中开启（`XiaomiInstallTransport` 的 4 个方法管理），
  空闲连接不复制业务帧；全局队列与普通消息队列都有上限。
- 安装成功后追加 `type=20 id=0` 已安装列表核验（package_name + version_code），
  只有同时命中才判成功。

仍未完成：
- 已安装列表请求体按真机抓包 Pkt #176 构造为空 ThirdpartyApp，响应解析字段已实证；
  但"查询请求需要携带哪些字段设备才会应答"未在真机上确认。
- `core/src/session.rs:179` 仍以 `"OronBox"` 作 companion 名（冻结文件，未改）。
- Mass 分片编码与上游源码证据不一致（见第 9 节），是当前真机安装失败的直接原因。

---

## 9. 第一次真机安装实测（2026-09-10，小米手环 10）

### 9.1 结果

链路推进到**分片全部下发完毕**，但设备始终未上报安装结果，`commit` 以 `unknown` 结束。

关键日志（真实设备 `core.log` 原文摘录）：

```text
install: prepare 开始 package=com.codeisland.band version_code=26 file_size=255523
install: 下行 seq=2 明文=36B 帧=46B
（prepare 成功 —— 否则不会有后续分片，说明手环应答了 type=20 id=1）
install: chunk #499/500 已下发 (累计 255523B)     ← 500 片全部发出，字节数等于完整文件
install: 下行 seq=237 明文=41B 帧=51B
install: commit 开始，等待设备 id=2 安装结果
install: commit 结束 status=unknown              ← 5 秒内没有任何 id=2
```

上一轮 `prepare` 因业务帧被前置 L2 前缀 `01 01` 而超时；去掉前缀后（`ffa4835`）
`prepare` 一次通过，明文长度从 38B 变为 36B。

### 9.2 本轮已确认（真机实证）

| 结论 | 依据 |
|---|---|
| WearPacket 业务明文**不带** L2 前缀 | 去前缀后手环立即应答 id=1 |
| `seq_out` 真实递增、下行真实写入 socket | 日志 seq 连续，累计字节数与会话计算一致 |
| 500 片分片全部下发 | `累计 255523B` = 文件大小 |
| 设备**未**上报 id=2 | `commit 结束 status=unknown` |

### 9.3 当前 Mass 分片实际发出的字节

```text
L2 头:   02 01
分片头:  total_parts[u16 LE] | current_part[u16 LE]   (current_part 从 1 开始)
分片体:  原始 RPK 文件切片（512 字节），无附加头、无 CRC32
```

与上游源码证据的包体结构不一致。`core/src/install/xiaomi/mass.rs` 里**已经实现了正确的
包体构造函数** `build_mass_inner_payload()`：

```text
00 | 0x40 | MD5[16] | file_length[u32 LE] | file_bytes | CRC32[u32 LE]
```

它有测试覆盖（`test_38_mass_inner_payload_crc32_and_validation`），
**但安装流程从未调用它**——只有测试在用，分片体直接用了原始文件字节。

另有三处与上游流程不一致：

1. **未等待/校验 Mass Prepare 响应**：源码流程要求 Mass 准备后检查 READY、分片长度与续传响应；
   当前发完 Mass Prepare 立即开始发分片。
2. **未等待逐片 SAR ACK**：源码中"进度来自 SAR ACK 消费"，当前是盲发。
3. **`expected_slice_length` 未被使用**：已从 id=1 响应解析并存入协议状态，
   但分片尺寸固定按客户端 512 字节块切分。

### 9.4 未验证的假设（禁止当作事实）

- 分片是否真的需要 L2 头 `02 01`：Pb 通道已实证**不需要**前缀，Mass 是否不同未知。
- 包体头 `00|40|MD5|length` 是只在第 1 片携带，还是先拼出完整 body 再整体切片。
- `total_parts` 按组装后的 body（文件 + 26 字节头尾）计算，还是按原始文件长度计算。
- Band 10 走 `mass_transfer.dart` 的常规分支还是 SPP v1 分支。
- Mass ACK 的线上格式与发送窗口。

**结论：本轮不修改 Mass 编码。** 以上假设缺可核验依据，按代码纪律不允许猜测实现；
需先取得 `mass_transfer.dart` 的确切语义或一次真实安装抓包。

---

## 10. 按上游源码语义修正 Mass 传输（2026-09-10 第 2 轮）

第 9 节的未验证假设已由**上游固定提交 `26dd89e7` 的源码**确认（读取源码，非实机验证）。
以下四项差异已全部修正：

### 10.1 四处实质差异与修正

| # | 差异 | 修正 |
|---|---|---|
| 1 | Mass 分片被套上 `01 02` + AES-128-CTR 业务加密 | 新增 `send_plain_payload` 通道：Mass 载荷**不加密**，直接是 `02 01 | 片头 | fragment` |
| 2 | 分片体是裸 RPK 文件字节，缺 `00\|40\|MD5\|file_length` 头与 CRC32 | 改为 `build_mass_inner_payload` 组装完整 body 后**整体切片** |
| 3 | `data_id` 与 body 内 MD5 用的是 SHA-256 前 16 字节 | 客户端新增 `calculateFileMd5`，core 侧 `resolve_md5` 显式取真实 MD5；缺失即报错，不再截断摘要 |
| 4 | 分片盲发，不等 Mass 响应也不等 ACK | 发分片前等 Mass PrepareResponse(READY) 并取其 slice 长度；分片按 32 窗口 + 累积 ACK 流控 |

### 10.2 关键协议事实（源码确认）

- **Pb 的外层 `01 02` 本身就是 L2 头**（channel=protobuf, opcode=writeEnc），
  所以加密明文内不应再有 L2 头 —— 这与第 9 节真机修复一致。
- **Mass 的 `02 01` 在同一层**（channel=mass, opcode=write），但**该分支不加密**。
- body：`00 | 40 | MD5[16] | file_length(u32LE) | 完整RPK | CRC32(u32LE)`，
  CRC32 覆盖其前方全部内容，外层 Frame 的 CRC16 独立计算。
- 分片：`total_parts(u16LE) | current_part(u16LE) | fragment`，片号从 1 开始；
  `fragment` 上限 = `expected_slice_length - 6`（2B L2 + 4B 片头）；
  `total_parts` 按**组装后的 body 长度**计算，不是文件长度。
- `expected_slice_length` 取值优先级：显式传入 → Mass PrepareResponse.field5 → 非 SPP v1 默认 244。
  `AppInstallerResponse.field2` 存在但该路径不传给 Mass 发送器。
- ACK 是 **L1 控制帧**（`A5 A5 | 01 | seq | 00 00 | 00 00`），不带 L2，走的是 Frame 的 **8 位 seq**，
  与 Mass 的 16 位 `current_part` 不是一回事；采用**累积确认**（模 256 半区间比较）。
- 发送窗口 32 是**客户端策略**（上游本地 `_localTxWin=32`），不是设备协商结果。
- Band 10（`o66`/`o66nfc`）在设备目录中属于 **sppV2**，走非 SPP v1 分支；SPP v1 使用 `BA DC FE` 前导，与本项目已验证的 `A5 A5 + 01 02 + CTR` 不同。
- 安装结果等待超时为 60 秒（本项目原先 5 秒）。

### 10.3 未改变的设计

- 不新增 verify/commit opcode；安装成功仍以 `id=2` + `id=0` 已安装列表核验为准。
- `02 01` 与 Frame 封装保持不变；未引入 OronBox 依赖。

### 10.4 仍需真机验证的点

- 上述全部为**源码语义**，本机固件是否一致未验证。
- 分片是否真的走 `02 01` 这一层、Mass PrepareResponse 的实际字段取值、
  设备对 32 窗口的接受程度、ACK 的实际到达时序，都需要一次真机安装来确认。
- 本轮改动使「客户端到设备的字节」与上游分支一致，若仍失败，下一步应先抓 Mass PrepareResponse，
  而不是继续调整后续参数。

---

## 11. 真机安装成功（2026-09-10，第 3 轮）

### 11.1 结果

**Pulse 自研 core 首次完成小米手环 10 的 RPK 快应用真实安装**，全程不依赖 OronBox。
`status=completed` 来自设备真实上报的结果与已安装列表核验，不是本地推断。

真实设备 `core.log` 原文：

```text
install: Mass 下行 seq=66 明文=1975B 帧=1983B (未加密)
install: Mass 传输完成 body=255549B 分片=63 slice=4096 cap=4090
install: chunk #499/500 已下发 (累计 255523B)
install: commit 开始，等待设备 id=2 安装结果
install: 入站 seq=9 type=20 id=2 len=67                 ← 设备上报安装结果
install: 下行 seq=67 明文=7B 帧=17B                     ← 下发 id=0 已安装列表查询
install: 入站 seq=10 type=20 id=0 len=130
install: 已安装列表返回 2 项，目标 package=com.codeisland.band version_code=26 命中=true
install: commit 结束 status=completed
```

### 11.2 本轮由设备实证、可升级为事实的数据

| 项 | 之前 | 真机实测 |
|---|---|---|
| `expected_slice_length`（Band 10） | 未知，上游默认 244 | **4096**（来自 Mass PrepareResponse.field5，cap = 4090） |
| Mass body 长度 | 推算 255549B | **255549B**（255523 + 22B 头 + 4B CRC32），与推算一致 |
| Mass 分片数 | 按 slice 假设 500/506/1074 | **63** |
| 分片是否需要 `02 01` | 源码证据 | **需要**，且确认为未加密通路 |
| 安装结果等待耗时 | 上游 60s | 约 **3 秒** |
| 已安装列表条目 | 抓包 2 项 | **2 项**，目标包 `com.codeisland.band` versionCode 26 命中 |

`slice=4096` 这条尤其重要：若沿用上游非 SPP v1 的 244 默认值，会产生 1050 片而不是 63 片。
**必须使用 Mass PrepareResponse 返回的 slice 长度**，这一点已由真机证实。

### 11.3 达成路径（本轮两个修复共同作用）

1. `ffa4835`：去掉 Pb 业务明文里多余的 L2 前缀 → 设备开始应答 `id=1`。
2. `0fadb88`：按上游源码语义修正 Mass（不加密 / 组装 body 整体切片 / 真实 MD5 /
   等 PrepareResponse / 累积 ACK 流控）→ 分片被接受、设备上报 `id=2`。

### 11.4 仍未确认

- **手环端可用性**：已安装列表命中只证明"设备记录了这次安装"，不等于"快应用能启动运行"，
  仍需在手环上手动打开一次确认。
- 断点续传（`remained_data_length` 语义）未验证；本轮按不续传处理。
- 安装失败 / 空间不足 / 校验失败时的设备错误码与回滚行为未验证。
- `core/src/session.rs:179` 仍以 `"OronBox"` 作 companion 名（冻结文件，未改）。
