# 认证握手与会话密钥协议（阶段 5 · 离线分析与实证记录）

状态：**第 1~2 步 KDF 与会话解密已完成离线验证；第 3 步主动加密明文/IV 及第 4 步成功/失败判定依据仍不完整，禁止连接真机试错。**

证据文件（两份独立成功会话）：
1. `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng`
   - SHA256：`2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099`
   - 总包数：704
2. `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng`
   - SHA256：`3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377`
   - 总包数：400

设备凭据：本地受控读取 `%LOCALAPPDATA%\PulseDev\run\device.json`（设备型号 Xiaomi Smart Band 10，内部代号 `o66`，authkey 16 字节），凭据原文严禁写入本文档。

---

## 1. 可信公开协议来源

通过对设备代号（`o66`）及开源生态检索，定位到针对该代手环基于 SPP / Protobuf 协议的公开逆向实现：

- **开源仓库**：`adomerle/xiaomi_protobuf_extractor`
  - URL：`https://github.com/adomerle/xiaomi_protobuf_extractor`
  - Commit：`4560f8c0c7f48bc9d53009f887504b4cd5176483`
  - 核心文件：`xiaomi.proto`（源自 Gadgetbridge 的 `nodomain.freeyourgadget.gadgetbridge.proto.xiaomi`）、`extractor.py`
- **协议名称**：`XiaomiSppV2`
- **传输层承载**：RFCOMM SPP，以 `A5 A5` 为帧头，`type=0x03` 为业务数据通道：
  - 载荷通道 `01 01`：明文 Protobuf 通道（握手认证阶段）
  - 载荷通道 `01 02`：AES-128-CTR 加密 Protobuf 通道（业务数据阶段）
- **Protobuf 消息定义与匹配点**：
  - 外层命令容器：`message Command { required uint32 type = 1; optional uint32 subtype = 2; optional Auth auth = 3; ... }`
  - 认证命令编码：`type = 1`（Command），`subtype = 26`（握手第 1/2 步），`subtype = 27`（握手第 3/4 步）
  - 认证内层字段：
    - 步骤 1 (Host $\to$ Band, 29B)：`Auth.phoneNonce`（field 30）包含 16B 随机数 `nonce = 1`
    - 步骤 2 (Band $\to$ Host, 63B)：`Auth.watchNonce`（field 31）包含 16B 随机数 `nonce = 1` 与 32B `hmac = 2`
    - 步骤 3 (Host $\to$ Band, 68B)：`Auth.authStep3`（field 32）包含 32B `encryptedNonces = 1` 与 21B `encryptedDeviceInfo = 2`
    - 步骤 4 (Band $\to$ Host, 22B)：`Auth.authStep4`（field 33）包含 `unknown1 = 1`（varint=1）、`unknown2 = 2`（varint=4159700799）及 `field 3`（varint=706）

---

## 2. 算法规范与派生关系

### 2.1 密钥派生算法 (KDF)
输入材料：
- `authkey`：16 字节预共享主密钥（来自 `device.json`）
- `phone_nonce`：16 字节主机端随机挑战数（由主机在 Step 1 生成）
- `watch_nonce`：16 字节手环端随机挑战数（由手环在 Step 2 生成）

派生过程（HKDF-SHA256 变体，常量标签 `b"miwear-auth"`）：
1. 提取伪随机密钥（PRK）：
   $$\text{initial\_key} = \text{phone\_nonce} \parallel \text{watch\_nonce} \quad (32\text{ 字节})$$
   $$\text{PRK} = \text{HMAC-SHA256}(\text{key}=\text{initial\_key}, \text{msg}=\text{authkey}) \quad (32\text{ 字节})$$
2. 扩展生成会话材料块（64 字节）：
   $$T_1 = \text{HMAC-SHA256}(\text{key}=\text{PRK}, \text{msg}=\texttt{"miwear-auth"} \parallel \texttt{0x01}) \quad (32\text{ 字节})$$
   $$T_2 = \text{HMAC-SHA256}(\text{key}=\text{PRK}, \text{msg}=T_1 \parallel \texttt{"miwear-auth"} \parallel \texttt{0x02}) \quad (32\text{ 字节})$$
   $$\text{KDF\_Output} = T_1 \parallel T_2 \quad (64\text{ 字节})$$
3. 拆分会话密钥与初始向量：
   - $\text{decryption\_key} = \text{KDF\_Output}[0..16]$（手环 $\to$ 主机 AES 密钥，16 字节）
   - $\text{encryption\_key} = \text{KDF\_Output}[16..32]$（主机 $\to$ 手环 AES 密钥，16 字节）
   - $\text{decryption\_nonce} = \text{KDF\_Output}[32..36]$（4 字节）
   - $\text{encryption\_nonce} = \text{KDF\_Output}[36..40]$（4 字节）

### 2.2 握手 Step 2 校验机制
手环在 Step 2 返回的 32 字节 `watch_hmac` 计算公式为：
$$\text{Expected\_HMAC} = \text{HMAC-SHA256}(\text{key}=\text{decryption\_key}, \text{msg}=\text{watch\_nonce} \parallel \text{phone\_nonce})$$
若主机计算所得值与报文中的 `watch_hmac` 逐字节相等，即完成手环合法性与共享密钥对齐的校验。

### 2.3 业务流加密套件
- **算法**：AES-128-CTR
- **密钥**：主机发往手环使用 `encryption_key`；手环发往主机使用 `decryption_key`
- **计数器**：按上游 `extractor.py` 实现，以大端密钥值作为初始计数器（`initial_value = int.from_bytes(key, 'big')`）

---

## 3. 离线验证复现与实证结果

### 3.1 复现命令
复现验证脚本已编写在本地离线环境：
```powershell
python C:\Users\ASUS\.gemini\antigravity\brain\c1cd16d6-8acf-492d-baad-5918c10da7ea\scratch\verify_handshake.py
```

### 3.2 脱敏验证输出原文
```text
=== 验证文件: baseline-2026-09-08-01.pcapng ===
  authkey 长度: 16B
  Step 1 (包 #116): phone_nonce 长度=16B
  Step 2 (包 #120): watch_nonce 长度=16B, watch_hmac 长度=32B
  Step 2 HMAC 离线推导比对: 100% 匹配通过
  后续加密业务包数量: 146 帧
  后续 01 02 业务包 AES-CTR 解密结构验证: 全部符合 Protobuf Command 特征
=== 验证文件: baseline-2026-09-08-02.pcapng ===
  authkey 长度: 16B
  Step 1 (包 #112): phone_nonce 长度=16B
  Step 2 (包 #115): watch_nonce 长度=16B, watch_hmac 长度=32B
  Step 2 HMAC 离线推导比对: 100% 匹配通过
  后续加密业务包数量: 53 帧
  后续 01 02 业务包 AES-CTR 解密结构验证: 全部符合 Protobuf Command 特征

两份独立会话离线算法验证汇总: 会话1=通过, 会话2=通过
```

### 3.3 验证结论
1. **KDF 与 Step 2 HMAC**：在两份抓包独立会话中，依据公开算法推导的 32 字节 HMAC 与手环原始返回的 `watch_hmac` 均达到 **100% 逐字节完全匹配（32/32 字节无误）**。以 256 位哈希空间计，该结果排除巧合。
2. **会话密钥有效性**：派生的会话密钥成功解密了会话 1（146 帧）与会话 2（53 帧）全部后续 `01 02` 加密业务报文，解密结果均呈现合法的 Protobuf Command 结构（如 `type=2` System, `subtype=3` Clock 等）。

---

## 4. 证据缺口与未解决问题

尽管前两步算法已获数学闭环，但仍存在以下未确认缺口，禁止推入真机实现：

### 4.1 缺口 1：握手 Step 3 载荷的主动生成规范
- 观察事实：主机在 Step 3 发送 68 字节载荷，内含 32 字节 `encryptedNonces` 与 21 字节 `encryptedDeviceInfo`。
- 现状：公开项目 `adomerle/xiaomi_protobuf_extractor` 仅作为离线被动解密器存在，未实现 Step 3 的主动发送逻辑；直接测试基础 AES-CTR / ECB 对 `phone_nonce + watch_nonce` 进行直接加密未直接命中抓包密文。`encryptedNonces` 的具体明文填充结构（是否包含私有头/盐）与 IV 派生定义仍未确认。

### 4.2 缺口 2：Step 4 状态语义与失败判定
- 观察事实：手环在 Step 4 恒回 22 字节响应（含字段 1、2、3）。
- 现状：
  - `unknown1 = 1`、`unknown2 = 4159700799`、`field3 = 706` 的确切语义在公开开源实现中仍被标注为 `unknown`；
  - 缺乏认证失败反例抓包，尚未确认认证失败时手环是直接断开连接、返回特定错误码（如 `Auth.status`），还是下发 NAK；
  - **严禁**将“send 成功”、“recv 非空”、“CRC 正确”、“没有 NAK”或“响应长度 22B”作为认证成功的充分条件。

---

## 5. 阶段 5 执行纪律与闸门

1. **继续禁止真机连接**：在 Step 3 主动报文构造及 Step 4 成功判定未获闭环前，禁止连接手环，禁止发送任何认证测试包。
2. **禁止实现猜测性代码**：`core/src/session.rs` 保持未实现状态，不得将未完全闭环的假说推入正式产品代码。
3. **下一步任务**：针对 Step 3 构造逻辑（Gadgetbridge 主动认证握手类或相关实现）与失败响应定义进行深入调查，获取确定性生成规范。
