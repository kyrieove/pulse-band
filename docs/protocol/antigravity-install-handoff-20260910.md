# RPK 安装协议证据与 Antigravity 交接

审计日期：2026-09-10。结论：已找到可核验的安装协议源码；未取得真实安装抓包，未实现或验证 Pulse 原生安装。

## 1. 直接推进的依据

本机已有 `C:/dev/_oronbox-src`，HEAD 为 `26dd89e7ceea153cb6258660790a20e5e4675cb0`，本次 `git status --short` 无变更。该版本也是 Pulse 的 `docs/protocol/business.md` 已引用的来源。本次通过 GitHub API 确认其公开提交存在。

核心实现并非仅有接口：`XiaomiInstallSystem.installApp` 实际构造准备请求、等待 READY、调用 Mass 传输、等待设备安装结果并检查结果码。

固定版本源码入口：

- [安装编排与结果检查](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/device/xiaomi/components/install_system.dart#L35)
- [Mass 调度与 SPP 版本分支](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/device/xiaomi/components/mass_system.dart)
- [Mass 协商、分片及 ACK 等待](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/protocols/xiaomi/transport/mass_transfer.dart)
- [Mass 包体与 CRC32](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/protocols/xiaomi/packet/mass_packet.dart)
- [L2 通道与操作码](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/protocols/xiaomi/packet/l2_packet.dart)
- [安装 protobuf](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/protos/xiaomi/wear_thirdparty_app.proto)
- [Mass protobuf](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/protos/xiaomi/wear_mass.proto)

交叉核对来源：AstroBox-NG 的公开 Pb 模块，版本 `03a92010056dd41af114f6f46fd612104b27bd7b`：

- [wear.proto](https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb/blob/03a92010056dd41af114f6f46fd612104b27bd7b/protos/xiaomi/wear.proto)
- [wear_thirdparty_app.proto](https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb/blob/03a92010056dd41af114f6f46fd612104b27bd7b/protos/xiaomi/wear_thirdparty_app.proto)
- [wear_mass.proto](https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb/blob/03a92010056dd41af114f6f46fd612104b27bd7b/protos/xiaomi/wear_mass.proto)
- [wear_common.proto](https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb/blob/03a92010056dd41af114f6f46fd612104b27bd7b/protos/xiaomi/wear_common.proto)

两套 schema 的一致性只能加强源码证据，不等于两次独立实机验证。OronBox 为 AGPL-3.0；本次仅引用与分析，没有复制实现到 Pulse。

## 2. Pulse 实际调用链及能力分级

```text
Renderer          [implemented] InstallAppStep 调用 appInstall
  ↓
Preload           [implemented] pulse:app-install:* IPC
  ↓
Main Service      [implemented] AppInstallService → CoreAppInstallBridge
  ↓
Core RPC          [implemented] rpc.rs → GLOBAL_INSTALL_TRANSPORT
  ↓
Hardware Protocol [missing]     默认 Mock；设备模式无真实安装协议/设备适配
  ↓
Device            [unknown]     本次未进行在线设备或安装实验
```

- [A] 已有真实文件处理、既有 RPC 分发实现；本次未重新运行这些业务。
- [B] 安装总体链路部分实现，停在 Core 安装后端。
- [C] 真实安装方向有 AppInstallProtocol、BandDeviceTransport 接口。
- [D] XiaomiAppInstallProtocol 与安装用真实设备适配缺失。

`core/src/install/transport.rs` 默认 `new_mock()`；`new_device()` 产生的适配器没有 protocol/device_transport。既有认证及快应用互联能力不能等同于安装能力。

## 3. 可替代“完全未知”的源码证据

以下均为 **source-backed / device-unverified**，不得标为本项目实机确认。

| 项目 | 源码值及结构 |
|---|---|
| 安装准备 | WearPacket.type=20，id=1；WearPacket.field22 → ThirdpartyApp.field2 → AppInstaller.Request |
| 准备参数 | Request.field1=package_name(string)，field2=version_code(uint32)，field3=package_size(uint32) |
| 准备响应 | ThirdpartyApp.field3；Response.field1=prepare_status，field2=expected_slice_length(optional) |
| READY | PrepareStatus.READY=0；BUSY=1，LOW_STORAGE=3，LOW_BATTERY=4 等定义见 wear_common.proto |
| Mass 准备 | WearPacket.type=22，id=0；WearPacket.field24 → Mass.field1 |
| Mass 参数 | PrepareRequest.field1=data_type，field2=data_id(bytes)，field3=data_length；OronBox 使用 data_type=64、原始 RPK 的 MD5 作为 data_id |
| Mass 响应 | Mass.field2 → PrepareResponse；包含 data_id、prepare_status、可选压缩模式、remained_data_length、expected_slice_length |
| 安装结果 | WearPacket.type=20，id=2；ThirdpartyApp.field4 → AppInstaller.Result |
| 结果码 | Result.field1：INSTALL_SUCCESS=0、INSTALL_FAILED=1、VERIFY_FAILED=2；另有 package_name 或 app_item |
| Mass 控制 | Mass.id=1；MassControl.op：PAUSE=1、CANCEL=2、ERROR=3；仅 schema 证据，取消后设备状态仍待验证 |

`type=22` 和 `field22` 属于不同层级，切勿混淆。SEND_PHONE_MESSAGE 的 id=8 是应用互联消息，不是已找到的安装准备命令。

源码中的通常流程：

```text
准备安装(type20/id1) → 检查设备 READY
  → 先注册安装结果监听
  → Mass 准备(type22/id0，data_type64，MD5，长度)
  → 检查 READY、分片长度与续传响应
  → Mass 分片 → 等待对应 SAR 序号 ACK
  → 等待安装结果(type20/id2) → 检查结果码与目标包
```

源码没有要求按 Pulse 的五个 trait 方法分别发出五条硬件命令。特别是独立 verify/commit 指令，当前证据没有确认存在，不能为了适配接口而发明。

### Mass 编码与适用边界

OronBox 非 `sppV1` 分支在 `mass_transfer.dart`：

- L2 channel=2 (mass)，opcode=1 (write)。这不是 protobuf 的加密 channel=1/opcode=2。
- 不续传时包体为 `00 | 40 | MD5[16] | file_length[u32 LE] | file_bytes | CRC32[u32 LE]`。CRC32 覆盖其前方完整包体，外层仍另有 Frame CRC16。
- 每片含 `total_parts[u16 LE] | current_part[u16 LE] | fragment`，片号从 1 开始。
- 此实现的 fragment 上限为 `expectedSliceLength - 6`，包含 L2 两字节及片头四字节开销。
- 进度来自 SAR ACK 消费，全部分片 ACK 完成仍不能视为安装成功。
- `mass_system.dart` 另有 SPP v1 分支，禁止不识别协议版本就套用上述格式。
- 常规分支缺省 slice 为 244，SPP v1 分支缺省为 2048。这些是上游策略，不能称为 Band 10 已实测参数；Pulse 目前 512 字节文件块也不是硬件协商结果。
- 上游把 `remained_data_length` 用作已保留字节数，字段名称容易误读。首次实机实验优先完整传输；续传偏移及压缩行为另行核验。

### 不应照搬的上游行为

- install_system.dart:46 把 versionCode 固定为 114514，包名还有默认值。Pulse 应保留真实 manifest 数据，不能把此常量解释为协议要求。
- install_system.dart:427 在传文件前安装结果监听，避免快响应丢失。最终必须核验响应目标及结果，不能只收到 id=2 就成功。
- 超时是失败/未知结果，不能按传完字节数生成 installed。
- AstroBox-Public 老版 thirdpartyapp.rs 含 `__OPENSOURCE_DELETED__`，不适合作为可直接运行的完整实现。

## 4. 已有真实抓包审计

本次实际复用 `tools.verify_auth.frames`、`tools.decrypt_business.derive_keys` 与既有 AES-CTR 解码流程，在内存中读取本机既有认证材料。只输出计数、消息 type/id 和安装候选包号，没有输出密钥、明文业务内容或设备标识。

| 文件 | CRC 通过的重组 Frame 数 | type20/id1或2 | type22 | L2 mass 候选 |
|---|---:|---:|---:|---:|
| baseline-2026-09-08-01.pcapng | 304 | 0 | 0 | 0 |
| baseline-2026-09-08-02.pcapng | 116 | 0 | 0 | 0 |
| fetchevidence-2026-09-09.pcapng | 298 | 0 | 0 | 0 |

合计 718 个 Frame；这不是 Wireshark 原始数据包总数。所有 `type03/prefix0102` 业务候选完成解码和顶层 type/id 读取。Mass 候选检测为 type03 且 L2 首字节 02。此审计仅覆盖现有 RFCOMM 提取器及本项目已验证的业务封装，不证明所有未知封装不存在安装流。

文件 SHA256 本次重新计算，与 business.md 完全一致：

```text
baseline-2026-09-08-01.pcapng 2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099
baseline-2026-09-08-02.pcapng 3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377
fetchevidence-2026-09-09.pcapng a2624ebbe4c1e5dde0227df183124814f1f4f30b0de75855b2940dde2a60cef7
```

`capture_sample_001/metadata.json` 的 source 为 synthetic_bench_capture；清单样本也为 synthetic_template，不能转名为 capture_real_install_001。

## 5. 必须纠正的认知

- `app-install-analysis.md` 把 ECDH/Curve25519 与所有业务 AES-CCM 列为已确认，与已有 auth.md、business.md、live.rs 不一致。本项目既有业务证据使用 AES-128-CTR；认证中的 CCM 不能推广为所有业务帧。应优先沿用已逐帧验证的认证与业务实现。
- SHA256 可继续作为本地文件完整性标识，但不能替代上游 Mass 使用的 MD5。
- 原始 HCI/RFCOMM 包可能包含加密业务；对密文直接做 protobuf wire 探测无法得到安装语义。
- CaptureLoader 当前读取 Recorder JSON，不是 btsnoop/pcapng 导入器。原始链路记录需先重组及识别封装，再关联解密分析。
- Recorder.record 会重新计算 payload CRC。因此经脱敏重写后通过 CRC，只证明改写产物一致，不证明原始抓包无误。保留原始文件本地摘要及变换说明，不把明文替换成密文帧 payload 并声称是真实线上字节。
- SampleValidator 的文本扫描不等于对二进制 payload 完成敏感信息检测；真实样本入库需单独审计。

## 6. Antigravity 下一步任务

1. 先读取上述固定版本源码和本项目 auth.md、transport.md、business.md；把协议表标记为源码证据、设备未验证。无需先做 CaptureDiffAnalyzer 等新抽象。
2. 在离线范围对接最小编码/解码与状态转换：准备失败、Mass 失败、ACK 超时、设备结果失败、提前结果通知均应有负例。来源于源码构造的测试数据必须标为 synthetic/source-derived，不能登记成真实抓包。
3. 保持现有 RPC/Main/Preload；不得新建 RPC client，不修改 live.rs、session.rs、rfcomm.rs 或稳定 IPC。先给出真实适配所需最小接口差距，硬件接入另按项目授权执行。
4. 取得一次独立安装实验：若必须是官方 App 来源，需要 Android 手机上的 Mi Fitness 实际发起安装并采集 HCI/应用层记录；本次未找到可调用的 adb，也未验证手机连接。若目的是验证桌面安装协议，可用已经可用的 OronBox 发起一次受控安装并复用现有 PC 抓包链路，来源必须写 OronBox，不能写 Mi Fitness。
5. 抓包应覆盖连接认证开始、安装准备双向响应、Mass 协商、首尾片和 ACK、最终安装结果、安装后列表；同时记录实际型号、固件、安装器版本、RPK 摘要与版本、操作起止时间、设备端观察。不能只捕获已经结束的会话尾部。
6. 验收实际安装结果与目标包名/版本；若要验收可用性，再启动设备上的应用。只有这一步取得真实证据后，才将特定场景认定为实机通过。
7. 完成原始证据保留、脱敏和字段关联后，再生成 capture_real_install_001 的 metadata.json、frames.json、analysis.md；当前不要预先创建“真实”空样本。

## 7. 本次交付对账

- **Implemented**：完成协议源码审计与三份既有抓包的离线筛查，提供可直接定位的命令、schema、传输及结果证据；仅新增本交接文档。
- **Mock / Placeholder**：Pulse 安装默认 Mock 与真实设备适配占位维持原状；本次未新增任何模拟成功状态。
- **Not implemented**：真实安装抓包、Pulse 原生安装协议、设备安装适配及实机安装验证。
- **Next step**：基于来源明确的 schema 推进离线实现，并采集一次独立安装会话，核验设备特定差异。

五问：本次连接真实设备？否。调用真实 Core？未启动。存在 Mock？已有安装后端默认 Mock。占位在哪？设备安装适配及协议。缺少什么？真实安装会话、设备结果和经验证的适配接入。

验证范围：源码读取、公开来源交叉核验、实际离线抓包分析、文档差异与敏感词检查。本次不修改运行代码、不提交 Git，不重跑 npm test/build 或 cargo test；此前测试通过状态未在此重新认证。
