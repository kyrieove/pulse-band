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
- **未做真机安装验证**，整条链路只经离线测试与 Mock 链路验证。
- 已安装列表请求体按真机抓包 Pkt #176 构造为空 ThirdpartyApp，响应解析字段已实证；
  但"查询请求需要携带哪些字段设备才会应答"未在真机上确认。
- `core/src/session.rs:179` 仍以 `"OronBox"` 作 companion 名（冻结文件，未改）。
