# 阶段 3 执行交接单（帧层编解码器）

工作目录 `C:\dev\pulse-band2`，分支 `main`。本文件是本阶段的唯一指令来源。
与 `future_version/STATUS.md` 冲突时**以本文件为准**。

## 开工前必读

1. `docs/protocol/transport.md` 全文 —— 阶段 2/2B 已实证的传输层结论，这是本阶段唯一输入。
2. `future_version/2026-09-08-pulse-v2-native-core.md` 的 §阶段 3 全文、§许可证纪律、§每阶段的通用要求。
3. `core/tests/fixtures/frame-type02-2026-09-08.bin`（30 字节）与 `frame-type03-2026-09-08-02.bin`（16 字节）—— 阶段 2 留下的真实帧测试向量。

---

## 第 −1 条 · 只实现已确认的部分（优先于本文件其余一切内容）

1. **禁止实现 `transport.md` 里标「仍是假设」的内容。** 留 `TODO` 注释说明哪部分是假设，等后续阶段补。
2. **CRC 参数不做可配置。** 只实现阶段 2 已确认的 CRC-16/ARC（poly `0x8005`，init `0x0000`，refin/refout true，xorout `0x0000`），硬编码写死。
3. **测试向量必须用真实帧，预期字节写死。** 禁止用 `encode` 的输出反喂给 `decode` 当"预期"。
4. **五项测试全部通过才算完成，不许用 `#[ignore]` 跳过验收。**
5. **没有真实帧向量就不算帧层完成。**

---

## 已核实的当前状态（2026-09-08 20:15 由 zcode 实测，不要照抄 STATUS.md）

- 阶段 2/2B 已完成并提交：`edd2bfe`（本地 `main` 比 `origin/main` 超前 6 个 commit，**尚未 push**）。
- 证据文件：
  - `baseline-2026-09-08-01.pcapng`（43828 字节，704 包，sha256 `2fe44431...b099`）
  - `baseline-2026-09-08-02.pcapng`（26380 字节，400 包，sha256 `3f3fd740...a377`）
- 已实证的传输层事实（出处 `transport.md`）：
  - 帧结构：`A5A5 | type(1) | seq(1) | len(2 小端) | crc(2 小端) | payload(len)`
  - CRC-16/ARC，仅覆盖载荷，小端，212/212 帧全中
  - seq 按方向+type 分别计数；type=0x01 为 ACK，seq 回显对端 type=0x03
  - 首包方向：主机先发
  - type 取值：`0x01`（ACK，len 恒 0）、`0x02`（协商，len=22）、`0x03`（数据，len 6~68）
- 现有代码结构：
  - `core/src/main.rs`：HTTP RPC 入口
  - `core/src/rpc.rs`：RPC 契约（`DeviceOp` 枚举）
  - `core/src/fake.rs`：假设备（阶段 1）
  - **缺**：`core/src/crc.rs`、`core/src/frame.rs`
- Rust 工具链就绪，`cargo test` 可用。

### 仍是假设、不要实现的部分

- type=0x02 的 TLV 切分细节
- type=0x03 载荷内部字段（`0x0101` 握手与 `0x0102` 业务只知道前缀，后续未逆向）
- `ba dc fe ... ef` 前导帧的字段含义（已确认它是 SPP 底层握手，不是 A5A5 外层封装，但本阶段用不到它）

---

## 授权条款

- **不允许**连接手环。阶段 3 是**纯离线**实现，只写代码和测试。
- **不允许**安装任何新软件或修改依赖（`Cargo.toml` 可以加 `crc` 这类纯算法 crate，但不许加蓝牙库）。
- **不允许**读 OronBox / AstroBox-NG / Gadgetbridge 的源代码。`transport.md` 是唯一协议输入。

---

## 第 1 步 · 实现 CRC-16/ARC（`core/src/crc.rs`）

参数（来自 `transport.md` §4）：
- poly = `0x8005`（反射多项式已写成 `0xA001`）
- init = `0x0000`
- refin = true，refout = true
- xorout = `0x0000`
- 仅覆盖帧的载荷部分（第 8 字节到第 `8+len-1` 字节）

**要求**：
1. 函数签名建议 `pub fn crc16_arc(data: &[u8]) -> u16`。
2. **独立已知答案向量**：因为确认的算法是 CRC-16/ARC（亦称 MODBUS），使用标准向量 ASCII `"123456789"` → `0x4B37`。
   **注意**：不要用 ASCII `"123456789"` → `0x29B1`，那是 CRC-16/CCITT-FALSE；
   CRC-16/ARC 的标准向量是 `0x4B37`（来源：[CRC Catalogue](http://reveng.sourceforge.net/crc-catalogue/16.htm#crc.cat.crc-16-arc)）。
3. 测试至少包含：
   - 独立向量 `assert_eq!(crc16_arc(b"123456789"), 0x4B37);`
   - 空输入 `assert_eq!(crc16_arc(&[]), 0x0000);`
   - 真实帧载荷抽样（从 `transport.md` §4 的 8 帧比对表里挑 2~3 个，
     手工摘出载荷字节写成 `&[0x01, 0x02, ...]`，预期值从表里抄）

**验证输出**：`cargo test crc` 全绿，贴输出原文。

---

## 第 2 步 · 实现帧编解码器（`core/src/frame.rs`）

结构体建议：

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_type: u8,  // type 是关键字，用 frame_type
    pub seq: u8,
    pub payload: Vec<u8>,
}
```

函数签名建议：
- `pub fn encode(frame: &Frame) -> Vec<u8>`：返回完整帧字节（含 magic/type/seq/len/crc/payload）
- `pub fn decode(buf: &[u8]) -> Result<(Frame, usize), DecodeError>`：返回帧和已消耗字节数，支持半包/粘包
- `pub enum DecodeError { Incomplete, InvalidMagic, CrcMismatch, ... }`

**要求**：
1. `encode`：按 `A5A5 | type | seq | len(LE) | crc(LE) | payload` 布局，`len = payload.len() as u16`，
   `crc = crc16_arc(&payload)`，字段小端序。
2. `decode`：
   - 检查 magic 是否 `A5 A5`
   - 读 len（小端），判断是否有完整帧（半包返回 `Incomplete`）
   - 校验 CRC（不匹配返回 `CrcMismatch`）
   - 返回 `Frame` 和已消耗字节数（= `8 + len`）
3. **只实现已确认的 type**：`0x01`、`0x02`、`0x03`。遇到其他 type 返回 `DecodeError::UnknownType`。

**测试**（五项全做）：

1. **真实帧向量测试**（必做，用阶段 2 留下的两个测试向量）：
   ```rust
   #[test]
   fn test_decode_real_frame_type02() {
       let raw = include_bytes!("../tests/fixtures/frame-type02-2026-09-08.bin");
       let (frame, consumed) = decode(raw).expect("decode failed");
       assert_eq!(consumed, 30);
       assert_eq!(frame.frame_type, 0x02);
       assert_eq!(frame.seq, 0x00);
       assert_eq!(frame.payload.len(), 22);
       // 预期载荷前 4 字节（从 transport.md §7 抄）：
       assert_eq!(&frame.payload[..4], &[0x01, 0x01, 0x03, 0x00]);
   }
   
   #[test]
   fn test_decode_real_frame_type03() {
       let raw = include_bytes!("../tests/fixtures/frame-type03-2026-09-08-02.bin");
       let (frame, consumed) = decode(raw).expect("decode failed");
       assert_eq!(consumed, 16);
       assert_eq!(frame.frame_type, 0x03);
       assert_eq!(frame.seq, 0x06);
       assert_eq!(frame.payload, vec![0x01, 0x02, 0x8d, 0xbd, 0x4d, 0xa7, 0xa0, 0xdf]);
   }
   ```

2. **Round-trip 测试**：
   ```rust
   #[test]
   fn test_roundtrip() {
       let orig = Frame { frame_type: 0x03, seq: 0x05, payload: vec![0xAA, 0xBB, 0xCC] };
       let encoded = encode(&orig);
       let (decoded, _) = decode(&encoded).unwrap();
       assert_eq!(decoded, orig);
   }
   ```

3. **校验错误的帧被拒绝**：
   ```rust
   #[test]
   fn test_crc_mismatch() {
       let mut bad = encode(&Frame { frame_type: 0x01, seq: 0x00, payload: vec![] });
       bad[6] ^= 0xFF;  // 破坏 CRC
       assert!(matches!(decode(&bad), Err(DecodeError::CrcMismatch)));
   }
   ```

4. **半包测试**：
   ```rust
   #[test]
   fn test_incomplete() {
       let full = encode(&Frame { frame_type: 0x03, seq: 0x01, payload: vec![0x11, 0x22] });
       let half = &full[..5];  // 只给头 5 字节
       assert!(matches!(decode(half), Err(DecodeError::Incomplete)));
   }
   ```

5. **粘包测试**：
   ```rust
   #[test]
   fn test_multiple_frames() {
       let f1 = encode(&Frame { frame_type: 0x01, seq: 0x00, payload: vec![] });
       let f2 = encode(&Frame { frame_type: 0x03, seq: 0x01, payload: vec![0xAA] });
       let mut buf = f1.clone();
       buf.extend_from_slice(&f2);
       
       let (frame1, consumed1) = decode(&buf).unwrap();
       assert_eq!(consumed1, f1.len());
       assert_eq!(frame1.frame_type, 0x01);
       
       let (frame2, consumed2) = decode(&buf[consumed1..]).unwrap();
       assert_eq!(consumed2, f2.len());
       assert_eq!(frame2.frame_type, 0x03);
   }
   ```

**验证输出**：`cargo test frame` 与 `cargo test` 全绿，贴输出原文（至少显示测试数和 passed 数）。

---

## 第 3 步 · 集成到主模块并跑一次完整测试

1. 在 `core/src/main.rs` 顶部加 `mod crc; mod frame;`。
2. 跑 `cargo test --all` 确认所有测试（包括阶段 1 的 RPC 测试）都还是绿的。
3. 跑 `cargo build --release` 确认编译通过。

**验证输出**：贴 `cargo test --all` 和 `cargo build --release` 的输出原文（至少最后几行显示成功）。

---

## 第 4 步 · 更新 STATUS.md 并提交

在 `future_version/STATUS.md` 写：
- 已完成到哪：阶段 3 完成，`core/src/crc.rs` 与 `core/src/frame.rs` 实现并通过五项测试。
- 下一步：阶段 4（RFCOMM 连接与首包方向，**需手环**）。

提交 message 模板（你自己写，但要包含这些要点）：
- 为什么：阶段 2/2B 已实证帧结构与 CRC，本阶段把协议事实转成可执行代码。
- 做了什么：实现 CRC-16/ARC（独立向量 `0x4B37` 验证）、帧编解码器（真实帧向量 + round-trip + 错误帧 + 半包 + 粘包五项测试全过）。
- 没做什么：type=0x02 TLV 切分、type=0x03 内部字段（标 `TODO`，等后续阶段）。

**不要 `git push`。**

---

## 全程纪律

- 单次无人值守不超过 2 小时。
- 不连接手环、不读 OronBox 源代码。
- `transport.md` 是唯一协议输入，标「仍是假设」的不实现。
- 署名用你自己的身份，不要照抄计划作者的 trailer。
