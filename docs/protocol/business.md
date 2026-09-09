# 业务流协议取证与快应用互联契约（阶段 6A）

状态（2026-09-09）：**离线业务帧解密、快应用列表上报、包名路由已在两份抓包中实证。快应用互联（interconnect）与 fetch 消息结构目前仅是「基于公开 Protobuf 定义与客户端契约的推断模型」，不是抓包实证——现有两份抓包中没有捕获到任何 `type=20, id=8/9/7`（fetch / interconnect / 建链）帧，也没有手环运行时 fetch 数据流。因此现阶段不足以判定已闭环，阶段 6（额度往返）仍需一次真机 fetch 抓包取证后才能安全实现数据泵。**

本文档所有结论只有两种状态：带**复现三件套**并标「来源：自己抓包 · 2026-09-08」，或标「仍是假设」。脱敏：authkey、会话密钥、解密明文、真实用户数据一律用占位符，只记字段号/wire type/长度/取值类型。

---

## 1. 取证环境与工具

- **证据文件**：
  - `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng` (SHA256: `2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099`)
  - `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng` (SHA256: `3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377`)
- **分析工具**：
  - `tools/verify_auth.py`：认证与业务解密基准（`RESULT=PASS`，已验证）。
  - `tools/decrypt_business.py`：阶段 6A 专用业务流解密与结构 dump（AES-128-CTR，IV=方向密钥）。
- **公开依据来源（仅作字段名参考，不作为抓包事实）**：
  - OronBox commit `26dd89e7`：`protos/xiaomi/wear.proto`、`wear_thirdparty_app.proto`、`thirdparty_app_system.dart`、`interconnect_event_codec.dart`

---

## 2. 抓包中已确认的业务消息结构（来源：自己抓包 · 2026-09-08，两份独立抓包一致）

### 2.1 业务报文总体分布
在两份基线抓包中，除认证帧（`01 01`）与链路协商帧（`type=0x02`）外，所有 `type=0x03` 且以 `01 02` 开头的业务报文按 `WearPacket.type` 分布如下：

| WearPacket Type | 名称 / 模块 | 出现包号示例（会话 1 / 会话 2） | 核心特征与用途 |
|---|---|---|---|
| `type = 1` | ACCOUNT | 包 #127 / #122 | 账号信息交互（field 3） |
| `type = 2` | DEVICE_INFO | 包 #128, #129, #130, #148 / 包 #123~#125 | 设备状态同步与心跳 ping-pong（每数秒双向互发 `id=1`） |
| `type = 4` | FITNESS | 包 #166 (TX 8B), #173 (RX 1494B) / #162, #165 | 运动与健康数据聚合上报大包 |
| `type = 10` | WEATHER | 包 #160, #186, #188, #190, #191, #208 等 | 城市天气查询与逐小时预报下发 |
| `type = 20` | THIRDPARTY_APP | 包 #176 (TX 9B), #180 (RX 132B) / #168, #171 | 快应用管理与互联通信（核心） |
| `type = 23` | FACTORY_OR_EXT | 包 #157 / #150 | 扩展能力参数（13B） |

完成性说明：上述为**两份抓包中实际出现**的业务类型；不代表所有设备/所有会话都会出现。

---

## 3. 快应用（ThirdpartyApp）包名路由与消息结构

### 3.1 手环已安装快应用列表（AppItem.List）—— **来源：自己抓包 · 2026-09-08（已实证）**
- **命令原文**：
  ```powershell
  D:/2/software/python.exe tools/decrypt_business.py baseline-2026-09-08-01.pcapng
  ```
- **输出摘录**：
  ```text
  [Pkt #176] Host->Band (TX) | offset=436 | len=9B | THIRDPARTY_APP (id=0) [QuickApp Installed List Query/Response]
      WearPacket: type=20 (wire=0), id=0 (wire=0), payload_field=22

  [Pkt #180] Band->Host (RX) | offset=2028 | len=132B | THIRDPARTY_APP (id=0) [QuickApp Installed List Query/Response]
      WearPacket: type=20 (wire=0), id=0 (wire=0), payload_field=22
      field 1 [nested_proto, 121B]:
        field 1 [nested_proto, 63B]:
          field 1 [string, 22B]: "com.bandbbs.ebook.plus" (public identifier)
          field 2 [bytes, 20B]: <bytes:20B>
          field 3 [varint]: 260529
          field 4 [varint]: 1
          field 5 [string, 9B]: <printable_str:9B>
        field 1 [nested_proto, 54B]:
          field 1 [string, 19B]: "com.codeisland.band" (public identifier)
          field 2 [bytes, 20B]: <bytes:20B>
          field 3 [varint]: 26
          field 4 [varint]: 1
          field 5 [string, 5B]: "Pulse" (public identifier)
  ```
- **字段结构确认**（来源：自己抓包 · 2026-09-08）：
  - 外层：`WearPacket.type = 20` (`THIRDPARTY_APP`)，`id = 0` (`GET_INSTALLED_LIST`)。
  - 负载：`WearPacket` 字段 22 对应 `ThirdpartyApp`。内层 `ThirdpartyApp` 字段 1 对应 `AppItem.List`，含 repeated `AppItem`。
  - `AppItem` 字段：`field 1` = `package_name`（实测 `"com.codeisland.band"` / `"com.bandbbs.ebook.plus"`）；`field 2` = `fingerprint`（bytes, 20B，占位）；`field 3` = `version_code`（uint32，Pulse 为 26）；`field 4` = `can_remove`（1）；`field 5` = `app_name`（`"Pulse"`）。

### 3.2 快应用互联（interconnect）与 fetch 结构 —— **仍是假设（非抓包实证）**

依据公开源码（OronBox `wear_thirdparty_app.proto`、`thirdparty_app_system.dart`）+ 客户端契约（`docs/protocol/rpc-contract.md` §1.4 + `core/src/fake.rs`）推断的**协议模型**如下。**注意：这项未被本次抓包验证，因为现有抓包未捕获任何 `type=20, id=8/9/7` 帧。** 以下内容只作为下一步取证的假设方向，不得当作已确认事实：

- 快应用通道建链（Session Open）：
  - 手环端启动 Pulse 快应用 → 发 `WearPacket(type=20, field 22 → field 5 BasicInfo: {package_name:"com.codeisland.band", fingerprint})`；主机回 `type=20, id=7 (SYNC_PHONE_APP_STATUS)` → `field 22 → field 8 (PhoneAppStatus): {basic_info, status=CONNECTED(1)}`。
- 数据上行（Band → Host，如 fetch 请求）：`WearPacket(type=20, id=8 (SEND_PHONE_MESSAGE))` → `field 22 → field 9 (MessageContent)`：
  - `field 1 (basic_info)`：`{ package_name, fingerprint }`；
  - `field 2 (content, bytes)`：快应用明文 UTF-8 JSON；推断形状为 `rpc-contract.md` 的 fetch 请求 `{"tag":"fetch","id":"r1","url":"…/api/status/compact?all=1","options":{"method":"GET"}}`。
- 数据下行（Host → Band，如额度响应）：与上行对称，`type=20, id=8` → `field 9 (MessageContent)` → `field 2 (content, bytes)`。额度数据（`limits`/`pct5h`/`pct7d`/`resetText` 等）推断为直接嵌套在 `resp.body` 这个 JSON 字符串内，**不是独立 protobuf 字段**。此形状来自 `fake.rs` 与 `rpc-contract.md`，未经手环抓包核对。

> ⚠️ 3.2 两段均为推断模型，字段号/JSON 形状可能与实际不符，需以将来抓包实测为准。

---

## 4. 传输、分片与序号机制

1. **帧级封装与序号**（来源：自己抓包 · 2026-09-08，transport.md §6 已证）：帧格式 `A5A5 | type(0x03) | seq | len(2B LE) | crc | payload(01 02 + ciphertext)`；`seq` 单字节按方向各自自增；每收一个 `type=0x03` 帧须回一个 `type=0x01` ACK（`len=0`,`chk=0x0000`，seq 回显）。
2. **加解密重置**（来源：自己抓包 · auth.md 已证）：每条业务帧独立以当前方向 key 作为 IV 进行 AES-128-CTR，每帧重置 IV。
3. **分片需求** —— **仍是假设**：A5A5 帧头 `len` 为 16 位小端（上限 65535 字节），抓包实测健身帧单帧 1494B；**假设** fetch 额度响应（约 800~1000B）单帧可容纳、无需应用层分片。**此为估算，未经真实 fetch 帧验证。**

---

## 5. 阶段 6（额度往返）实现可行性判定

### 判定结论：**【尚不足以进入阶段 6B 实现数据泵；需先补一次真机 fetch 抓包取证】**

- **已具备（抓包实证/真机验证）**：
  1. 传输层帧结构、序列号回显、CRC-16/ARC、前导握手闭环；
  2. 会话认证状态机真机 3 次通过，稳定取得 `enc_key`/`dec_key`；
  3. 快应用包名 `com.codeisland.band` 及 20B 指纹已从真机抓包解出（type=20, id=0 列表）；
  4. 业务帧可解密（AES-128-CTR，IV=方向密钥）。
- **仍未验证（进入 6B 前必须补齐）**：
  1. **fetch / interconnect 帧（`type=20, id=8/9/7`）的真实结构与 content 编码** —— 现有抓包无此帧，仅为推断模型；
  2. 额度响应的确切封包形状（是否真如推断嵌套在 JSON `resp.body` 内，还是另有 protobuf 字段）；
  3. 快应用建链时序（是否需响应 `id=7` SYNC_PHONE_APP_STATUS）、心跳保活周期；
  4. "无需应用层分片"是否成立。

### 下一步（进入 6B 前）
**补一次真机 fetch 抓包取证**：在手环上实际点开 Pulse 快应用并触发一次真实 fetch，用 `btvs`/Wireshark 抓包，解出真实的 `SEND_PHONE_MESSAGE` 结构与 content，方可确认 3.2 推断模型的对错。在此之前，阶段 6B（数据泵实现）不应开始。
