# 阶段 6A 执行交接单（离线业务协议取证：fetch 请求 / 额度响应 / 包名路由）

工作目录 `C:\dev\pulse-band2`，分支 `main`，HEAD 预期为 `0d6ac10`（阶段 5C/5D 交接单已入库）或其之后。本文件是本轮唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 目标

阶段 6（额度往返，需手环）的任务是把设备侧业务链路接通：Pulse Dev 连 pulse-core，手环上 App 显示真实额度数字，续 10 分钟不掉线。设备侧业务数据结构目前**仍是未知**。本阶段 6A 在**不连接手环、不发真机包**的前提下，用已有的两份抓包（`baseline-2026-09-08-01/02.pcapng`）把业务消息离线逆向清楚，产出「能否实现业务数据泵 / 额度往返」的**可信依据**。

## 开工前必读（按顺序）

1. `docs/protocol/auth.md` —— 第 2 节业务密钥推导、第 3 节业务 CRC/加密验证（尤其`业务 01 02 使用 AES-128-CTR，key=方向密钥，IV=该 key 的 16B 值`）。
2. `tools/verify_auth.py` —— 已有的认证审计脚本，**已实现业务帧解密与 protobuf 外层解析**（第 196~223 行是关键：`payload_fields` 映射、`modes.CTR(key)` 解密、`fields(decoded)` 解析）。**复用它的方法和结论，不要重造一套。**
3. `docs/protocol/transport.md` §7 —— 业务数据组 `0x0102` 的已知信息（公共前缀恒为 `01 02`，内部字段含义仍是假设）。
4. `docs/protocol/rpc-contract.md` —— 客户端侧 `device.interconnect.send` / `device.interconnect` 协议的契约（§1.4）。
5. `future_version/2026-09-08-pulse-v2-native-core.md` §阶段 1、§阶段 6 —— 客户端假设备往返与额度链路的背景。

## 第 −1 条：敏感信息与证据纪律（硬性）

1. **authkey、W、P、dec_key/enc_key、业务帧解密出的明文（可能含真实用户会话、额度、token、设备/账户标识）——绝不打印、绝不写 docs、绝不写源码、绝不进 commit。** 日志与文档只用占位符：`<authkey:16B>`、`<session-key:16B>`、`<plaintext:NB>`、`<fetch-param:NB>`、`<quota:...>`。
2. authkey 只从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读入内存，用于解密；**禁止打印其值**。
3. 抓包里的真实用户数据（若解密后可见）不得原文进入任何文档；只描述**结构**（字段号、wire type、长度、取值类型），并用占位符掩盖敏感内容。
4. 只能采用 `auth.md` 已验证的加密与消息外层；解密用 `verify_auth.py` 同款的 AES-128-CTR。**不得**凭空发明消息字段、包名、序号规则。
5. **禁止连接手环、禁止发送任何数据、禁止运行 `cargo run`（`--probe`/`--fake`/`--auth` 均不跑）。** 本步骤只做文件内的离线分析。
6. 不得删除、覆盖、重新生成已有 pcapng；不得修改 `device.json`；不得 `git reset --hard`；新脚本/新证据用新文件名。
7. 报告失败优于编造成功。每条结论附**完整命令原文 + 输出摘录**；缺一项就标「仍是假设」。

## 第 0 步：前置闸门

运行并贴原文：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
Test-Path "C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng"
Test-Path "C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng"
python tools/verify_auth.py
```

- 任一进程在运行 → 立即停止，不要 kill，请用户自行退出。
- 任一 pcapng 缺失 → 立即停止并写 STATUS.md。
- `verify_auth.py` 应输出 `RESULT=PASS`（证明认证/业务外层解密能力正常）。若它失败 → 停止，先查明原因，不要再往下写。

## 第 1 步：写一个业务流解密 + 结构 dump 脚本

新建 `tools/decrypt_business.py`，**复用 `verify_auth.py` 的**做法（可 import 其函数或复制其加密/解析逻辑，不要改 `verify_auth.py`）。要求：

- 从 `device.json` 读 authkey 进内存（不打印）。
- 用与 `verify_auth.py` 完全相同的 KDF 派生 `enc_key`/`dec_key`。
- 遍历两份 pcapng 所有 `type=0x03` 且 payload 以 `01 02` 开头的帧（业务帧）。
- 对每条业务帧：方向 `0`(host→band) 用 `enc_key`、方向 `1`(band→host) 用 `dec_key`，以 **AES-128-CTR、IV=该 key** 解密 `payload[2:]`，得到明文 protobuf。
- dump 每条消息的结构树：只输出**包号、方向、流内偏移、type/id、字段号、wire type、各字段长度、敏感值占位符**。原始明文与真实值不进终端输出之外（保持脱敏）；如需打印示例值，必须用占位符。
- 输出一份**按时间线（包号序）排序**的消息清单，标识哪条像 fetch 请求、哪条像 fetch 响应（依据：方向、包号先后、type/id、字段形状）。

命令样例（供参考，以实际脚本为准）：

```bash
python tools/decrypt_business.py baseline-2026-09-08-01.pcapng
python tools/decrypt_business.py baseline-2026-09-08-02.pcapng
```

## 第 2 步：识别 fetch 请求 / 响应 / 额度数据结构

基于第 1 步 dump，逐条确认：

1. **fetch 请求消息**（host→band 或 band→host，包号靠前）：字段有哪几个、类型、长度；特别是 URL、http method、headers 的位置。对照 `docs/protocol/rpc-contract.md` 的客户端 fetch 契约（`url`、`options.method`）与 `fake.rs` 的假手环 fetch 请求形状。
2. **fetch 响应消息**（方向相反、包号在请求之后）：字段有哪几个；额度数据（如 `limits`、`sessions`、`pct5h`/`pct7d`/`level5h`/`level7d`/`resetText`/`authoritative` 这类 leanLimit/leanSession 形状）出现在哪个字段、怎么嵌套。
3. **包名路由**：`com.codeisland.band` 是否出现在消息里；是否需要注册/订阅（看是否有先导的订阅/注册消息）。
4. **分片 / 序号 / 确认 / 加密组合**：业务帧是否有超过单帧的消息、是否跨帧分片、序号从哪里来。结合 `transport.md` §6 seq/ACK 机制判断。

对每个判据，给出「命令原文 + 输出摘录 + pcapng 路径 + 包号/字节范围」。拿不准的标「仍是假设」。

## 第 3 步：对照公开依据确认（可选加强）

如第 2 步结构能对应上公开消息定义（OronBox 的 protos 或第三方文档），可据此**给字段名/语义命名**，但：
- 抓包解密的结构是**第一依据**，公开定义的字段名仅作标注；
- 若公开依据与抓包无法对应，以抓包为准，并在文档里说明；
- 不要读未获授权的源码（若用户未授权，则只读公开文档/issue/逆向文章，不读源码）。

## 第 4 步：产出与判定

- 更新 `docs/protocol/`（建议新建 `docs/protocol/business.md`）记录：fetch 请求/响应的字段结构、包名路由、分片/序号规则、额度数据结构，每条标注「来源：自己抓包 · 2026-09-08」+ 命令原文 + 输出摘录 + 包号/字节范围；无法证明的标「仍是假设」。**只写结构与占位符，不写敏感明文。**
- 明确回答：**「能否实现业务数据泵 + 额度往返（阶段 6）」**。若能完整列出 fetch 请求/响应字段与额度数据结构并给出可独立复现的解密示例 → 可建议进入阶段 6B（实现数据泵）；若仍有未知 → 明确报告「业务语义仍未知，不能实现数据泵」，并列出具体缺口。
- 必须贴：
  ```powershell
  cd C:\dev\pulse-band2
  git status --short
  git diff --stat
  ```
- 只提交必要的脱敏文档与脚本；不要提交 device.json、敏感明文、临时文件；不要 `git push`。

## 汇报格式（必须含）

1. 第 0 步前置检查命令与原始输出；
2. 业务流解密脚本与两条 dump 命令的原始输出（脱敏）；
3. fetch 请求/响应/额度数据结构结论（每条带证据）；
4. 「我确认了什么」；
5. 「我没能确认什么」（**不许为空**，例如：packet id 的语义、时序约束、是否需要订阅、未知字段）；
6. 明确结论：能否实现阶段 6 数据泵 / 还需什么证据。

## 完成标准（阶段 6A 达标）

1. 能离线解密并在两份抓包上复现全部业务帧结构（不依赖真机）；
2. 能明确指出 fetch 请求、fetch 响应、额度数据三者的 protobuf 字段结构；
3. 明确包名路由与分片/序号机制（或明确标记为「仍是假设」并给出验证方法）；
4. 敏感信息（authkey/解密明文/真实用户数据）未泄露；
5. 结论明确：是否足以进入阶段 6B（业务数据泵实现）。

**不达标**不宣称完成；**未授权**（连接手环、发包、运行 `--auth`/`--probe`/`--fake`、改 `device.json`、删 pcapng、`git reset`、`git push`）一律不执行。
