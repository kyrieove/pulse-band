# 认证握手与会话密钥（阶段 5 · 离线复现）

状态（2026-09-08）：**两份成功会话的 Step 2 HMAC、Step 3 完整 68B 载荷均已离线复现；Step 4 成功字段有公开定义及客户端判定依据。尚未进行自研客户端真机认证，阶段 5 未完成，现有禁止连接与发包闸门保持。**

## 1. 证据与来源

设备为 Xiaomi Smart Band 10（o66）。根据 `transport.md`，基线主机应用是 OronBox。凭据仅从 `%LOCALAPPDATA%\PulseDev\run\device.json` 在本地读取，authkey 为 16B；密钥、挑战应答、解密数据不写日志或文档。

| 文件 | SHA256 | 四步包号 |
|---|---|---|
| `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng` | `2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099` | 116、120、122、125 |
| `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng` | `3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377` | 112、115、117、120 |

公开实现固定版本：

- **OronBox**：`26dd89e7ceea153cb6258660790a20e5e4675cb0`。
  - [设备工厂](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/device/xiaomi/xiaomi_device_factory.dart)：`create` 注册 `XiaomiAuthSystem`。
  - [认证系统](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/device/xiaomi/components/auth_system.dart#L20)：`authenticate` → `_onDeviceVerify` → `buildAuthStep2` → `_onDeviceConfirm`。
  - [Step 3 构造](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/device/xiaomi/utils/auth_utils.dart#L36)：66 行 HMAC，68 行伴随设备信息，77 行 nonce，81 行 CCM。
  - [密码原语](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/protocols/xiaomi/crypto/miwear_crypto.dart)：`kdfMiwear`、`aes128CcmEncrypt`（32 位标签）。
  - [业务 CTR](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/lib/src/protocols/xiaomi/crypto/v2_l2_cipher.dart)：`encrypt/decrypt` 每次以对应方向密钥作为 IV。
  - [认证 protobuf](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/protos/xiaomi/wear_account.proto#L217)：217–239 行定义认证消息；101–117 行定义 `CompanionDevice`；75–78 行对应字段 30–33。
  - [消息外层](https://github.com/zxor-org/OronBox/blob/26dd89e7ceea153cb6258660790a20e5e4675cb0/protos/xiaomi/wear.proto#L28)：必需 type/id，可选 oneof payload。
- **AstroBox-NG**：主仓 `52d3ba5f7b6207908f6b21218555459e16094cd9`。
  - [repos.xml](https://github.com/AstralSightStudios/AstroBox-NG/blob/52d3ba5f7b6207908f6b21218555459e16094cd9/repos.xml) 指向公开 Core 模块；主仓并不直接包含认证代码。
  - Core 单独固定到 `95541fda829ef9fcb010e387d44782c9601fa9e0`（调查时模块版本，不代表主仓锁定的依赖版本）。[auth.rs](https://github.com/AstralSightStudios/AstroBox-NG-Module-Core/blob/95541fda829ef9fcb010e387d44782c9601fa9e0/src/device/xiaomi/components/auth.rs#L204)：`build_auth_step_2` 的 HMAC、KDF、CCM 参数与 OronBox 一致；设备名使用 AstroBox，因此不期望其设备信息密文与 OronBox 抓包相同。
  - [aesccm.rs](https://github.com/AstralSightStudios/AstroBox-NG-Module-Core/blob/95541fda829ef9fcb010e387d44782c9601fa9e0/src/crypto/aesccm.rs#L8)：AES-128、12B nonce、4B tag。
  - [主仓解密脚本](https://github.com/AstralSightStudios/AstroBox-NG/blob/52d3ba5f7b6207908f6b21218555459e16094cd9/scripts/decrypt_companion_device.py) 也使用 AESCCM；本次只阅读，未用其命令行传递凭据或输出明文。
- 历史来源：`adomerle/xiaomi_protobuf_extractor`，commit `4560f8c0c7f48bc9d53009f887504b4cd5176483`。其旧字段名不作为密码学语义依据。

以上是公开源码依据，不是厂商官方规范。未查明项目间完整继承关系，因此不将两个实现计为独立发现；关键实证是本地两会话逐字节匹配。最初的 AstroPrint/AstroBox 是同名 3D 打印机项目，已由正确的 AstroBox-NG 替代。

## 2. 字段与确定公式

以下长度为两份基线观察，不表示所有客户端的固定长度。帧为 `A5A5`、type=3；payload 前两字节 `01 01` 后是 protobuf。

| 步骤 | 方向 | payload | type/id | Account 字段 | 内层字段 |
|---|---|---:|---|---|---|
| 1 | Host → Band | 29B | 1/26 | 30 AppVerify | 1 app_random：16B |
| 2 | Band → Host | 63B | 1/26 | 31 DeviceVerify | 1 device_random：16B；2 device_sign：32B |
| 3 | Host → Band | 68B | 1/27 | 32 AppConfirm | 1 app_sign：32B；2 encrypt_companion_device：21B |
| 4 | Band → Host | 22B | 1/27 | 33 DeviceConfirm | 1 confirm_result：bool；2/3 device_capability / device_capability_2：uint32 |

`P` 为 phone nonce，`W` 为 watch nonce，`A` 为 authkey；切片右端不包含，`HMAC` 为 HMAC-SHA256：

```text
PRK = HMAC(key=P || W, msg=A)
T1 = HMAC(key=PRK, msg=ASCII("miwear-auth") || 0x01)
T2 = HMAC(key=PRK, msg=T1 || ASCII("miwear-auth") || 0x02)
OKM = T1 || T2
dec_key = OKM[0:16]       # Band → Host
enc_key = OKM[16:32]      # Host → Band
dec_nonce = OKM[32:36]
enc_nonce = OKM[36:40]
device_sign = HMAC(key=dec_key, msg=W || P)
app_sign = HMAC(key=enc_key, msg=P || W)
```

这是 HKDF-SHA256 的 extract/expand 形式，salt=P||W、IKM=A、info=miwear-auth、输出 64B。其中未使用材料的实际协议用途不由本次复现证明。

Step 3 的 32B 字段是 **HMAC，不是 AES 加密的 nonce 拼接**。21B 字段为：

```text
nonce = enc_nonce || 8 个零字节             # 共 12B
AAD = 空
plaintext = protobuf(CompanionDevice)
encrypt_companion_device = AES-128-CCM(enc_key, nonce, plaintext, AAD)
                         = ciphertext || tag_4B
```

两会话解密并验证 tag 后，明文均为 17B，字段形状为 1 varint、3 string、4 uint32。复现脚本依据公开源码独立序列化 device_name="OronBox"、app_capability=0xFFFFFFFF，仅 device_type 从已通过 CCM 校验的明文中读取为平台输入；不把原密文作为加密输入。重建明文、21B 密文与标签、完整 68B Step 3 payload 均一致。这不是完全无抓包输入的生成测试，也没有验证改用 Pulse 名称时设备的接受行为。

业务 `01 02` 使用 AES-128-CTR，与 Step 3 的 CCM 分开。每条消息按方向选 key，IV=该 key 的 16B 值（大端初始计数器），每条消息重置。无需使用 KDF 的 4B nonce 作为业务 CTR IV。

## 3. 可复现验证

脚本：[tools/verify_auth.py](../../tools/verify_auth.py)。依赖 Python 3.10+、`cryptography`（本次 46.0.6）和本地 Wireshark tshark；不需要联网。完整脱敏输出：[auth-verification.txt](auth-verification.txt)。

```powershell
Set-Location C:\dev\pulse-band2
python tools/verify_auth.py | Tee-Object -FilePath docs/protocol/auth-verification.txt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

脚本对每份文件使用的提取命令如下；原始载荷仅经子进程管道进入内存，不向终端输出：

```powershell
& "C:\Program Files\Wireshark\tshark.exe" -r C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e hci_h4.direction -e data.data
& "C:\Program Files\Wireshark\tshark.exe" -r C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e hci_h4.direction -e data.data
```

复现结果（来源：自己抓包 · 2026-09-08；命令退出码 0）：

| 检查 | 会话 1 | 会话 2 |
|---|---:|---:|
| SHA256 | 一致 | 一致 |
| 完整 A5A5 帧 / CRC 通过 | 304/304 | 116/116 |
| Step 2 HMAC | 32B 一致 | 32B 一致 |
| Step 3 app_sign | 32B 一致 | 32B 一致 |
| Step 3 CCM tag、公开设备信息重建 | 通过 | 通过 |
| Step 3 完整 payload | 68B 一致 | 68B 一致 |
| 篡改 CCM tag 的本地负对照 | 拒绝 | 拒绝 |
| Step 4 confirm_result | true | true |
| Host → Band 业务外层通过/失败/跳过 | 73/0/0 | 27/0/0 |
| Band → Host 业务外层通过/失败/跳过 | 73/0/0 | 26/0/0 |

握手按方向流内偏移依次为 41、52、86、131；包号见第 1 节及输出原文。每方向先跳过已记录的初始非 A5A5 前导（11B/14B），随后严格验证帧边界、长度及 payload CRC；跨 RFCOMM 分片按方向重组。

业务验证覆盖全部 199 帧：完整消费 protobuf wire 数据，检查已知 type、uint32 id、对应 oneof payload 字段及其一层 wire 结构；不宣称已验证每个业务子消息的完整语义或全部嵌套 required 字段。会话 1 包 #128（Host → Band，流内偏移 194）仅含 type=2/id=108，符合可选 oneof 的定义，不应误判解密失败。

**纠正旧证据**：原 scratch 目录 `verify_handshake.py` 使用 `data_pkts[:5]`，仅检查首字节为 0x08，没有全量 protobuf 解析、文件哈希或 CRC 校验。旧“全部符合”输出不能支持全量验证；由本次脚本和输出替代。旧 Rust 测试/构建通过也不构成 Python 算法验证证据。本次没有修改或重跑 Rust 产品代码。

## 4. 成功、失败与证据边界

- OronBox 的 `wear_account.proto` 明确定义 `Auth.DeviceConfirm.confirm_result`（字段 1）。`auth_system.dart` 72–81 行按 true 完成认证，false 发出 `AuthFailed` 并结束等待；本地 HMAC 不匹配也走失败分支。`dispose` 结束未完成等待。
- 两份成功抓包均为 true，其后业务外层可解密。由此可以定义基于明确字段的成功分支，而不是依据 22B 长度、CRC 或“收到数据”。
- AstroBox Core `auth.rs` 111–115 行匹配 `AuthDeviceConfirm(_dc)` 后直接设置 `is_authed=true`，忽略 `confirm_result`。它可交叉核对构造算法，**不能照搬作为失败判定实现**。
- 未采集真实拒绝/错误凭据会话；无法声称设备每种失败一定返回 false，而非断链或不响应。所阅认证函数未提供完整连接级超时策略；不由局部代码推断全应用没有超时。
- 本地 CCM 篡改测试只验证本地密码库拒绝错误标签，不是设备拒绝行为证据。明文 Step 4 本身也不是单独具有密码学完整性保护的设备证明。

后续自研状态机应要求：处于等待确认阶段、已验证 Step 2、已生成并发送 Step 3、收到正确方向和 type/id/Account 分支且显式 confirm_result=true。false、字段缺失、乱序、重复、超时、断链都不能升级为成功。超时时长应沿用项目已有配置或单独确定，不从两份抓包臆造。

## 5. 当前交付与下一步

本次完成公开源码调查、两会话离线复现、旧脚本证据审计和文档更新；未连接设备、未发包、未修改 `session.rs`、未修改凭据/pcapng。收工时用户已授权将文档、脱敏输出及验证脚本提交推送。

算法和成功字段的离线证据已足以准备下一步会话层设计与纯离线测试；真实失败响应仍作为单独的实测缺口保留。按当前闸门，不自动启动产品认证或真机测试。

下一步最小工作：以本文件公式编写会话状态机设计和合成数据测试向量，覆盖 HMAC 不匹配、CCM 标签损坏、confirm=false/缺失、乱序确认、超时与断链。随后在原有真机闸门明确解除后，才执行项目阶段 5 的受控认证及三次重连验收；不得把本次离线成功标成阶段 5 已完成。
