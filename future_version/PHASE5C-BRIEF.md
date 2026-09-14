# 阶段 5C 执行交接单（会话认证状态机 + 合成离线测试，不连真机）

工作目录 `C:\dev\pulse-band2`，分支 `main`。本文件是本轮唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 目标

基于**已离线闭环并复现**的认证算法，编写 `core/src/session.rs` 会话认证状态机，并配套**纯离线合成测试**。本步骤不连接手环、不发真机包、不改产品真机行为；只做协议逻辑与状态机，为下一步“真机受控认证验收”准备好代码和测试。

## 开工前必读（按顺序）

1. `future_version/STATUS.md` —— 当前阶段位置与闸门。
2. `docs/protocol/auth.md` —— **认证算法唯一依据**（第 2 节公式、第 3 节复现、第 4 节成功/失败判据、第 5 节下一步）。
3. `docs/protocol/transport.md` —— 帧结构 `A5A5 | type | seq | len(2 LE) | crc(2 LE) | payload` 与首包顺序。
4. `docs/protocol/auth-verification.txt` —— 已通过的脱敏验证输出（作为理解基线）。
5. `core/src/frame.rs` —— **必须复用**其 `encode`/`decode` 和 `crc16_arc`，不要另写一套 CRC 或帧切分。
6. `core/src/rfcomm.rs` —— 这是阶段 4 的**探测代码**，只供参考连接方式，**不是**会话/认证层，不得把它当成 `session.rs` 的替代或把探测流程塞进 session。
7. `core/src/main.rs` —— 模块注册方式（`mod session;`）。
8. `tools/verify_auth.py` —— 已有、已 PASS 的离线算法验证脚本（Python，依赖 `cryptography` 库 + 本地 tshark）。**密码学正确性以它为准**，不要在 `session.rs` 里重复验证算法的对错。

## 第 −1 条：敏感信息与证据纪律（硬性）

1. **authkey、会话密钥、challenge/response、解密出的明文凭据，绝不打印、绝不写 docs、绝不写源码、绝不进 commit message、绝不进 fixture。** 日志只用占位符：`<authkey:16B>`、`<challenge:NB>`、`<response:NB>`、`<session-key:NB>`、`<dec:int>`。
2. `%LOCALAPPDATA%\PulseDev\run\device.json` 本步骤**只允许验证存在性、authkey 长度**，不许打印其值；`session.rs` 运行时读取它用于真机阶段，但本步骤的**单元测试用合成/任意 authkey**，绝不读真实 authkey。
3. 认证算法只能采用 `docs/protocol/auth.md` 第 2 节的确定公式；与公式不符或拿不准的标「仍是假设」，不要实现，不要发明。
4. **禁止**自行实现 AES/HMAC/SHA/HKDF/CCM/CTR 等密码学原语。使用成熟 crate（见下）。
5. **禁止连接手环、禁止发送任何真机数据、禁止运行 `cargo run -- --probe`、`cargo run -- --fake` 之外的任何真机路径。** 本步骤结束时 `pulse-core` 不应作为蓝牙客户端连过任何设备。
6. 不得删除、覆盖、重新生成任何已有 pcapng；不得修改或删除 `device.json`；不得 `git reset --hard`。
7. 报告失败优于编造成功。没有命令原文 + 输出摘录的结论只能说「仍是假设」。

## 当前已确认的认证算法（摘自 auth.md §2，作为实现输入）

会话帧：`payload` 前 2 字节为 `01 01`，其后是 protobuf；外层 type/id 见下表，`Account` 是 protobuf 的字段号。

| 步骤 | 方向 | payload | type/id | Account 字段 | 内层字段 |
|---|---|---:|---|---|---|
| 1 | Host → Band | 29B | 1/26 | 30 AppVerify | 1 app_random：16B |
| 2 | Band → Host | 63B | 1/26 | 31 DeviceVerify | 1 device_random：16B；2 device_sign：32B |
| 3 | Host → Band | 68B | 1/27 | 32 AppConfirm | 1 app_sign：32B；2 encrypt_companion_device：21B |
| 4 | Band → Host | 22B | 1/27 | 33 DeviceConfirm | 1 confirm_result：bool；2/3 device_capability / device_capability_2：uint32 |

`P` 为 phone nonce，`W` 为 watch nonce，`A` 为 authkey（16B）；切片右端不包含；`HMAC` 为 HMAC-SHA256：

```text
PRK = HMAC(key=P || W, msg=A)
T1  = HMAC(key=PRK, msg=ASCII("miwear-auth") || 0x01)
T2  = HMAC(key=PRK, msg=T1 || ASCII("miwear-auth") || 0x02)
OKM = T1 || T2                       # 共 64B
dec_key = OKM[0:16]                  # Band → Host 方向密钥
enc_key = OKM[16:32]                 # Host → Band 方向密钥
dec_nonce_cm = OKM[32:36]
enc_nonce_cm = OKM[36:40]
device_sign = HMAC(key=dec_key, msg=W || P)
app_sign    = HMAC(key=enc_key, msg=P || W)
```

Step 3 的 21B 字段：

```text
nonce = enc_nonce_cm || 8 个零字节            # 共 12B
AAD = 空
plaintext = protobuf(CompanionDevice)          # 观测为 17B，字段形状 1:varint, 3:string, 4:uint32
encrypt_companion_device = AES-128-CCM(enc_key, nonce, plaintext, AAD)
                         = ciphertext || tag_4B     # 共 21B
```

业务流 `01 02`：AES-128-CTR，每方向用对应 `dec_key`/`enc_key` 作 IV（16B 大端初始计数器），每条消息重置 IV。**本步骤只实现/测试到会话认证完成（Step 4），业务 CTR 可留接口/占位，不强制推商业务载荷。**

成功判据（auth.md §4）：会话处于「等待 DeviceConfirm」阶段、已验证 Step 2、已生成并发送 Step 3、收到**正确方向 + type/id 分支 + Account 字段 33 + 字段 1 `confirm_result=true`**。false、字段缺失、乱序、重复、超时、断链都不能升级为成功。

## 第 0 步：前置闸门

运行并贴原文：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
```

- Pulse/oronbox 输出非空：立即停止，严禁 kill，写 STATUS.md 请用户自行退出。
- `device.json` 不存在或 JSON 无法解析或 authkey 非 16 字节：立即停止并报告；不要猜、不要生成、不要从蓝牙注册表推导。
- 读取 `device.json` 时只打印字段名、authkey 长度，禁止打印值。
- 若需要重新配对才可继续：立即停止并请求用户介入。

## 第 1 步：加密码学依赖

`core/Cargo.toml` 当前只有 `serde`, `serde_json`, `rand`。新增（版本以 cargo 实际解析为准，需 `cargo test` 编译通过；本步结束后 `cargo build --release` 也要通过）：

```toml
hmac = "0.12"
sha2 = "0.10"
aes = "0.8"
ctr = "0.9"
ccm = "0.5"
hkdf = "0.12"
```

- 用 `ccm::Ccm<Aes128, U4>` 做 AES-128-CCM，nonce 12B，**4 字节 tag**（默认 tag 会追加在密文尾部；实现后用合成向量验证 tag 正好 4B）。
- HKDF 的 extract/expand 语义必须等于本文件算式（`HKDF-SHA256`，salt=`P||W`，ikm=`A`，info=`"miwear-auth"`，输出 64B）。**不要想当然**，要用一个合成的 `(A,P,W)` 对照 `tools/verify_auth.py` 既有的同算法输出（或手写固定向量）确认对齐，再继续。
- 不要手写字节序、不要手写 AES 轮函数；全部走 crate。

说明：你可以用 `verify_auth.py`（Python `cryptography`，已 PASS）作为一致性基准——在本地用同一个合成 `(A,P,W)` 分别用 Python 和 Rust 计算 `OKM` / `app_sign` / `encrypt_companion_device`，比对一致后再写 session。这不连网络、不连设备，安全。

## 第 2 步：实现 `core/src/session.rs` 会话状态机

新建 `core/src/session.rs`，在 `main.rs` 注册（`mod session;`）。要求：

1. **状态显式枚举**：`Disconnected`、`TransportConnected`、`Authenticating`、`Authenticated`、`Failed`，语义与 `docs/protocol/auth.md` 的分界一致。
2. **与 I/O 解耦**：会话层不直接碰 WinSock。用一个内部 `Session` 结构体，吃进「已解码的 `Frame`」与「当前认证材料」；`process_frame(&mut self, frame) -> Result<SessionEvent, SessionError>` 更新状态并可能产出「下一步应发送的 `Frame`/动作」。这样单测可用合成帧驱动，完全不触网。真机 socket 接线（复用 `rfcomm.rs` 的 WinSock 帮助函数）留待真机闸门解除后的阶段，不在本步实现为自动收发循环。
3. **复用 `frame.rs`**：构造/解析帧用 `frame::encode`/`frame::decode`；CRC 用 `crate::crc::crc16_arc`；不复制第二套。
4. **认证流程**：
   - 初始 `TransportConnected`。开始认证：生成 `app_random`（16B，非 secret，可打印长度与占位符），构造并产出 Step 1 帧（type=0x03，type/id=1/26，payload=`01 01` + protobuf(Account AppVerify)+…）。
   - 收到 Step 2（DeviceVerify）：解出 `device_random`(16B)、`device_sign`(32B)；若 `device_sign` ≠ `HMAC(dec_key, W||P)` → `Failed`。
   - 构造 Step 3（AppConfirm）：`app_sign=HMAC(enc_key,P||W)`、`encrypt_companion_device=AES-128-CCM(enc_key, enc_nonce_cm||8*0, protobuf(CompanionDevice), 空AAD)`；产出 Step 3 帧（type=0x03，type/id=1/27，payload=`01 01` + protobuf）。**`CompanionDevice` 的序列化必须与 auth.md 观察的 17B 形状（1:varint、3:string、4:uint32）一致**；真实设备名/能力常量本步骤可用任意合法合成值（测试专用），不要伪造真机值，也不要触碰真实抓包明文。
   - 收到 Step 4（DeviceConfirm）：解出 `confirm_result`(bool)。**只有 `confirm_result == true` 且状态在「等待确认」** 才 `Authenticated`；`false`、字段缺失、顺序不符 → `Failed`。
5. **任何失败路径**（HMAC 不匹配、CCM tag 失败、confirm=false、字段缺失、解码失败、校验失败、乱序、超时、断链）都 → `Failed` 并**停止该连接**，不得自动无限重试。
6. **未知/未确认项留 `TODO`**，并在代码注释里写「仍是假设」，不要凭空解释。业务 `01 02` CTR 只留接口签名和注释，不确定部分不实现。
7. 结构体与函数上尽量用「长度 + 占位符」注释说明敏感字段（如 `authkey: 16B`），不出现真实值。

## 第 3 步：合成离线单元测试

`core/src/session.rs` 内加 `#[cfg(test)]`；测试只触内存，不触网、不读 device.json、不含真实凭据。用**测试专用随机 authkey** 和合成 nonce 生成各步帧。覆盖：

1. **合法全链路**：Step1→Step2(正确 device_sign)→Step3→Step4(confirm=true) → `Authenticated`。
2. **错误 HMAC**：Step2 的 `device_sign` 用错 key/错数据 → `Failed`，不升级。
3. **CCM tag 损坏**：Step3 构造的密文 tag 被篡改（本地负对照）→ 解密失败 → `Failed`。
4. **confirm=false**：Step4 `confirm_result=false` → `Failed`。
5. **字段缺失**：Step4 缺 `confirm_result` 或 Step2 缺 `device_sign` → 失败，不升级。
6. **乱序/重复**：在非等待阶段收到确认帧，或收到重复的 Step 2/Step 4 → 不升级为成功。
7. **超时/断链**：模拟等待确认超时或链路断开事件 → `Failed`。

每个测试断言**最终状态**与**是否产出下一步帧**，用 `assert!`/`assert_eq!`。测试里对敏感材料只用合成的占位字节，不要写真实值。

## 第 4 步：验证与汇报

必须贴以下命令的**原文输出**（每条命令 + 完整 stdout/stderr）：

```powershell
cd C:\dev\pulse-band2\core
cargo test --all
cargo build --release
```

- `cargo test --all` 与 `cargo build --release` 必须都成功；失败就如实贴错误并停在验证，不要伪造「通过」。
- 汇报必须包含：
  1. 第 0 步前置检查命令与原始输出；
  2. 用合成 `(A,P,W)` 做的 `OKM/app_sign/encrypt_companion_device` 一致性校验（Python verify 与 Rust 结果），附脱敏输出；
  3. `core/src/session.rs` 的状态机结构、状态枚举、核心函数签名、关键 `TODO`（标「仍是假设」处）；
  4. 单元测试列表与通过情况；
  5. **「我确认了什么」**；
  6. **「我没能确认什么」**（**不许为空**，比如：业务 CTR 未实现、未做真机认证、未做三次重连验收）。
- 报告末尾加一句明确结论：**本步骤未完成阶段 5 的真机三次断开重连认证验收；阶段 5 仍未完成；未进入阶段 6；未连接任何设备。**

## 完成标准与本轮边界

本轮（阶段 5C，纯离线）达标 = 以下全部满足：

1. `core/src/session.rs` 已注册且编译通过；
2. 状态机五个状态显式存在，认证成功判据 = 正确分支 + `confirm_result==true`；
3. 上述七类单元测试全部通过（`cargo test --all`）；
4. 敏感字节未泄露到源码/fixture/日志/commit；
5. 未连接任何设备、未发真机包；
6. `cargo build --release` 通过。

**不达标**不要宣称完成。**不要 `git push`**，等用户验收。本轮预期只新增 `core/src/session.rs`、`core/Cargo.toml`（依赖）及必要的测试；不改 `frame.rs`、`rfcomm.rs`、`fake.rs` 的行为，不改 `device.json`，不删除任何 pcapng。提交 message 不得含任何敏感字节。

## 授权条目（用户本轮明确授权）

- 授权：在 `core/Cargo.toml` 增加上述密码学依赖（hmac/sha2/aes/ctr/ccm/hkdf）用于会话认证状态机。
- 授权：新建 `core/src/session.rs` 并写合成离线测试。
- 授权：用本地合成 `(A,P,W)` 与 `tools/verify_auth.py` 做一致性校验。
- **未授权**：连接手环、发送真机数据、运行 `--probe`/`--fake`、进入阶段 6、修改或删除 `device.json`、删除 pcapng、`git reset`、`git push`。
