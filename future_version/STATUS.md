# STATUS — 2026-09-08（阶段 5 · Step 3 两会话离线复现通过）

- **已有基础**：阶段 1–4 完成；阶段 4 RFCOMM 首通成功。凭据已受控导入，本次未修改。
- **本次完成**：
  - 固定 OronBox `26dd89e7`、AstroBox-NG 主仓 `52d3ba5f` 及公开 Core 模块 `95541fda`，核对主动认证实现。完整 commit 和源码位置见 `docs/protocol/auth.md`。
  - Step 3 的 32B 字段确认是 HMAC-SHA256；21B 字段为 17B CompanionDevice 明文的 AES-128-CCM 密文加 4B tag，nonce 为 enc_nonce 加 8 个零字节。
  - 两份基线 SHA256、420 个完整 A5A5 帧 CRC、两次 Step 2 HMAC、两次 Step 3 完整 68B payload 逐字节验证通过；本地篡改 CCM tag 均被拒绝。
  - 全量 199 帧业务报文通过 protobuf 外层及一层 wire 检查：会话 1 双向 73/73，会话 2 双向 27/26，失败和跳过均为 0。不宣称完整业务语义验证。
  - Step 4 字段 1 有明确 `confirm_result` 定义，OronBox 检查其 true/false；两份成功抓包均为 true。字段 2/3 是能力字段，不再泛称 unknown。
  - 新增 `tools/verify_auth.py` 与 `docs/protocol/auth-verification.txt`。修正旧 scratch 脚本仅检查前 5 帧首字节却报告全量通过的问题。
- **限制**：
  - AstroBox Core 当前忽略 confirm_result，不能照搬它的成功分支。
  - 未确认两个开源实现的完整继承关系，不作为独立协议发现计数。
  - Step 3 平台枚举作为抓包输入；设备名和能力常量依据公开 OronBox 实现重新序列化。未验证 Pulse 名称或其他参数的真机接受行为。
  - 真实认证失败时的返回/断链/超时行为尚无对照抓包；本地负对照不替代设备实测。
- **当前闸门**：继续不连接手环、不发包、不进入阶段 6。本次没有修改产品 Rust 代码；阶段 5 尚未完成三次自研认证重连验收。
- **下一步**：准备基于已验证算法的会话状态机设计与合成离线测试，覆盖错误 HMAC、错误 tag、拒绝/缺失/乱序确认及超时断链；原有真机闸门明确解除后再执行受控认证验收。
- **复现**：在项目根目录执行 `python tools/verify_auth.py`；成功退出码 0。详细命令、包号、方向流内偏移、哈希与输出见认证文档。
- **收工交接（2026-09-08）**：用户要求今天停止，保存进度并提交推送到 `origin/main`。明天先读本文件与 `docs/protocol/auth.md`，从会话状态机离线设计与测试继续；无需重新搜索认证算法。真机连接仍须保持上述闸门。本次仅提交认证文档、状态、脱敏验证输出与验证脚本，不包含凭据、抓包或无关的 `.zcode/`。
