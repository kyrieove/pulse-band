# STATUS — 2026-09-09（阶段 5 · 自研状态机与真机三次断开重连验收通过）

- **已有基础**：阶段 1–4 完成；阶段 5C 会话认证状态机与 7 类离线合成测试通过；跨语言向量一致性测试通过。
- **本次完成（阶段 5D）**：
  - 用户明确授权解封真机（三次断开重连验收，失败对照未授权直接跳过）。
  - 在 `core/src/session.rs` 中完整实现与传输层解耦的会话认证状态机 `Session`，并在 `core/src/main.rs` 接入 `--auth` 受控运行入口。
  - 完成三次独立物理 RFCOMM 建立、前导握手（11B TX / 14B RX 完全匹配）、链路协商（type=0x02）、Step 1~4 认证会话交互及显式 `closesocket` 链路释放。
  - 三次认证全部自动通过（3/3 PASS），三次均成功校验 Step 2 HMAC-SHA256 签名，且均收到 Step 4 `confirm_result == true`，状态机升级为 `Authenticated`。
  - 保护条款计数器终值：连接失败 0 次（历史 0 + 本阶段 0），发包失败 0 次（历史 0 + 本阶段 0）。
  - 更新 `docs/protocol/auth.md` 记录真机实测证据表与可区分响应依据。
- **限制与未确认项**：
  - 失败对照本轮未执行（设备收到错误凭据/非法报文时的具体断链/超时行为仍是假设）。
  - 业务流 `01 02` CTR 传输层双向交互尚未实现持续业务数据泵，仅协商保留了会话密钥。
- **本次完成（阶段 6A 离线业务协议取证）**：
  - 编写离线解密与结构 dump 脚本 `tools/decrypt_business.py`，复用 `verify_auth.py` 的 KDF 与 AES-128-CTR 解密逻辑（IV=方向密钥）。
  - 在两份基线抓包（`baseline-01` 与 `baseline-02`）中逐字节解密全部 100+ 条业务报文（`01 02`），提取 Protobuf 结构树与时间线。
  - 证实快应用列表查询与上报（`type=20, id=0`），成功解析出包名 `"com.codeisland.band"`、应用名称 `"Pulse"`、版本号 26、及 20 字节应用指纹。
  - 结合公开协议依据（`wear_thirdparty_app.proto` 与 `thirdparty_app_system.dart`），完整推导快应用互联通信协议（`type=20, id=8` / `SEND_PHONE_MESSAGE`）及其与客户端 `device.interconnect` RPC 的 1:1 映射契约。
  - 产出完整取证文档 `docs/protocol/business.md`。
- **本次完成（阶段 6B-PRE 真机 fetch 抓包取证）**：
  - 用户提权运行 `btvs.exe -Mode Wireshark`，并在物理手环上点开 Pulse 快应用，成功生成 `fetchevidence-2026-09-09.pcapng`（594 帧，39084 字节，SHA256: `a2624ebbe4c1e5dde0227df183124814f1f4f30b0de75855b2940dde2a60cef7`）。
  - 成功解密新抓包全部业务报文，证实点开应用后完整的通信链路：
    - 应用建链握手：手环上行 `type=20, id=6 (REQUEST_PHONE_APP_STATUS)`，主机下行 `type=20, id=7 (SYNC_PHONE_APP_STATUS)`（status=1 CONNECTED）；
    - 快应用互联协商：手环上行 `type=20, id=9 (SEND_WEAR_MESSAGE)` 发送 `__hs__`（count:0, caps），主机下行 `type=20, id=8 (SEND_PHONE_MESSAGE)` 回复 `__hs__`（count:1, caps）；
    - 真实 fetch 请求上报：手环上行 `type=20, id=9 (SEND_WEAR_MESSAGE)`，载荷为 `MessageContent`，`content` 证实为 JSON `{"tag":"fetch","id":"r1","url":"http://127.0.0.1:8765/api/status/compact?all=1","options":{"method":"GET"}}`，并捕获连续 12 次重试（`r1`~`r12`）。
  - 修正了推断模型中的 ID 语义与方向：上行为 `id=9`（`SEND_WEAR_MESSAGE`），下行为 `id=8`（`SEND_PHONE_MESSAGE`）。
  - 判定结论：上行 fetch 请求 / 建链 / 握手已由真机抓包实证，并纠正方向（上行 id=9、下行 id=8）；但**下行 fetch 响应与真实额度结构未实证**（主机未运行 8765 Pulse 服务，未回响应），额度往返闭环未达成；需在阶段 6B 用自研后端回响应实测验证。不得宣称证据链 100% 完整。
- **限制与未确认项（客观边界）**：
  - 本次抓包中由于主机未启动 8765 端口的 Pulse 服务，手环未收到下行 fetch 响应（带真实额度的 `resp.body` JSON），下行数据通路已由 `__hs__` 证实，但真实额度在手环屏幕上的渲染闭环将在阶段 6B 实施中验证。
- **当前状态与下一步**：
  - **阶段 6B-PRE 部分完成**（上行 fetch 请求 / 建链 / 握手 / 方向修正已实证；下行 fetch 响应与真实额度结构未实证）；**可开始阶段 6B 上行数据泵实现，但「手环显示真实额度数字」的闭环未达成、未达标**。
  - 未覆盖旧抓包，敏感信息严格脱敏，未执行 `git push`。
  - 等待用户验收报告并批准开始阶段 6B。



