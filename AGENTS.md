# Pulse 2.0 核心工程纪律与开发规约 (Pulse 2.0 Engineering Disciplines)

后续 Pulse 2.0 项目所有任务必须严格遵守以下 14 条工程纪律：

## 1. 禁止伪完成 (Zero Fake Completion)
- 任何功能必须严格区分：【界面存在】、【接口存在】、【业务逻辑存在】、【真实设备执行存在】。
- 严禁因为创建了 UI、TypeScript 类型、状态机、Mock、RPC 接口就判定功能完成。
- 严禁添加 `completed`、`success`、`installed` 等代表最终结果的状态，除非该状态来自真实后端或真实物理设备返回。
- 严禁使用固定值、定时器、假进度、模拟返回冒充真实能力。
- 若当前阶段仅为框架或占位实现，必须显式且明确标记为 `placeholder`、`mock`、`not implemented`。

## 2. 严禁直接编码，执行先审计后开发 (Audit Before Coding)
- 每次开发前必须先审计已有能力，不允许直接开始写代码。
- 强制执行顺序：
  1. 检索已有 `interface`、`service`、`bridge`、`IPC`、`RPC`、`protocol`、`hardware` 层实现；
  2. 严谨判定当前能力归属：
     - `[A] 已实现真实能力`
     - `[B] 部分实现`
     - `[C] 仅有接口/类型`
     - `[D] 完全不存在`
  3. 根据实际对账情况制定最小修改方案。
- 严禁仅凭函数名判定功能存在（例如存在 `installRpk()`、`connectDevice()` 等函数，绝不代表真实安装或真实连接已实现）。

## 3. 禁止重复造轮子 (Strict Reuse & Zero Redundant Wheels)
- 开发前必须全量检索已有 client、service、bridge、事件系统、状态管理。
- 项目若已有 RPC client、Core bridge、IPC 通道，必须无条件复用，严禁为了单一功能创建第二套 RPC client、第二套事件系统或第二套状态管理。

## 4. 严格遵守四层架构边界 (Architectural Layering & Boundaries)
- **Renderer**：只负责用户交互和状态展示；严禁直接操作文件系统或设备。
- **Preload**：只负责安全 IPC 桥接；严禁内联业务逻辑。
- **Main**：只负责业务编排、文件处理、IPC 分发；严禁假装拥有硬件能力。
- **Core**：负责设备通信协议与硬件能力；严禁返回未经验证的 UI 成功状态。
- 严禁任何形式的跨层越权实现。

## 5. 开发前强制输出端到端实际调用链 (End-to-End Call Chain Audit)
开始任何新功能前，必须先在回复中输出实际调用链并标注每层状态：
```text
Renderer          [implemented / mock / missing / unknown]
  ↓
Preload           [implemented / mock / missing / unknown]
  ↓
Main Service      [implemented / mock / missing / unknown]
  ↓
Core RPC          [implemented / mock / missing / unknown]
  ↓
Hardware Protocol [implemented / mock / missing / unknown]
  ↓
Device            [implemented / mock / missing / unknown]
```
状态定义：
- `[implemented]`：已实现真实能力
- `[mock]`：模拟能力
- `[missing]`：缺失能力
- `[unknown]`：未确认能力
**未完成调用链分析与标注前，绝对不允许开始写代码。**

## 6. 测试必须验证真实数据流闭环 (Verify Real Dataflow, Not Just Execution)
- `npm test`、`npm run build`、`cargo test` 通过仅证明代码语法与基本用例可用，不能等同于业务完成。
- 测试必须验证真实数据流：例如不能仅测试 `prepare()` 返回成功，必须验证是否调用目标 RPC、RPC 失败是否正确向上传播、错误是否经过脱敏处理。

## 7. 严格控制修改范围与防爆闸门 (Surgical Scoping & Blast Radius Control)
- 完成一个任务只能修改与任务直接相关的文件。严禁借机重构周边模块。
- 除非用户明确要求，绝对禁止修改：
  - `core/src/live.rs`
  - `core/src/session.rs`
  - 蓝牙通信层
  - 设备协议层
  - 已有稳定 IPC

## 8. 提交报告强制五问对账 (Pre-Commit Five Mandatory Questions)
每次提交代码前必须逐项回答以下五个问题，并写入提交报告：
1. **当前功能是否连接真实设备？**
2. **当前功能是否调用真实 Core？**
3. **当前是否存在 Mock？**
4. **哪些状态仍然只是占位状态？**
5. **下一阶段缺少什么能力？**

## 9. 交付报告四分类清晰隔离 (Quad-Classification Delivery Report)
提交报告必须严格按照四项分类输出：
- **Implemented**：真实完成内容
- **Mock / Placeholder**：模拟或占位内容
- **Not implemented**：尚未完成内容
- **Next step**：下一阶段任务
**严禁使用“完成安装能力”、“完成连接能力”、“完成闭环”等扩大性描述，除非整个真实物理链路已端到端验证。**

## 10. 提交前强制安全与敏感词扫描 (Strict Security & Secret Sanitization)
每次提交前必须对新增和修改代码执行敏感词全量正则扫描：
- `token`
- `secret`
- `credential`
- `privateKey`
- `mac`
- `deviceAddress`
- `install.local`
敏感信息不得进入 Renderer，不得出现在用户可见 UI。

## 11. 未知协议与行为严禁盲猜 (Zero Guesswork for Hardware/Protocols)
- 遇到未知协议、未知设备行为、未知数据格式时禁止推测或捏造。
- 必须明确标记 `[unknown]`，并通过代码反编译、抓包日志、官方文档或实机实验进行交叉验证。

## 12. 提交前强制质量五步闭环 (Mandatory Pre-Commit Verification Suite)
每次提交前必须依次执行并确认通过：
1. `git diff`（检查修改范围）
2. `git diff --check`（检查格式与多余空白）
3. `npm test`（前端/Main 自动化测试）
4. `npm run build`（生产打包构建）
5. `cargo test`（涉及 Core 时）

## 13. 实事求是，禁止夸大 (Fact-Based Objective Reporting)
所有开发报告必须客观指出：
- 修改了什么；
- 没有修改什么；
- 真实链路到达哪里；
- 哪里仍然断开；
- 测试验证了什么；
- 没有验证什么。

## 14. 阶段定性准确规范 (Infrastructure vs Feature Semantics)
- 如果当前任务仅搭建了抽象层、中间件或数据流管线，必须明确表述为：
  **“完成 XXX 基础设施”**
- 严禁表述为：
  **“完成 XXX 功能”**
