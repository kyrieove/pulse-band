# 小米手环 10 快应用安装协议取证与逆向分析研究 (App Install Protocol Analysis)

## 1. 概述与实证纪律

本文档记录针对小米手环 10（Xiaomi Smart Band 10）快应用（RPK）安装协议的研究现状、认知边界与验证方法。
根据工程纪律与实证规则：
- **严禁捏造或臆测操作码（Opcode）**；
- **严禁使用未经验证的猜测冒充真实安装能力**；
- 严格遵循三态认知分层：【已确认】、【可能】与【未知】。

---

## 2. 协议现状三态认知分层 (Tri-State Epistemic Audit)

### 2.1 【已确认（Verified Fact）】

1. **链路层 Frame 帧封装结构**：
   - 魔数固定为 2 字节小端序：`0xA5, 0xA5`（`core/src/frame.rs`）；
   - 帧头格式：`Magic(2B) + FrameType(1B) + Seq(1B) + PayloadLen(2B, LE) + CRC16(2B, LE)`；
   - CRC-16 算法为 `CRC-16/ARC`（多项式 `0x8005`，初始值 `0x0000`，输出异或 `0x0000`，输入/输出均反转）；
   - `FrameType` 基础定义：`0x01` 为 ACK 帧，`0x02` 为链路协商帧（Negotiation），`0x03` 为加密业务/握手帧（Business/Auth）。
2. **安全层与会话密钥协商**：
   - 握手采用 ECDH（Curve25519）交换公钥，结合手环 Auth Key 派生出 AES-CCM 会话密钥（`core/src/session.rs`）；
   - 握手完成后，后续所有业务帧载荷（`FrameType = 0x03`）均需经由 AES-CCM 加密及 4 字节 MAC 标签保护。
3. **软件架构与传输分层已就绪**：
   - 前端与主进程已打通分块流式读取（Chunked Stream，512B 分块）；
   - Core 层已建立 `AppInstallTransport`、`BandDeviceTransport`、`AppInstallProtocol` 三层抽象，并配备 `InstallProtocolRecorder`、`MockDeviceReplayTransport` 和 `ProtocolReportGenerator`。

### 2.2 【可能（Hypothesis / Pending Verification）】

1. **业务通道承载形态**：
   - **假设 H1**：RPK 安装流可能承载于 `WearPacket` 下行消息（`SEND_PHONE_MESSAGE`，常见 Protobuf Tag 8）或其内部的 `ThirdpartyApp` 容器（Protobuf Tag 22）。
   - **假设 H2**：RPK 安装可能复用小米 OTA/固件传输（File Transfer Service）的分块协商与校验协议（先协商分块大小、总大小与 SHA-256，再分批次下发并等待断点续传确认）。
   - **待验证边界**：需通过真机抓包与反编译官方 Wearable SDK 证实是否使用专用通道或通用文件传输信道。
2. **传输分块大小上限**：
   - **假设 H3**：单帧载荷受 RFCOMM MTU（典型为 256~1024 字节）及手环接收缓冲区约束，512 字节为当前软件层安全保守预设。

### 2.3 【未知（Unknown / Unverified）】

1. **未知的具体安装 Opcode / 命令枚举**：
   - 小米手环 10 接收 RPK 安装请求的具体 Protobuf 消息 ID、Command 枚举值完全未知；
   - 绝不凭空猜测诸如 `0x1001` 等数字作为安装指令。
2. **包头签名与权限校验机制**：
   - 手环是否要求 RPK 必须由小米私钥签名？还是在开发者模式下允许自签名/调试签名安装？
   - 安装前是否有硬件级验签握手报文？
3. **安装进度上报与异常回滚报文**：
   - 传输中断、空间不足或校验失败时，手环上报的具体 Error Code 与状态码定义未知。

---

## 3. 实证研究与验证方法 (Verification Methodology)

为突破上述【未知】领域并严谨实证，必须按以下标准工作流展开：

```text
[步骤 1: 真实抓包]
利用 Android/iOS 手机开启 Bluetooth HCI Snoop Log，
或使用 Frida Hook 捕获官方 App 与手环交互期间的 raw bytes。
       ↓
[步骤 2: 样本脱敏与纳管]
敏感凭证脱敏后，将双向交互日志保存至 docs/protocol/captures/ 并更新 samples-manifest.json。
       ↓
[步骤 3: 自动化特征提取]
运行 ProtocolInspector 与 ProtocolReportGenerator：
- 提取 FrameType 分布与时序；
- 探测 Protobuf 字段候选；
- 识别固定握手/响应特征。
       ↓
[步骤 4: 证伪测试与反例审计]
基于 Popperian 证伪公式：
「若假设 H 成立，则抓包数据在位置 X 必为 a；若不成立，X = b。现在测 X。」
       ↓
[步骤 5: 真实 Core 协议落地]
仅在样本验证闭环后，方可向 AppInstallProtocol 中填写真实实现。
```

---

## 4. 关键安全与防爆警示

1. **绝对禁止伪完成**：任何阶段若无物理真机应答确认，严禁返回 `completed` 或 `installed`。
2. **绝对禁止修改稳定层**：研究协议过程中，不得修改 `live.rs`、`session.rs` 和 `rfcomm.rs`。
