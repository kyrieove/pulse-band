# 表盘安装协议证据与 Antigravity 交接

审计日期：2026-09-11。结论：已找到可核验的表盘协议源码证据；Pulse 当前**没有任何表盘能力**；本次未做真机验证，未修改运行代码，未提交 Git。

本交接单与 `antigravity-install-handoff-20260910.md`（RPK）配套阅读。Mass 传输的通用格式、SPP 版本分支、不应照搬的上游行为，那份文档已写清楚，本文不重复，只记表盘特有的差异。

---

## 1. 直接推进的依据

本机 `C:/dev/_oronbox-src`，HEAD 为 `26dd89e7ceea153cb6258660790a20e5e4675cb0`。该版本与本项目 `docs/protocol/auth.md`、`business.md` 已引用的一致。OronBox 为 AGPL-3.0：**只引用与分析，不复制实现到 Pulse。**

表盘相关源码入口（均在上述固定版本内）：

| 文件 | 作用 |
|---|---|
| `protos/xiaomi/wear_watch_face.proto` | 表盘全部消息与枚举定义 |
| `lib/src/device/xiaomi/components/install_system.dart` | `installWatchface()`（第 101 行起）实际安装编排 |
| `lib/src/device/xiaomi/components/watchface_system.dart` | 设当前表盘 / 删除 / 编辑 / 查询支持数据 |
| `lib/src/protocols/xiaomi/packet/mass_packet.dart` | `MassDataType` 枚举与 Mass 包体 + CRC32 |
| `lib/src/device/core/watchface_install_policy.dart` | Vela 表盘 ID 提取与受限 ID 策略 |
| `lib/src/data/bandbbs/bandbbs_resource_provider.dart` | 社区表盘资源来源（bandbbs.cn） |
| `protos/xiaomi/wear.proto` | WearPacket 外层 type 与字段号 |

---

## 2. Pulse 实际调用链及能力分级

```text
Renderer          [missing]  无表盘入口（设计规范明确禁止未完成功能的入口）
  ↓
Preload           [missing]
  ↓
Main Service      [missing]
  ↓
Core RPC          [missing]
  ↓
Hardware Protocol [missing]  WearPacket 枚举已含 WatchFace=4，但载荷字段 6 未实现
  ↓
Device            [unknown]  本次未做任何表盘实验
```

### 已核实可复用的部分（读代码确认，非推测）

- `core/src/install/xiaomi/mass.rs:12` 已有 `MASS_DATA_TYPE_THIRDPARTY_APP = 64`；同文件内 `PrepareRequest` / `PrepareResponse` / `MassChunk` / `MassAck` 都是**类型无关**的（data_type 是字段），可直接复用。
- `core/src/install/xiaomi/wear_packet.rs:18` 的 `WearPacketType` 枚举**已经包含 `WatchFace = 4`**（`from_u32` 与 `as_u32` 均覆盖）。
- 认证、RFCOMM、业务帧封装、Mass 分片与 ACK 等待、安装运行时桥接均已存在并在真机验证过（RPK 安装闭环）。

### 已核实缺失的部分（读代码确认）

- `wear_packet.rs` 的 `WearPacket::encode/decode` **只处理字段 22**（`ThirdpartyApp`）；字段 6（`watch_face`）未实现。
- `mass.rs` 无 `watchface` 类型常量（上游值 16）。
- `device_session.rs:114` 的 `is_wear_packet_install()` 硬编码 `WearPacketType::ThirdpartyApp => wp.id == 0 || 1 || 2`，没有 `WatchFace` 分支。
- `core/src/main.rs` 只有 `--probe` / `--auth` / `--live` / `--fake`，没有安装类 CLI。
- 全仓库 grep `表盘` / `watchface`，运行代码零命中；仅设计文档提到"以后可加"，且**明确禁止先放不可用入口**（`docs/design/pulse-2.0-design-system.md:34`、`docs/design/pulse-2.0-screen-spec.md:78`、`docs/superpowers/specs/2026-09-09-pulse-2.0-redesign-design.md:56`）。

---

## 3. 可替代"完全未知"的源码证据

以下均为 **source-backed / device-unverified**，不得标为本项目实机确认。

### 3.1 外层信封

| 项目 | 源码值 |
|---|---|
| WearPacket type | `WATCH_FACE = 4`（对比 RPK 的 `THIRDPARTY_APP = 20`） |
| WearPacket 载荷字段 | `watch_face = 6`（对比 RPK 的 `thirdparty_app = 22`） |
| Mass 传输 | 与 RPK **同一套** `_sendMassAndWaitResult`，仅 `dataType` 与结果 type/id 不同 |

**type=4 与 field=6 属于不同层级，切勿混淆。**

### 3.2 WatchFaceID 枚举（`wear_watch_face.proto`）

| id | 名称 |
|---:|---|
| 0 | GET_INSTALLED_LIST |
| 1 | SET_WATCH_FACE |
| 2 | REMOVE_WATCH_FACE |
| 3 | REMOVE_WATCH_FACE_PHOTO |
| 4 | PREPARE_INSTALL_WATCH_FACE |
| 5 | REPORT_INSTALL_RESULT |
| 6 | REMOVE_MULTI_WATCH_FACE |
| 10 | GET_SUPPORT_DATA |
| 11 | EDIT_WATCH_FACE |
| 12 | BG_IMAGE_RESULT |
| 13 | FONT_RESULT |

### 3.3 安装流程（`install_system.dart:101` `installWatchface`）

1. 本地检查受限 ID（见 §4），命中则直接抛错，不发包。
2. **改写文件** `fileData[0x28 .. 0x28+12]` 为 12 字节、右补零的 ASCII 表盘 ID。
3. 发 `type=4, id=4`，`watchFace.prepareInfo = PrepareInfo{ id, size, versionCode }`；上游 `versionCode` 固定 `65536`。
4. 校验 `watchFace.prepareStatus == READY(0)`，否则报错。
5. 走 Mass 传输，`dataType = watchface(16)`，等待 `type=4, id=5` 的结果。
6. 成功判定：`installResult.code` 为 `INSTALL_SUCCESS(2)` **或** `INSTALL_USED(3)`。

### 3.4 关键结构

| 结构 | 字段 |
|---|---|
| `PrepareInfo` | 1 id(string)、2 size(uint32)、3 version_code(uint64)、4 support_compress_mode(uint32)、5 verification{ info, sign, trial_duration } |
| `PrepareReply` | 1 id、2 prepare_status、3 select_compress_mode、4 expected_slice_length |
| `InstallResult` | 1 id、2 code（0 VERIFY_FAILED / 1 INSTALL_FAILED / 2 INSTALL_SUCCESS / 3 INSTALL_USED）、3 support_edit、4 support_image_format |
| `WatchFaceItem` | id、name、is_current、can_remove、version_code、can_edit、background_color、background_image、style、data_list、support_image_format… |

### 3.5 Mass 数据类型（`mass_packet.dart`）

`watchface = 16`、`firmware = 32`、`watchfaceImage = 48`、`notificationIcon = 50`、`music = 52`、`watchfaceFont = 53`、`thirdPartyApp = 64`。

### 3.6 自定义表盘（另一条路径，可能更简单）

`EDIT_WATCH_FACE = 11` + `EditRequest` / `EditResponse` / `BG_IMAGE_RESULT = 12` / `FONT_RESULT = 13` 允许修改**已安装**的表盘：`background_color`、`background_image`、`style`、`data_list`（显示哪些数据）、`slot_item_list`。

`WatchFaceSlot.Data` 枚举：HEART_RATE=1、PRESSURE=2、SLEEP=3、ENERGY=4、STEP=5、CALORIE=6、VALID_STAND=7、BATTERY=8、DATE=9、WEATHER=10、AIR_PRESSURE=11、ALTITUDE=12、TIMER=13、CLOCK=14、AQI=15、HUMIDITY=16、SPORT_MODE=17、UVI=18、SUNRISE_SUNSET=19、WIND_DIRECTION=20。

这条路**不涉及整包签名**，只需要图片数据，风险显著低于路径 B。**建议优先评估。**

---

## 4. 已知风险与不可照搬项

- `restrictedWatchfaceIdPrefix = '1209'` 是**上游自加的策略**，不是设备限制。上游为此写了 `WatchfaceInstallBlockedException`。其存在暗示某类 ID 涉及付费或版权内容。
- `PrepareInfo.verification{ info, sign }` 存在于 schema，但上游安装时**没有填**（只填 id / size / versionCode）。即上游按**未签名**路径走。**手环是否对所有表盘放行，完全未知，必须实测。**
- 上游 `versionCode` 固定 `65536`、RPK 那边固定 `114514`——这些是上游策略，**不能当作协议要求**。
- 上游会在传输前**改写文件头 0x28 处 12 字节**。这是有副作用的文件修改。Pulse 若自制表盘需自行决定 ID 并保留原始文件摘要。
- 表盘文件来源（bandbbs.cn）可能涉及**账号、付费与版权**。下载行为与再分发需自行判断合规性，不得把来源不明的文件纳入仓库。
- 上游 `installWatchface` 的成功码允许 `INSTALL_USED`。语义（已存在/已使用）未查明，报告时不得合并进 "SUCCESS"。

---

## 5. 必须纠正的认知

- **表盘 ≠ RPK**：不同 WearPacket type（4 vs 20）与不同载荷字段（6 vs 22）。RPK 安装能力**不能等同于**表盘安装能力。
- **装上 ≠ 可用**：`PREPARE_INSTALL_WATCH_FACE` 成功只代表文件写入。`SET_WATCH_FACE`(id=1) 是另一条命令。两者必须分开验收。
- **"已安装列表"里出现 ≠ 当前表盘**：`WatchFaceItem.is_current` 才是当前表盘标记。
- **表盘是本地运行的**：设为当前后，手环不需要 PC 保持连接也能正常显示。这与 Pulse 的实时状态推送本质不同。**但导入动作本身仍受单连接槽约束**——手环连着小米运动健康时 PC 连不上（本项目 2026-09-10 实测，见 `future_version/STATUS.md` 已知限制）。
- **现有三份 pcapng 从未按 type=4 检索过**。`antigravity-install-handoff-20260910.md` §4 的筛查只覆盖 type20/type22。若要找表盘流量的历史证据，需要重新筛查，且不得把 `synthetic_bench_capture` 样本当真实证据。

---

## 6. Antigravity 下一步任务

1. **先做只读**：实现并真机验证 `GET_INSTALLED_LIST`（type=4, id=0）。零副作用，能同时证明信封编码、type 与字段 6 的正确性。**这一步不通过就不要碰安装。**
2. 只读通过后，再实现 `PREPARE_INSTALL_WATCH_FACE`，检查 `prepare_status`，失败与超时按 unknown 记录。
3. **再考虑** `SET_WATCH_FACE`（切换当前表盘）——它比整包安装风险低，且能独立验证"表盘能否生效"。
4. 文件来源必须逐项记录：下载 URL、SHA256、原始字节数、获取时间。不得预造"真实"样本，不得把构造数据登记为真实抓包。
5. **不得修改** `core/src/live.rs`、`core/src/session.rs`、`core/src/rfcomm.rs` 及已有稳定 IPC。新增独立模块，复用现有认证与 Mass 通道，不新建第二套连接。
6. 真机前提：手环需进入 **设置 → 系统操作 → 连接新手机**（这是本项目已验证的 PC 连接前提，见 `docs/故障排查.md`）。测试前确认没有 pulse-core / 其它客户端占着链路。
7. 结果判定**只能依据 `REPORT_INSTALL_RESULT` 的 code**。传完字节数不算成功，收到 ACK 不算成功，`prepare_status=READY` 不算成功。
8. 安装后用 `GET_INSTALLED_LIST` 核验并存，与 `SET_WATCH_FACE` 的结果**分开报告**。
9. 日志与文档不得输出 authkey、MAC、会话密钥、表盘文件的作者信息。表盘原始文件进仓库前必须单独做版权与敏感信息审查。

---

## 7. 本次交付对账

- **Implemented**：完成表盘协议的上游源码审计，定位到可复用的传输层与缺失的具体编码点；仅新增本交接文档。
- **Mock / Placeholder**：无。本次未新增任何模拟实现或占位状态。
- **Not implemented**：表盘列表、安装、设置、编辑、删除；`wear_packet.rs` 字段 6 编解码；`mass.rs` 的 watchface 类型常量；`device_session.rs` 的 WatchFace 分支。
- **Next step**：按 §6 顺序推进，先只读列表，再安装，最后切换。

**五问对账**：

1. 当前功能是否连接真实设备？否，本次只读源码。
2. 当前功能是否调用真实 Core？否，未启动 Core。
3. 当前是否存在 Mock？否，本次未新增。
4. 哪些状态仍然只是占位状态？表盘全部能力缺失，不是占位而是不存在。
5. 下一阶段缺少什么能力？字段 6 编解码、watchface Mass 类型、WatchFace 消息集、真机验证（尤其未签名表盘是否被接受）。

**验证范围**：源码读取、协议结构比对、Pulse 侧代码审计、敏感词检查。本次不修改运行代码、不提交 Git、不重跑 `npm test` / `npm run build` / `cargo test`；此前测试通过状态未在此重新认证。
