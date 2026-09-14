# 未知协议样本管理 (Protocol Captures Repository)

本目录用于集中管理小米手环 10 (Xiaomi Smart Band 10) 快应用安装及相关交互流程中的真实蓝牙通信报文样本。

## 1. 目录定位与管理目标

在逆向与实证分析小米私有手环协议的过程中，严禁基于凭空臆测编写操作码（Opcode）或冒充完成安装能力。所有协议推进必须遵循实证流程：

```text
真实抓包 / Frida Hook / HCI Log
              ↓
  样本脱敏与结构化记录 (.json)
              ↓
  samples-manifest.json 纳管
              ↓
  ProtocolInspector / ProtocolReportGenerator 自动化分析
              ↓
  MockDeviceReplayTransport 仿真断言与证伪测试
              ↓
  形成已验证协议规范
```

## 2. 样本分类与文件规范

- **原始模板**: `sample-rpk-exchange-template.json`（标准 Recorder 交换日志模板）
- **样本清单**: `samples-manifest.json`（集中记录所有样本的元数据、来源与分析状态）
- **样本命名规范**: `capture-<场景>-<来源>-<YYYYMMDD>-<序号>.json`
  - 示例: `capture-app-install-btsnoop-20260910-01.json`

## 3. 安全与脱敏强制规范 (Sanitization Standard)

在将任何抓包样本加入本目录前，必须严格执行脱敏审计，禁止包含任何个人隐私或设备密钥：
1. **禁止包含真实 MAC 地址 / Bluetooth Device Address**：必须替换为 `AA:BB:CC:DD:EE:FF` 或占位符；
2. **禁止包含 Auth Key / Shared Secret / Session Key / Token**；
3. **禁止包含真实个人信息**（如小米账号 ID、步数/心率等隐私体征数据）；
4. **禁止包含私有局域网或内部环境地址**（如敏感凭证）。

## 4. 分析状态定义 (Analysis Status Lifecycle)

清单 `samples-manifest.json` 中每个样本必须标注明确的 `analysis_status`：
- `pending_audit`: 刚捕获入库，尚未经过格式与结构完整性审计；
- `in_progress`: 正在进行 Protobuf 探测、TLV 字段提取或 CRC 验证；
- `analyzed`: 已生成 Markdown 取证分析报告，字段与行为已清晰归类；
- `replayed`: 已接入 `MockDeviceReplayTransport` 完成端到端时序仿真与断言测试。
