# 阶段 5D 执行交接单（真机受控认证 + 失败对照 + 三次断开重连验收）

工作目录 `C:\dev\pulse-band2`，分支 `main`，HEAD 预期为 `525de7e`（阶段 5C 已提交）或其之后。本文件是本轮唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 目标

在**用户明确解除真机闸门**后，用阶段 5C 已验证的 `core/src/session.rs` 会话状态机 + RFCOMM 连接，执行一次受控真机认证；采集一次**真实失败对照**（补 auth.md 的失败判据缺口）；最后做**三次独立断开重连的自动认证验收**。达标即标志阶段 5 完成。

> 本步骤是**真实硬件操作**（连手环、发认证帧）。与阶段 1~5C 的离线动作性质不同，执行前必须由用户明确授权（见「授权条目」）。未获用户确认前，只允许完成文档与准备，**不得连接设备、不得发包**。
>
> **用户已确认（2026-09-09）：只做「三次断开重连验收」，失败对照本轮不执行。** 因此第 1 步跳过，授权条目中「失败对照」置为未授权。

## 开工前必读（按顺序）

1. `future_version/STATUS.md`、`docs/protocol/auth.md`（第 4 节成功/失败判据，第 5 节下一步）。
2. `future_version/PHASE5C-BRIEF.md` 与 `core/src/session.rs`（已实现的会话状态机；`Session::new(authkey)`、`start_auth`、`process_frame`、`handle_timeout`/`handle_disconnect`）。
3. `docs/protocol/transport.md`（帧结构、首包顺序、非 A5A5 前导帧）。
4. `core/src/rfcomm.rs`（阶段 4 的 WinSock 连接/收发帮助函数，`--probe` 只作连接参考，**不得**把认证流程混进 probe，也不得照抄 probe 里硬编码的 MAC）。
5. `core/src/main.rs`（真机入口如何接入 session）。

## 第 −1 条：敏感信息与证据纪律（硬性，阶段 5D 尤其严格）

1. **authkey、W（device_random）、P（app_random）、dec_key/enc_key、dec_nonce_cm/enc_nonce_cm、app_sign、device_sign、CompanionDevice 明文——绝不打印、绝不写 docs、绝不写源码、绝不进 commit message、绝不进 fixture。** 日志只能写占位符：`<authkey:16B>`、`<W:16B>`、`<P:16B>`、`<session-key:16B>`、`<sign:32B>`、`<cm-plaintext:NB>`。
2. MAC 只写 `<mac>`，**禁止硬编码**到代码；必须从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读取。`rfcomm.rs` 里已有的硬编码真实 MAC 是阶段 4 遗留，本轮**不得新增**任何真实 MAC 到代码。
3. `device.json` 只读取字段名、MAC 是否存在、authkey 长度；**禁止打印值**。真机阶段从它读 authkey 进内存，不落日志、不写盘、不打印。
4. 认证算法只采用 `auth.md` §2 公式与 `session.rs` 已实现；拿不准的一律标「仍是假设」，不要发明。
5. **每次连接都必须打印**：连接尝试号、connect 结果、发送步骤来源包号/方向/长度/type/seq/CRC、脱敏 hexdump（敏感字段用占位符）、decode 结果、认证状态转移。原始 hexdump 若含敏感字节，一律先脱敏再输出。
6. 不得删除、覆盖、重新生成任何已有 pcapng；不得修改 `device.json`；不得 `git reset --hard`；新证据用新文件名。
7. 报告失败优于编造成功。任何"已确认/验证通过"都要附完整命令原文 + 输出摘录。

## 第 0 步：真机闸门解除的前置闸门（用户授权 + 环境检查）

只有**同时满足**以下 a~g 才可继续；任一不满足立即停止并写 STATUS.md。

环境检查（运行并贴原文）：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
# 脱敏配置检查：只打印字段名 / authkey 长度(应为 16*2=32 hex) / connectType / addr 是否存在
```

- a. **用户已明确授权本阶段解封真机**：允许连接手环、发送认证帧、做一次失败对照、三次断开重连。（无此授权 → 停止。）
- b. `Get-Process Pulse,oronbox` 输出为空（无 OronBox/Pulse 在运行，避免抢连接）。非空 → 立即停止，严禁 kill，请用户自行退出。
- c. `device.json` 存在、JSON 可解析、authkey 恰为 16 字节。缺失/异常 → 停止并报告，不猜、不生成、不从蓝牙注册表推导。
- d. Windows 蓝牙配对项仍存在；若需重新配对才可继续 → 立即停止并请用户介入。
- e. 保护计数器记录：连接失败、发包失败的历史值 + 本阶段新增值；本阶段新增连接失败 ≥3 或发包失败 ≥5 立即停止。
- f. 本次仅连接目标设备（MAC 从 device.json 读，只打印 `<mac>`），不得尝试其他设备或服务；SPP UUID 固定 `00001101-0000-1000-8000-00805F9B34FB`。
- g. 建立连接后先发**第 1 步认证帧**前，先按 `transport.md` §9 发非 A5A5 前导帧（`badcfe00c00300000100ef`），并确认收到前导响应（`badcfe00000600010200030140ef`）。若前导阶段对端已断链或超时 → 视为发包失败计数，按停止规则处理。

## 第 1 步：失败对照（**本轮不执行，请直接跳到第 2 步**）

> 本步含**故意向设备发送错误数据**，是真实硬件的异常输入，可能有非预期副作用（比如把设备端设备状态弄乱、触发断链/超时）。**用户本轮未授权，故不执行**；下面的设计仅留作后续如需补充失败判据时的参考。

设计（目的：观察"设备认证失败时的返回/断链/超时行为"，补 auth.md §4 缺口）：

- 用**真实 authkey** 走 Step 1（发 app_random）→ 收 Step 2（含 W 与 device_sign）。
- 由于 authkey 正确，客户端会通过 Step 2 的 `device_sign` 校验——**不能用错误 authkey**（那样会在 Step 2 就客户端失败，观察不到设备端反应）。
- **构造一个错误 Step 3** 发给设备：用「错误的 enc_key 或篡改 app_sign/CCM tag」。实现上需要 session.rs 提供一个**专门的可注入构造钩子**（`Session::start_auth_with_broken_step3(...)` 或一个 `#[cfg(test)]`/feature 下的构造函数），**只允许用随机/错误 key 造坏负载，绝不修改真实 authkey**。构造出的错误 Step3 帧脱敏后发送。
- 记录设备对此错误 Step3 的反应，三选一并记录动作：返回 `confirm_result=false` / 断链 / 超时。
- 该结果写入一个**新的脱敏文档或附加到 auth.md**（每帧带命令原文 + 输出摘录 + 包号/方向/长度），并如实标注这只是一次观察，不代表所有失败形式。
- **限制**：失败对照只做 1 次；若导致设备断链 → 记 `LinkBroken`；若设备无响应超时 → 记 `Timeout`；都不要反复试。对照结束后必须重新建立一次干净连接再继续第 2 步。

## 第 2 步：三次独立断开重连的自动认证验收（主体）

三次（第 1、2、3 次连接），每次全部完成：

1. 建立 RFCOMM 连接（MAC 从 device.json 读，不硬编码）。
2. 发非 A5A5 前导帧，确认前导响应。
3. 发 Step 1（`Session::start_auth`，app_random 用 CSPRNG），记录来源/长度/方向/type/seq/CRC/脱敏 hex。
4. 收 Step 2（DeviceVerify）：解 `W`(16B)、`device_sign`(32B)；`session.process_frame` 内部校验 `device_sign == HMAC(dec_key, W||P)`；校验通过则产出 Step 3。
5. 发 Step 3（AppConfirm）：`app_sign = HMAC(enc_key, P||W)`、`encrypt_companion_device = AES-128-CCM(enc_key, enc_nonce_cm||8*0, protobuf(CompanionDevice), 空AAD)`。
6. 收 Step 4（DeviceConfirm）：解 `confirm_result`；**仅当 `confirm_result == true` 且会话处于等待确认阶段** → `Authenticated`。false/字段缺失/乱序/重复/超时/断链 → `Failed`，该次连接记为失败，按停止规则处理。
7. 记录**可区分响应**：认证成功后收到 Step4 confirm=true 且会话进入 `Authenticated`；可选地尝试一笔业务方向（`01 02`，用已实现的 `business_keys()`）并记录，作为"只有已认证对端才返回"的进一步佐证。
8. 显式 `closesocket` 释放链路；确认链路已释放（可 GetProcess/socket 状态或打印关闭结果）。
9. 记录当次：连接尝试号、connect 结果、各步骤来源包号/长度/方向/脱敏 hex、decode 结果、认证状态转移、失败计数器（历史 + 本阶段新增）。

三次都**自动完成认证**才算阶段 5 达标。任何一次失败：
- 连接失败累计 ≥3 → 立即停止写 STATUS.md；
- 发包失败累计 ≥5 → 立即停止写 STATUS.md；
- 手环掉出已配对列表或要求重新配对 → 立即停止。

## 第 3 步：验证与汇报

必须贴以下命令**原文输出**：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\<脱敏后的实际设备项>" | Select-Object LastConnected,PSChildName
cd C:\dev\pulse-band2\core
cargo test --all
cargo build --release
cd C:\dev\pulse-band2
git status --short
git log --oneline -5
```

报告必须包含：

- 第 0 步前置检查命令与原始输出；
- 三次连接/认证的**逐次结果**与失败计数器（历史值 + 本阶段新增值）；
- 每步请求/响应：来源包号、方向、长度、帧头 type/seq/len/CRC、**脱敏** hexdump；敏感字节只写占位符；
- "只有已认证对端才会得到"的可区分响应及其可区分依据；
- `docs/protocol/auth.md` 更新：每条事实带完整命令原文 + 输出摘录 + 设备操作日期；无法证明的标「仍是假设」；
- **「我确认了什么」** 与 **「我没能确认什么」**（后者**不许为空**）；
- 最终明确一行：是否三次自动认证通过、是否达阶段 5 完成标准、是否进入阶段 6。

## 完成标准（阶段 5 达标，全部须真）

1. 三次独立断开重连**均自动完成认证**；
2. 拿到一个**只有已认证对端才返回**的可区分响应；
3. authkey/挑战应答/会话密钥/MAC 未泄露（检查 `git status`、`git diff`、日志、提交 message）；
4. `cargo test --all` 与 `cargo build --release` 通过（贴原文）；
5. `docs/protocol/auth.md` 证据完整，未知项仍标「仍是假设」。

达标后做一个阶段 5 完成 commit，message 说明为什么、做了什么、没做什么。**未达标**就写 `future_version/STATUS.md` 停在阶段 5，不要伪称完成。**不要 `git push`，等用户验收。**

## 授权条目（用户已确认 2026-09-09）

- [x] 授权解封真机：允许连接手环（Xiaomi Smart Band 10，MAC 从 device.json 读）、发送认证帧、做三次断开重连验收。
- [x] 授权在 `docs/protocol/auth.md` 更新本轮事实性证据（脱敏），并在必要处新增条目。
- [ ] 授权做**失败对照**：允许故意发送一次错误 Step 3 以观察设备失败返回/断链/超时。（用户本轮**未授权**，故不执行，跳过第 1 步。）
- [ ] 未授权：`git reset`/`git push`、修改或删除 `device.json`、删除 pcapng、读取或输出任何 authkey/挑战应答/会话密钥/MAC 原文、连接非目标设备、进入阶段 6 之外的下一步。
