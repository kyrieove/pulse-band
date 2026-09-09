# 业务流协议取证与快应用互联契约（阶段 6A / 6B-PRE）

状态（2026-09-09）：**离线业务帧解密、快应用列表上报、包名路由（阶段 6A），以及真实快应用点开建链（id=6/7）、互联握手（id=8/9 `__hs__`）、上行 fetch 请求（id=9，`r1`~`r12`）已由真机物理抓包（`fetchevidence-2026-09-09.pcapng`）逐字节实证。但「下行 fetch 响应 / 真实额度数据结构」在本抓包中**未捕获**（主机未运行 8765 Pulse 服务，未回响应），仍属推断；故「手环显示真实额度数字」尚未闭环，需在阶段 6B 用自研回响应实测验证。不得宣称额度链路已 100% 完整或已达阶段 6 完成标准。**

本文档所有结论只有两种状态：带**复现三件套**并标「来源：自己抓包 · 2026-09-08/09」，或标「仍是假设」。脱敏：authkey、会话密钥、解密明文、真实用户数据一律用占位符，只记字段号/wire type/长度/取值类型。

---

## 1. 取证环境与工具

- **证据文件**：
  - `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng` (SHA256: `2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099`)
  - `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng` (SHA256: `3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377`)
  - `C:\dev\pulse-band2\fetchevidence-2026-09-09.pcapng` (SHA256: `a2624ebbe4c1e5dde0227df183124814f1f4f30b0de75855b2940dde2a60cef7`，总包数 594，RFCOMM 242 包)
- **分析工具**：
  - `tools/verify_auth.py`：认证与业务解密基准。
  - `tools/decrypt_business.py`：业务流解密与结构 dump（AES-128-CTR，IV=方向密钥，含 CRC-16/ARC 与 JSON 脱敏输出）。

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

### 3.2 快应用互联（interconnect）与 fetch 结构 —— **来源：自己抓包 · 2026-09-09（已实证）**

在 `fetchevidence-2026-09-09.pcapng` 中，手环屏幕于约 11:30 物理点开 Pulse 快应用，抓包完整捕获并逐字节解密了快应用建链、互联握手（`__hs__`）及连续 12 次真实 fetch 请求（`r1`~`r12`）。

- **验证命令原文**：
  ```powershell
  python tools/decrypt_business.py fetchevidence-2026-09-09.pcapng
  ```

- **输出摘录与端到端时序**：

#### 1. 快应用状态建链（App Session Open）
- **[Pkt #308] Band->Host (RX)** | len=54B | CRC=0x52ab | `type=20, id=6 (REQUEST_PHONE_APP_STATUS)`
  - `field 22 (ThirdpartyApp)` -> `field 5 (BasicInfo)`：
    - `field 1 (package_name)`: `"com.codeisland.band"`
    - `field 2 (fingerprint)`: `<bytes:20B>`
  - **语义**：手环用户点开 Pulse 图标，手环向手机请求前台状态同步。
- **[Pkt #310] Host->Band (TX)** | len=58B | CRC=0xb172 | `type=20, id=7 (SYNC_PHONE_APP_STATUS)`
  - `field 22 (ThirdpartyApp)` -> `field 8 (PhoneAppStatus)`：
    - `field 1 (BasicInfo)`: `"com.codeisland.band"`, `<bytes:20B>`
    - `field 2 (status)`: `1` (`CONNECTED`)
  - **语义**：手机通知手环伴生应用已连接，激活互联通道。

#### 2. 快应用互联通道握手（Interconnect Handshake）
- **[Pkt #333] Band->Host (RX)** | len=180B | CRC=0xf0dc | `type=20, id=9 (SEND_WEAR_MESSAGE)`
  - `field 22` -> `field 9 (MessageContent)`：
    - `field 1 (BasicInfo)`: `"com.codeisland.band"`, `<bytes:20B>`
    - `field 2 (content, 120B bytes)`:
      ```json
      {"tag":"__hs__","count":0,"caps":{"version":3,"chunk":true,"maxChunkSize":768,"encodings":["text","base64"],"ack":true}}
      ```
- **[Pkt #338] Host->Band (TX)** | len=225B | CRC=0x0087 | `type=20, id=8 (SEND_PHONE_MESSAGE)`
  - `field 22` -> `field 9 (MessageContent)`：
    - `field 1 (BasicInfo)`: `"com.codeisland.band"`, `<bytes:20B>`
    - `field 2 (content, 164B bytes)`:
      ```json
      {"tag":"__hs__","count":1,"caps":{"version":3,"chunk":true,"maxChunkSize":768,"encodings":["base64","text","hex"],"compressions":["none"],"ack":true,"ackWindow":4}}
      ```
  - **关键发现与修正**：
    - 手环发给主机使用 `id = 9 (SEND_WEAR_MESSAGE)`；
    - 主机发给手环使用 `id = 8 (SEND_PHONE_MESSAGE)`；
    - 互联载荷完全符合 `core/src/fake.rs` 既有的 `__hs__` 握手契约。

#### 3. 真实 fetch 请求上报（Band -> Host）
- **[Pkt #345] Band->Host (RX)** | len=167B | CRC=0xa064 | `type=20, id=9 (SEND_WEAR_MESSAGE)`
  - `field 22` -> `field 9 (MessageContent)`：
    - `field 1 (BasicInfo)`: `"com.codeisland.band"`, `<bytes:20B>`
    - `field 2 (content, 107B bytes)`:
      ```json
      {"tag":"fetch","id":"r1","url":"http://127.0.0.1:8765/api/status/compact?all=1","options":{"method":"GET"}}
      ```
  - **重试抓包**：抓包中捕获了从 `r1` 到 `r12` 共 12 次真实的 fetch 重试报文（包号 #345, #350, #370, #389, #409, #428, #448, #469, #490, #511, #522, #537），每次递增 `id`（`r1`~`r12`），请求参数 100% 稳定一致。

#### 4. fetch 响应下行链路（Host -> Band）—— ⚠️ 仍是假设（未抓包实证）
> 本节为**推断结构，无抓包帧支撑**：`fetchevidence-2026-09-09.pcapng` 中未捕获任何 `id=8` 的下行 fetch 响应（无 `resp`/`body`/额度字段）；本次抓包下行 `id=8` 仅 `__hs__` 握手（包 #338）。因主机未运行 8765 Pulse 服务故未回响应。以下形状来自 `core/src/fake.rs` 与 `rpc-contract.md`，需在阶段 6B 用自研后端回真实响应后实测确认，不得当作已确认事实。
- 主机向手环下发 fetch 响应推断使用对称通道（`id=8`，方向与字段尚未实证）：
  - `WearPacket.type = 20, id = 8 (SEND_PHONE_MESSAGE)`
  - `field 22 (ThirdpartyApp)` -> `field 9 (MessageContent)`
  - `field 1 (BasicInfo)`: `"com.codeisland.band"`, `<bytes:20B>`
  - `field 2 (content, bytes)`: UTF-8 编码的响应 JSON（**推断**）：
    ```json
    {"tag":"fetch","id":"r1","resp":{"ok":true,"status":200,"statusText":"OK","headers":{"content-type":"application/json"},"body":"<quota-json>"}}
    ```

---

## 4. 传输、分片与序号机制

1. **帧级封装与序号**（来源：自己抓包 · 2026-09-08/09 已证）：帧格式 `A5A5 | type(0x03) | seq | len(2B LE) | crc | payload(01 02 + ciphertext)`；`seq` 单字节按方向各自自增；每收一个 `type=0x03` 帧须回一个 `type=0x01` ACK（`len=0`,`chk=0x0000`，seq 回显）。
2. **加解密重置**（来源：自己抓包 · auth.md 已证）：每条业务帧独立以当前方向 key 作为 IV 进行 AES-128-CTR，每帧重置 IV。
3. **分片需求**（来源：自己抓包 · 2026-09-09 已证）：
   - 快应用握手包协商了 `maxChunkSize: 768`；
   - 实际单条 fetch 请求仅 167 字节（未分片）；
   - A5A5 帧支持高达 65535 字节。手环端互联协议支持单帧完整投递，不需要额外的应用层分片切片。

---

## 5. 阶段 6（额度往返）实现可行性判定

### 判定结论：**【可开始阶段 6B 数据泵的上行处理；但「手环显示真实额度数字」尚未闭环，不得宣称已完成或 100% 完整】**

- **已完全证实（上行链 / 抓包实证 · 2026-09-09）**：
  1. 传输层帧结构、序列号回显、CRC-16/ARC、前导握手闭环；
  2. 会话认证状态机真机三次稳定通过；
  3. 快应用安装上报（`id=0`）与包名路由 `"com.codeisland.band"` 证实；
  4. 快应用激活时序（`id=6 -> id=7`）真机证实；
  5. 互联握手（`__hs__` 上行 `id=9`、下行 `id=8`）真机证实；
  6. 真实物理 fetch 请求（`id=9`，`{"tag":"fetch","id":"r1",...}`）真机 12 次重试完整证实。
- **仍未实证（进入阶段 6 完成标准前必须补齐）**：
  7. **下行 fetch 响应结构**（`id=8` 的 `resp.body` JSON 形状）——本次抓包未捕获（主机未运行 8765），仍为推断；
  8. **真实额度数据结构**（`limits`/`pct5h`/`pct7d`/`resetText` 等）——从未抓到，未验证；
  9. **额度在物理手环屏幕上的渲染闭环**——阶段 6 完成标准核心，未验证。
- 结论：阶段 6B 可开始实现**上行 fetch 接收与转发**（把手环 `id=9` fetch 转给 8765 后端），并用一个真实后端响应去抓下行 `id=8`，实测验证第 7/8 条；但在此之前，不得宣称"证据链 100% 完整 / 额度往返已闭环 / 阶段 6 达标"。

