# STATUS — 2026-09-08（阶段 5 离线协议调查与 KDF 验证完成 · 停在 Step 3 生成与成功判定）

- **已完成到哪**：
  - 阶段 1~4 完成并已推送；阶段 4 真机 RFCOMM 首通成功。
  - 阶段 5 前置凭据就绪：`%LOCALAPPDATA%\PulseDev\run\device.json`（Xiaomi Smart Band 10，代号 `o66`，authkey 16B）已受控读取，未泄露。
  - 公开协议依据确立：匹配开源实现 `adomerle/xiaomi_protobuf_extractor`（commit `4560f8c0`）与 `xiaomi.proto`，确认协议为 `XiaomiSppV2`，命令为 `Command.type=1`, `subtype=26/27`, `auth=3`。
  - 离线复现验证闭环（两份独立会话）：
    1. KDF 算法确认：基于 `authkey` 与双向 Nonce 的 HKDF-SHA256 算法，在 `baseline-2026-09-08-01`（包 #116, #120）与 `baseline-2026-09-08-02`（包 #112, #115）中推导的 Step 2 HMAC 均实现 **100% 逐字节完全匹配**。
    2. 会话解密验证：派生的 AES-128-CTR 会话密钥成功将两份抓包全量后续 `01 02` 加密业务报文（146 帧与 53 帧）解密为合法的 Protobuf Command。
  - 文档更新：`docs/protocol/auth.md` 已全面重构，记录了算法推导公式、两份会话脱敏复现原文及证据缺口。
- **当前状态**：阶段 5 停在离线认证分析（KDF 与会话密钥已验证，Step 3 构造与 Step 4 判定未确认）。
- **仍未确认 / 证据缺口**：
  - Step 3 中 32B `encryptedNonces` 与 21B `encryptedDeviceInfo` 的主动加密构造规范（明文拼接与 IV 构造）；
  - Step 4 内部字段的精确状态语义，以及认证失败时的设备响应行为（无失败反例对比）。
- **当前闸门**：
  - 严格禁止连接手环、严格禁止发送猜测认证包、禁止实现未经验证的 `core/src/session.rs`、禁止进入阶段 6。
  - 即使上述条件部分满足，亦不自动授权真机连接。
- **下一步任务**：
  1. 检索开源实现中主动发送 Step 3 的构造逻辑（`AuthStep3` 的明文结构与 IV 派生规范）；
  2. 检索或寻找认证失败响应特征定义；
  3. 待 Step 3 与失败判定完全闭环后，再行设计最小受控测试方案。

