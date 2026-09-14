# 阶段 5 执行交接单（认证握手与会话层）

工作目录 `C:\dev\pulse-band2`，分支 `main`。本文件是本阶段唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 开工前必读

1. `future_version/2026-09-08-pulse-v2-native-core.md`：§0.5、§1.1、§许可证纪律、§阶段 5、通用要求。
2. `docs/protocol/transport.md`：只使用其中有抓包证据的帧结构与首包顺序。
3. `core/src/frame.rs`、`core/src/rfcomm.rs`、`future_version/STATUS.md`。

## 第 −1 条：敏感信息与证据纪律

1. MAC、authkey、会话密钥、挑战/应答真实字节**绝不打印、绝不写 docs、绝不提交**。
   `device.json` 只允许读取，不得改写；authkey 只能在内存中使用。
2. 日志只能写 `<authkey:16B>`、`<challenge:NB>`、`<response:NB>`、`<session-key:NB>` 等占位符，并记录长度、方向、帧 type/seq/len、错误码。
3. 不允许凭空设计认证算法。算法、字段顺序、挑战响应关系只能来自：
   - `device.json` 中已有配置的明确约定；或
   - 阶段 2 pcapng / `docs/protocol/transport.md` 中可定位的 OronBox 实测帧。
   拿不准的一律标「仍是假设」，不要实现。
4. 不得用自写客户端 round-trip 或“没报错”证明认证成功。必须拿到只有已认证对端才会返回的可区分响应。
5. 不得删除或覆盖任何已有 pcapng、fixture、日志或 commit；新证据使用新文件名。
6. 不读 OronBox / AstroBox-NG / Gadgetbridge 源代码。

## 阶段 4 收尾先做

在开始阶段 5 前，先把 `future_version/STATUS.md` 的 4b 表述改为纯观察事实：

> 观察结果：在本次连接后的 10 秒观察窗口内未收到数据（WSAETIMEDOUT 10060）。这只能记录本次窗口现象，不能据此推出手环永远不会主动推包；首包方向仍以阶段 2 两次抓包为准。

保留原始命令与输出，不改阶段 2 结论。单独提交这个修正，不要 push。

## 当前已知状态（以此为准，不要照抄旧 STATUS）

- 阶段 4 代码 commit：`f3ff681`，尚未 push；4a 首次连接成功，4b 10 秒无数据，4c 前导帧与 type=0x02 协商响应成功。
- 阶段 4 保护计数器：连接失败 0，发包失败 0；阶段 5 不得重置历史计数，至少在报告中同时列历史值与本阶段新增值。
- 手环：Xiaomi Smart Band 10，已配对 MAC 从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读取，禁止硬编码。
- SPP UUID：`00001101-0000-1000-8000-00805F9B34FB`。
- 已确认帧：`A5A5 | type(1) | seq(1) | len(2 LE) | crc(2 LE) | payload(len)`；CRC-16/ARC 仅覆盖 payload。
- `core/src/rfcomm.rs` 的 `--probe` 只是阶段 4 探测，不得直接冒充阶段 5 认证完成。

## 第 0 步：前置闸门

运行并贴原文：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
```

- Pulse/oronbox 输出非空：立即停止，严禁 kill，写 STATUS.md 请用户自行退出。
- `device.json` 不存在、JSON 无法解析、authkey 不是 16 字节：立即停止，报告原因；不要猜、不要生成 key。
- 读取 `device.json` 时只打印字段名、MAC 是否存在、authkey 长度；禁止打印值。
- 检查 Windows 蓝牙配对项仍存在；若需要重新配对才可继续，立即停止并请求用户介入。

## 第 1 步：从已有证据确定认证序列

在不连接手环前，复查两个 pcapng 的认证相关帧：

```powershell
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-01.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-02.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
```

只在本地分析真实字节，不把 authkey/挑战/应答原文写入报告。列出将要发送的每一步的**来源包号、方向、长度、type/seq**；无法从证据推出的步骤不得发送。

## 第 2 步：实现会话认证层

新建 `core/src/session.rs`，并在 `main.rs` 注册模块。要求：

1. 从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读取 MAC 和 16 字节 authkey；禁止硬编码。
2. 复用 `frame.rs` 的编码/解码和已确认 CRC；不要复制另一套 CRC。
3. 按阶段 2 抓包中 OronBox 的真实认证序列实现最小状态机；未知字段保留 TODO，禁止凭空解释。
4. 序列号、ACK、半包/粘包按既有帧层实现；认证状态必须显式区分 `Disconnected`、`TransportConnected`、`Authenticating`、`Authenticated`、`Failed`。
5. 任何认证失败、链路断开、响应无法 decode 都要记录为失败并停止当前连接；不得自动无限重试。
6. 认证成功的判据必须是可区分的真实响应（例如后续仅认证会话出现的 type/业务响应），不能是 send 成功、recv 非空、CRC 正确或“没有 NAK”。
7. `session.rs` 单元测试只测脱敏后的结构/长度/状态机；不得把真实 authkey、挑战应答或会话密钥放入源码或 fixture。

## 第 3 步：真机验证（断开重连三次）

每次连接都必须记录：连接尝试号、connect 结果、发送步骤来源包号、发送/接收长度、脱敏 hexdump、decode 结果、认证状态转移。

- 第一次连接成功后完成认证，记录可区分响应。
- 显式 `closesocket` 释放链路。
- 用户/程序确认链路释放后，再做第二次、第三次独立断开重连。
- 三次都自动完成认证才算阶段 5 达标。
- 连接失败计数达到 3，或发包失败计数达到 5：立刻停止并写 STATUS.md，禁止继续。
- 手环掉出已配对列表或要求重新配对：立刻停止。

## 第 4 步：验证与汇报

必须贴以下原文：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\<脱敏后的实际设备项>" | Select-Object LastConnected,PSChildName
```

以及：

```powershell
cd C:\dev\pulse-band2\core
cargo test --all
cargo build --release
```

报告必须包含：

- 三次连接/认证的逐次结果与失败计数器（历史值 + 本阶段新增值）
- 每步请求/响应的长度、方向、帧头字段、来源包号；敏感字节只写占位符
- “只有已认证对端才会得到”的响应及其可区分依据
- `docs/protocol/auth.md`：每条事实带命令原文 + 输出摘录 + pcapng 路径/sha256/包号；无法证明的标「仍是假设」
- `core/src/session.rs` 实现与测试
- “我确认了什么”和“我没能确认什么”（后者不许为空）

## 完成标准与 Git

只有以下全部满足才可标记阶段 5 完成：

1. 断开重连三次均自动完成认证；
2. 拿到一个只有已认证对端才会返回的可区分响应；
3. authkey/挑战/应答/会话密钥未泄露；
4. `cargo test --all` 与 `cargo build --release` 通过；
5. `auth.md` 证据完整，未知项仍标假设。

达标后做一个阶段 5 commit，message 说明为什么、做了什么、没做什么。未达标就写 STATUS.md 停在阶段 5，不要伪称完成。**不要 git push，等用户验收。**
