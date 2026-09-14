# Pulse 2.0 独立设备管理架构方案

## 1. 项目目标

Pulse 当前主要用于监控 AI Coding Agent，并通过 OronBox 与 Xiaomi Smart Band 10 通信。

当前链路：

```text
Pulse PC
   ↓
OronBox
   ↓
Xiaomi Smart Band 10
```

下一阶段的核心目标是：

> **彻底去除 OronBox 运行依赖，让 Pulse 自己直接连接、认证、管理 Xiaomi Smart Band 10。**

目标链路：

```text
Pulse
   ↓
Pulse Device Core
   ↓
Windows Bluetooth / RFCOMM / Xiaomi Protocol
   ↓
Xiaomi Smart Band 10
```

最终 Pulse 不只是 AI Monitor，而是：

> **AI + PC + Xiaomi Wearable Control Center**

---

## 2. 重点参考项目

### 2.1 AstroBox-NG

GitHub：

https://github.com/AstralSightStudios/AstroBox-NG

主要参考价值：

- React 前端
- Tauri
- Rust Core
- Windows / macOS / Linux / Android / iOS 跨平台
- Rust 实现经典蓝牙 SPP
- Rust 实现 Xiaomi VelaOS wearable 协议栈
- IPC 抽象层
- Core 与 UI 解耦
- 插件化设计

AstroBox-NG 证明了一条非常重要的技术路线：

```text
React
  ↓
Tauri IPC
  ↓
Rust Core
  ↓
Bluetooth SPP
  ↓
Xiaomi Wearable
```

因此 Pulse 长期架构优先考虑：

```text
React + Tauri + Rust
```

而不是继续把所有底层能力写在 Electron / Node.js 中。

> 注意：AstroBox-NG 使用 AGPL-3.0，并包含额外署名条款。  
> Pulse 可以参考其架构、协议行为和模块划分，但不应直接复制其源代码。

---

### 2.2 OronBox

GitHub：

https://github.com/zxor-org/OronBox

OronBox 当前已经可以直接管理 Xiaomi VelaOS / ZeppOS wearable，其主要参考价值不是 Flutter UI，而是其设备层设计。

值得参考的结构：

```text
Transport
   ↓
Xiaomi Device Component
   ↓
Dispatcher
   ↓
Systems
```

OronBox 把设备功能拆分为多个独立 System，例如：

```text
Auth
Info
Mass Transfer
Install
Apps
Watchface
Sync
Health
Network
GNSS
Media
Screenshot
```

此外，它还采用统一的命令接口，例如：

```text
device.connect
device.disconnect
app.list
app.launch
watchface.list
watchface.set
watchface.remove
```

这说明 UI 不应该直接调用底层协议逻辑，而应该通过统一 command / IPC 层访问设备功能。

> 注意：OronBox 使用 AGPL-3.0。  
> Pulse 不应直接复制、翻译或移植 OronBox 的 Dart/C++ 代码到 Rust/TypeScript。  
> 更适合把它作为协议行为、模块设计和测试结果的参考。

---

## 3. Pulse 2.0 推荐总体架构

推荐架构：

```text
┌──────────────────────────────┐
│          Pulse UI            │
│      React / TypeScript      │
│                              │
│  AI Monitor                  │
│  Device                      │
│  Apps                        │
│  Watchfaces                  │
│  Automation                  │
│  Health                      │
└──────────────┬───────────────┘
               │
             Tauri
               │
          Command / IPC
               │
┌──────────────▼───────────────┐
│      Pulse Device Core       │
│            Rust              │
│                              │
│ Transport                    │
│ Protocol                     │
│ Dispatcher                   │
│ Auth                         │
│ Device Info                  │
│ Install                      │
│ Apps                         │
│ Watchfaces                   │
│ Health                       │
│ Sync                         │
└──────────────┬───────────────┘
               │
      Bluetooth Classic SPP
               │
┌──────────────▼───────────────┐
│   Xiaomi Smart Band 10       │
└──────────────────────────────┘
```

---

## 4. 推荐目录结构

```text
pulse-band/

web/
  src/
    pages/
    components/
    features/
      ai/
      device/
      apps/
      watchfaces/
      automation/
      health/

src-tauri/
  src/
    commands/
      device.rs
      apps.rs
      watchfaces.rs
      health.rs

    device/
      transport/
        mod.rs
        windows_spp.rs

      protocol/
        mod.rs
        packet.rs
        crypto.rs
        protobuf.rs
        dispatcher.rs

      systems/
        auth.rs
        info.rs
        sync.rs
        install.rs
        apps.rs
        watchface.rs
        health.rs

      runtime/
        device_manager.rs
        event_bus.rs
        request_pool.rs
```

---

## 5. 设计原则

### 5.1 UI 不直接碰协议

错误方向：

```text
React
→ Bluetooth
→ Xiaomi packet
```

推荐：

```text
React
→ Tauri Command
→ Rust Device Core
→ Bluetooth
```

UI 只调用：

```text
device.connect
device.disconnect
device.info
device.syncTime

apps.list
apps.install
apps.launch
apps.uninstall

watchfaces.list
watchfaces.install
watchfaces.set
watchfaces.remove
```

---

### 5.2 Transport 与 Protocol 分离

Bluetooth 只负责：

```text
scan
connect
read
write
disconnect
```

它不应该知道：

```text
authkey
watchface
RPK
health
```

Protocol 只负责：

```text
packet framing
encryption
serialization
protobuf
request / response
```

这样未来可以扩展：

```text
Windows SPP
macOS SPP
Linux SPP
BLE
```

而不需要重写 Xiaomi protocol。

---

### 5.3 功能 System 化

借鉴 OronBox 的思路：

```text
AuthSystem
InfoSystem
InstallSystem
AppSystem
WatchfaceSystem
HealthSystem
SyncSystem
```

每个 System 独立负责一个功能领域。

优点：

- 易测试
- 易扩展
- 不会形成单个巨型 Xiaomi 文件
- 后续支持 Redmi Watch / Xiaomi Watch 时可复用

---

## 6. 第一阶段：彻底摆脱 OronBox

第一阶段只支持：

> Xiaomi Smart Band 10

暂时不考虑多设备和跨平台。

实现顺序：

```text
Windows Bluetooth
      ↓
SPP / RFCOMM connect
      ↓
Xiaomi packet framing
      ↓
authkey authentication
      ↓
device info
      ↓
battery / firmware
      ↓
sync time
      ↓
interconnect
      ↓
RPK install
```

第一阶段完成标准：

```text
关闭 OronBox
↓
启动 Pulse
↓
Pulse 自己连接 Band 10
↓
完成认证
↓
读取设备信息
↓
Pulse Band App 正常通信
```

此时可以正式删除：

```text
Pulse → OronBox
```

依赖。

---

## 7. 第二阶段：设备管理

实现：

### Device

```text
scan
connect
disconnect
battery
storage
firmware version
device info
sync time
```

### Apps

```text
list
install
launch
uninstall
```

### Watchfaces

```text
list
install
set
remove
```

目标是替代目前 OronBox 中 Pulse 真正需要的核心功能。

---

## 8. 第三阶段：Pulse 差异化能力

Pulse 不应该变成另一个 OronBox。

Pulse 的核心差异应该继续围绕：

```text
AI
+
PC
+
Wearable
+
Automation
```

例如：

```text
Claude finished
→ Band vibration

Codex task finished
→ Band notification

Quota < 20%
→ Band warning

Agent running
→ real-time wrist status

Meeting starts
→ enable DND

PC locked
→ trigger wearable state

Build failed
→ Band alert
```

这些功能才是 Pulse 相比 AstroBox / OronBox 的核心优势。

---

## 9. 第四阶段：健康与 Mi Fitness 替代方向

后期再逐步实现：

```text
steps
heart rate
sleep
SpO₂
workout
calories
health history
local database
data export
```

进一步可考虑：

```text
alarms
weather
GNSS
firmware
music
voice recordings
screenshots
device settings
```

最终目标可以逐渐接近 Mi Fitness 的设备管理能力，但不建议在早期投入这些功能。

---

## 10. 技术栈建议

### 前端

继续使用：

```text
React
TypeScript
Tailwind
```

Pulse 当前已有 React UI，因此迁移成本相对可控。

---

### 桌面框架

长期推荐：

```text
Tauri 2
```

原因：

- Rust 是一等公民
- React ↔ Rust IPC 原生
- 比 Electron + Rust `.node` 更自然
- 更适合未来跨平台
- 更适合设备管理软件
- AstroBox-NG 已验证该路线

---

### Device Core

推荐：

```text
Rust
```

负责：

```text
Bluetooth
SPP
RFCOMM
crypto
protobuf
Xiaomi protocol
file transfer
device runtime
```

---

## 11. Electron 是否马上删除

不建议现在立即进行 Electron → Tauri 全量迁移。

推荐顺序：

```text
阶段 A
Rust 独立验证 Band 10 SPP

阶段 B
Rust 完成 auth + device info

阶段 C
Rust Device Core API 稳定

阶段 D
再迁移 React UI：
Electron → Tauri
```

原因：

如果一开始同时处理：

```text
Electron → Tauri
+
Bluetooth
+
Xiaomi Protocol
```

出现问题时难以判断错误来源。

---

## 12. 第一项技术验证

建议首先创建：

```text
experiments/
  rfcomm-probe/
```

只实现：

```text
1. 枚举 Windows Bluetooth Classic 设备
2. 找到 Xiaomi Smart Band 10
3. 建立 RFCOMM / SPP socket
4. 输出连接状态
5. 打印 raw RX / TX bytes
```

暂时不实现：

```text
auth
protobuf
RPK
watchface
health
```

成功标准：

```text
OronBox 完全关闭
+
rfcomm-probe 能独立连接 Band 10
```

这是整个 Pulse Native Device Core 的第一个关键里程碑。

---

## 13. 第二项技术验证

SPP 成功后：

```text
authkey
↓
Xiaomi authentication handshake
↓
authenticated state
```

成功标准：

```text
Pulse Rust Core
→ Band 10
→ authentication success
```

---

## 14. 第三项技术验证

完成：

```text
device info request
```

并获取：

```text
model
firmware
battery
storage
```

成功以后证明：

> Pulse 已具备完整的基础 request / response Xiaomi protocol 能力。

---

## 15. 许可证策略

Pulse 当前希望保持自己的独立代码库。

需要严格避免：

```text
直接复制 AstroBox-NG Rust 代码
直接复制 OronBox Dart/C++ 代码
把 AGPL 文件翻译成 Rust
小改变量名后放入 Pulse
```

推荐方法：

```text
研究公开项目行为
↓
整理协议文档 / packet format
↓
记录 input / output
↓
独立重新实现
↓
建立自己的测试
```

即 Clean-room / independent implementation 思路。

需要重点参考：

AstroBox-NG：

https://github.com/AstralSightStudios/AstroBox-NG

OronBox：

https://github.com/zxor-org/OronBox

但 Pulse 最终运行时不依赖二者。

---

## 16. 最终产品结构

```text
Pulse

AI
├─ Claude
├─ Codex
├─ Antigravity
└─ Future Agents

Device
├─ Xiaomi Smart Band 10
├─ Battery
├─ Storage
├─ Firmware
└─ Settings

Apps
├─ Install
├─ Launch
└─ Remove

Watchfaces
├─ Browse
├─ Install
├─ Switch
└─ Remove

Automation
├─ Agent Events
├─ PC Events
├─ Quota Alerts
└─ Custom Rules

Health
├─ Steps
├─ Heart Rate
├─ Sleep
├─ SpO₂
└─ Workout

                ↓

        Pulse Device Core
                ↓
        Xiaomi Wearable
```

---

# Claude 评估重点

请重点评估以下问题：

## A. 架构

是否认同：

```text
React + Tauri + Rust Device Core
```

作为 Pulse 长期架构。

是否有比 Tauri 更合适的选择。

---

## B. Bluetooth

Windows 上直接实现 Xiaomi Smart Band 10 的：

```text
Bluetooth Classic
SPP
RFCOMM
```

推荐使用什么 Rust crate / Windows API。

是否需要直接调用：

```text
Windows.Devices.Bluetooth.Rfcomm
WinRT
Winsock Bluetooth
```

---

## C. Xiaomi Protocol

建议如何分层：

```text
Transport
Packet
Crypto
Dispatcher
Request Pool
Systems
```

是否有更合理的设计。

---

## D. Electron → Tauri

Pulse 当前 Electron + React 项目迁移到 Tauri：

```text
哪些代码可以直接保留
哪些必须重写
主要风险是什么
```

---

## E. Clean-room / License

在参考：

https://github.com/AstralSightStudios/AstroBox-NG

以及：

https://github.com/zxor-org/OronBox

的情况下，如何最大程度避免 Pulse 新实现被视为 AGPL 派生代码。

---

## F. 第一阶段范围

是否认同第一阶段只实现：

```text
Band 10
↓
SPP
↓
Auth
↓
Device Info
↓
Interconnect
↓
RPK Install
```

而暂时不处理：

```text
health
weather
firmware
GNSS
multi-device
cross-platform
```

---

## G. 最终需要 Claude 给出的结论

请给出：

1. 对此架构的总体评价
2. 最大技术风险
3. 最大许可证风险
4. 是否建议 Electron → Tauri
5. Rust Device Core 推荐目录结构
6. 第一阶段详细开发顺序
7. 最适合作为第一项 PoC 的代码目标
