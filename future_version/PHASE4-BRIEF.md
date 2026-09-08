# 阶段 4 执行交接单（RFCOMM 连接与首包方向 · ⚠️ 需手环真机）

工作目录 `C:\dev\pulse-band2`，分支 `main`。本文件是本阶段的唯一指令来源。
与 `future_version/STATUS.md` 冲突时**以本文件为准**。

⚠️ **本阶段首次连接真机手环，保护条款从第一次连接尝试就生效。**

---

## 开工前必读

1. `docs/protocol/transport.md` 全文 —— 阶段 2/2B 已实证的传输层结论，特别是 §5 首包方向。
2. `future_version/2026-09-08-pulse-v2-native-core.md` 的 **§0.5（闸门 / 前置检查 / 手环保护条款）** 全文、
   §阶段 4 全文、§许可证纪律。
3. `core/src/frame.rs` —— 阶段 3 实现的帧编解码器。

---

## 第 −1 条 · 手环保护条款（优先于本文件其余一切内容）

**本阶段首次连接真机手环，以下规则从第一次连接尝试就生效，跨阶段不清零。**

1. **连接失败计数 ≥3 次 → 立刻停止，写 STATUS.md 记录现象并请用户介入。**
   连接失败指 `connect()` 返回错误（如 `No RFCOMM channel available`、超时、拒绝连接）。
2. **发包失败计数 ≥5 次 → 立刻停止，写 STATUS.md 记录现象并请用户介入。**
   发包失败指连接成功后，发送帧收到可区分的错误响应（非 ACK、错误码、链路断开）。
3. **每次开工前必须跑前置检查**（`Get-Process Pulse,oronbox -ErrorAction SilentlyContinue`），
   输出非空 → **严禁 `taskkill` / `Stop-Process`**，写 STATUS.md 请用户自己退出 Pulse（含托盘）并停止。
4. **手环需要重新配对才能恢复 → 立刻停止，写 STATUS.md 并请用户介入。**
   任何操作导致手环从 Windows 蓝牙设置的"已配对"列表消失，或需要重新输入配对码，都算触发此条。
5. **单次无人值守不超过 2 小时。**

---

## 已核实的当前状态（2026-09-08 21:00 由 zcode 实测，不要照抄 STATUS.md）

- 阶段 3 已完成并推送：`a542f6f`，`f2bd878` 清理临时脚本（本地 `main` 与 `origin/main` 同步）。
- 已实证的传输层事实（出处 `transport.md`）：
  - 帧结构：`A5A5 | type(1) | seq(1) | len(2 小端) | crc(2 小端) | payload(len)`
  - CRC-16/ARC（poly `0x8005`，init `0x0000`，refin/refout true，xorout `0x0000`），仅覆盖载荷，小端，212/212 帧全中
  - **首包方向（§5）：主机先发** —— 两会话实测都是主机先发 #112/#108 非 A5A5 前导帧，随后主机发 #115/#111 第一个 A5A5 帧（type=0x02）
  - type=0x01 为 ACK（len 恒 0），seq 回显对端 type=0x03
  - type=0x02 为协商帧（len=22），type=0x03 为数据帧（len 6~68）
- 已实现的编解码器：`core/src/frame.rs`（12/12 测试全过）、`core/src/crc.rs`。
- 手环：Xiaomi Smart Band 10，MAC `04:34:C3:97:9A:06`，Windows 侧已配对（注册表 `BTHPORT\Parameters\Devices\0434c3979a06`）。
- **保护条款计数器初始值**：连接失败 0 次，发包失败 0 次（本阶段首次生效）。

---

## 授权条款

- **允许**连接手环真机，**但必须遵守保护条款**。
- **不允许**修改依赖或安装新软件（Winsock API 是 Windows 系统自带，不算新软件）。
- **不允许**读 OronBox / AstroBox-NG / Gadgetbridge 的源代码。
- **不允许**凭空构造探测帧 —— 必须从阶段 2 抓包里复制 OronBox 发的第一个包，或从 `transport.md` 已确认的格式构造。

---

## 第 0 步 · 前置检查（每次开工必做）

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
```

贴**输出原文**。非空 → 写 STATUS.md 并**停止**，请用户退出。输出为空才进第 1 步。

---

## 第 1 步 · 4a 链路（连接手环）

在 `core/src/main.rs` 或新建 `core/src/rfcomm.rs` 实现 RFCOMM 连接：

**Windows Winsock API 关键参数**：
- `socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM)`
- `SOCKADDR_BTH { btAddr = 0x069A97C33404, serviceClassId = SPP UUID {00001101-0000-1000-8000-00805F9B34FB}, port = 0 }`
  （`port=0` 让系统通过 SDP 自动解析 RFCOMM 通道号）
- MAC 地址 `04:34:C3:97:9A:06` 转为 `u64` 大端：`0x069A97C33404`
- SPP UUID：标准串口仿真 UUID

**Rust 实现建议**：
- 用 `windows` crate（`windows = "0.58"`）调用 Winsock2 API
- 或用 `winapi` crate（`winapi = { version = "0.3", features = ["winsock2", "ws2bth"] }`）
- 或直接 `unsafe` 调 `ws2_32.dll` 导出函数

**要求**：
1. 只做连接，不发数据。连接成功后立刻记录「连接成功」并进第 2 步。
2. 连接失败 → 计数器 +1，贴**完整错误信息**（Win32 错误码 + 描述）。
   - 若计数器 < 3：等 5 秒后重试（最多 3 次）
   - 若计数器 ≥ 3：写 STATUS.md 停止，**不许强行继续**
3. 特殊错误处理：
   - `No RFCOMM channel available` (WSAECONNREFUSED 10061) → 检查 OronBox 是否未退干净、手环是否在 Windows 蓝牙设置里已配对
   - `Access denied` → 检查是否需要管理员权限
4. 连接成功后不要立刻 `closesocket`，留给第 2 步用。

**验证输出**：贴连接尝试的完整日志（成功 / 失败 + 错误码 + 重试次数 + 最终状态）。

---

## 第 2 步 · 4b 观察（带超时读）

连接成功后，设置 10 秒接收超时（`setsockopt(SO_RCVTIMEO, 10000)`），调用 `recv`：

**要求**：
1. **只记录观察结果，不下结论**：
   - 收到数据 → 记 hexdump（前 128 字节），贴原文
   - 超时无数据 → 记「10 秒观察窗口内未收到数据」
2. **这一步不能推出首包方向** —— 无数据可能是链路没就绪、或需要先完成下层握手。
   首包方向以阶段 2 抓包（`transport.md` §5）为准：**主机先发**。
3. 观察完后保持连接，不要 `closesocket`，留给第 3 步用。

**验证输出**：贴观察日志（收到数据的 hexdump / 超时无数据的确认）。

---

## 第 3 步 · 4c 探测（发首包，找可区分响应）

按阶段 2 抓包里的主机首包顺序发送（`transport.md` §5 与 §9）：

**首包序列（必须按此顺序）**：
1. **前导帧**（`ba dc fe` 开头，`transport.md` §9）：
   - 主机发 11 字节：`ba dc fe 00 c0 03 00 00 01 00 ef`
   - 预期手环回 14 字节：`ba dc fe 00 00 06 00 01 02 00 03 01 40 ef`
2. **type=0x02 协商帧**（`transport.md` §7）：
   - 用 `core/src/frame.rs` 的 `encode` 构造：
     ```rust
     let nego = Frame {
         frame_type: 0x02,
         seq: 0x00,
         payload: vec![0x01, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0xfc, 0x03, 0x02, 0x00, 0x20, 0x00, 0x04, 0x02, 0x00, 0x10, 0x27]
     };
     let raw = encode(&nego);
     ```
   - 预期手环回 type=0x02（len=22）或 type=0x01 ACK（len=0，seq=0x00）

**要求**：
1. 每发一个包后，等 5 秒收响应，记 hexdump。
2. 收到响应 → 用 `core/src/frame.rs` 的 `decode` 解析，记录 `frame_type`、`seq`、`payload.len()`。
3. **可区分响应的判定**：
   - type=0x01 且 seq 与发出的 type=0x02 seq 一致 → ACK
   - type=0x02 或 type=0x03 → 数据响应
   - 其他 type 或解析失败 → 记为「非预期响应」
4. 若前导帧或协商帧任一收到**可区分的错误**（非 ACK、链路断开、超时） → 发包失败计数器 +1。
   - 若计数器 < 5：可以继续尝试下一个包
   - 若计数器 ≥ 5：写 STATUS.md 停止，**不许强行继续**
5. 完成探测后显式 `closesocket`。

**验证输出**：贴每个包的发送 hexdump + 响应 hexdump + 解析结果。

---

## 第 4 步 · 收尾与自评

1. 再跑一次第 0 步前置检查，贴输出。
2. 确认手环在 Windows 蓝牙设置里仍是"已配对"状态（截图或注册表路径存在性检查）。
3. 更新 `future_version/STATUS.md`：
   - 记录 4a/4b/4c 结果
   - 记录保护条款计数器终值（连接失败 X 次，发包失败 Y 次）
   - 若任一计数器触发上限，写明卡在哪一步、现象、需要用户做什么
4. 提交（一个阶段一组 commit，message 说清**为什么**，署名用你自己的身份）。

**完成标准**：
- 4a 连接成功
- 4b 观察结果记录在案（有数据 / 无数据）
- 4c 至少拿到一个**可区分的响应**（ACK 或数据帧，能用 `decode` 解析）
- 保护条款计数器未触发上限
- 手环仍在 Windows"已配对"列表

**若 4a 连接失败 ≥3 次或 4c 发包失败 ≥5 次**：
- 不算本阶段失败，算遇到技术障碍
- 在 STATUS.md 写清现象（错误码 / 响应内容 / 计数器值）
- 写明需要用户做什么（检查配对状态 / 重启手环 / 提供诊断信息）
- **不要 `git push`，等用户确认。**

**不要 `git push`，等用户确认。**

---

## 全程纪律

- 严格遵守保护条款，计数器触发上限立刻停止。
- 前置检查发现 Pulse/oronbox 在跑 → 停止，**不许 kill**。
- 手环需要重新配对 → 立刻停止。
- 不读 OronBox / AstroBox-NG / Gadgetbridge 的源代码。
- 单次无人值守不超过 2 小时。
