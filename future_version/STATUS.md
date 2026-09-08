# STATUS — 2026-09-08（阶段 2 取证完成，等人关掉 btvs / Wireshark 窗口）

- **已完成到哪**：阶段 2 第 0~5 步全部做完，产物 `docs/protocol/transport.md`。
  - 第 0 步：前置检查两次输出均为空（开工时、取证后各一次）。
  - 第 1 步：`.gitignore` 补 `core/tests/fixtures/`、`*.pcapng`、`*.pcap`，提交 `c575208`。
  - 第 2 步：BTP 1.14.0 → `C:\BTP\v1.14.0\x86\btvs.exe`（10.0.25146.1001）。
  - 第 3 步：`baseline-2026-09-08-01.pcapng`，43828 字节，
    sha256 `2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099`，704 包，
    其中 btrfcomm 253 / 含 data 237。切出 `A5A5` 帧 304 个，截断 0 个。
  - 第 4/5 步：`docs/protocol/transport.md`，每条结论带命令 + 输出原文 + 包号；
    测试向量 `core/tests/fixtures/frame-type02-2026-09-08.bin`（30 字节，git 已忽略）。
- **抓包方式变更（已生效）**：btvs 的 24352 只接受单个客户端，槽位被 btvs 自己拉起的 dumpcap 占用
  （新连接被拒 WSAError 10061，无 LISTENING 套接字；提权进程，沙箱内 taskkill 拒绝访问）。
  故改为复用 GUI 那路 dumpcap 的落盘文件，由用户 Save As 到仓库路径。
  副作用：用户的 Save As 落到了中途快照同名的 `baseline-2026-09-08-01.pcapng`，
  该文件现在是完整会话（704 包，25748 → 43828 字节），中途那份 25748 字节的快照已不存在。
- **卡在哪一步**：不卡取证。只剩收尾：`btvs.exe`（PID 24328）与 `Wireshark.exe`（PID 9580）仍在运行，
  是提权进程，沙箱内关不掉。
- **需要人做什么**：关闭 Wireshark 窗口与 btvs 窗口（抓包已停止、文件已存盘，可以直接关）。
- **下一条命令**：按阶段 2 完成标准自评的结论是「帧边界 / 长度规则 / 字段布局 / 校验参数 / 完整帧向量」
  五项均有原始字节支撑，可进阶段 3；但 type=0x03 载荷格式、type=0x01 的 ACK 回显规则、
  `ba dc fe ... ef` 前导帧三项**仍是假设**，进阶段 3 前需按 `transport.md` 第 6/7/9 节列的取证动作
  再抓一次新会话（新文件名，不覆盖现有 pcapng）。
