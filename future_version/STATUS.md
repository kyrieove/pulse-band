# STATUS — 2026-09-08（阶段 3 完成 · 帧编解码器实现 · 准备进入阶段 4）

- **已完成到哪**：
  - 阶段 3 完成：纯离线实现帧层编解码器与 CRC-16/ARC 校验。
  - `core/src/crc.rs`：实现标准 CRC-16/ARC（poly `0x8005`，init `0x0000`，refin/refout true，xorout `0x0000`），包含空载荷校验（`0x0000`）、双会话真实帧抽样载荷校验（#128 `0x7d3e`、#142 `0xb293`、#137 `0xdd0f`），并通过独立已知向量校验（MODBUS 标准向量 `0x4B37` 与 ARC 标准向量 `0xBB3D`）。
  - `core/src/frame.rs`：实现 `Frame` 结构与 `encode`/`decode` 编解码逻辑，五项测试全部通过且无 `#[ignore]`：
    1. 真实帧向量测试（`frame-type02-2026-09-08.bin` 30 字节协商帧、`frame-type03-2026-09-08-02.bin` 16 字节业务帧）；
    2. Round-trip 编解码回环测试；
    3. CRC 校验错误拒绝测试；
    4. 半包数据截断处理测试（返回 `Incomplete`）；
    5. 多帧粘包连续解析测试（精确返回已消费字节数）。
  - `core/src/main.rs`：挂载 `crc` 与 `frame` 模块，`cargo test --all`（12 项测试全部 passed，0 failed），`cargo build --release` 成功构建。
  - `npm test` 19 项测试全部通过，客户端及诊断无回归问题。
  - `transport.md` 中标「仍是假设」的部分（type=0x02 TLV 内部字段切分、type=0x03 内部业务字段序列化）已按规范保留 `TODO` 注释，未主观臆造。
- **卡在哪一步**：无阻塞。阶段 3 纯离线实现已全部闭环。
- **需要人做什么**：
  - 准备真机手环（保持开机、广播或已配对状态），准备进入阶段 4。
- **下一步**：阶段 4（RFCOMM 连接与首包方向，**需手环**）。
