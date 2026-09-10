# 样本分析备注：CAPTURE-20260910-001

## 1. 样本概览
- **样本 ID**: CAPTURE-20260910-001
- **测试设备**: Xiaomi Smart Band 10 (M2345B1)
- **客户端版本**: Mi Fitness v3.35.0
- **数据流**: 4 帧双向流（2 帧下行指令 + 2 帧上行 ACK）

## 2. 载荷特征
- Frame 1 & 3: 采用 Protobuf Wire 编码，包含 Field 1 与 Field 2 基础标识字段；
- Frame 2 & 4: 1 字节通用 ACK (`0x00`) 确认回复。
