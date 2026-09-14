# 阶段 7 执行交接单（daemon 打包 + 断线恢复测试 · M1 验收）

工作目录 `C:\dev\pulse-band2`，分支 `main`，HEAD 预期 `81c3851`（阶段 6 真实客户端集成通过）或其之后。本文件是本轮唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 目标

把 `pulse-core.exe` 打进 Pulse Dev 安装包，并验证**断线自恢复**达到 **M1 验收**：OronBox 进程不存在时 Pulse Dev 全流程正常（连 `--live`、手环显示额度），且三种断线场景都能自愈。达标后进入 M2 决策（交给用户单独评估，不做）。

## 开工前必读

1. `future_version/2026-09-08-pulse-v2-native-core.md` §阶段 7、§许可证纪律、§每阶段通用要求。
2. `future_version/STATUS.md`、`docs/protocol/business.md`、`docs/protocol/auth.md`（阶段 6 已实证业务协议与数据泵）。
3. `core/src/live.rs`（阶段 6B 数据泵 `--live`：`run_live` 当前**单次**、断线退出；`handle_downlink`；`device_connect_live/status_live/disconnect_live`）。
4. `src/main/services/oronbox-client.ts`（`CORE_EXE` 路径、`ensureDaemon` 复用逻辑、spawn `--fake`）。
5. `src/main/index.ts`（status-server 8765）、`package.json`（build 配置，当前无 `extraResources`）。

## 第 −1 条：敏感与证据纪律（同前，硬性）

1. authkey / W / P / session-key / 解密明文 / 真实额度 / MAC —— 绝不打印、绝不写 docs/fixture/commit/message；日志只用 `<authkey:16B>`、`<mac>` 等占位符。
2. 只读 `device.json` 的字段名/length；不打印 authkey/MAC 值；不改 `device.json`。
3. **禁止连接手环/发包，除非用户明确授权对应真机步骤**（见授权条目）。未授权前只做离线/打包/代码准备。
4. 不删/不改已有 pcapng；不 `git reset --hard`；不 `git push`（等用户验收）。
5. 每条结论带完整命令原文 + 输出摘录；无法证明的标「仍是假设」；报告必须有「我没能确认什么」（不为空），失败优于编造。

## 已知缺口（阶段 7 前先修，按序号做）

1. **`CORE_EXE` 打包路径**：`oronbox-client.ts:24` 用 `path.join(import.meta.dirname, '../../core/target/release/pulse-core.exe')`，仅开发可命中；打包后 `import.meta.dirname` 指向安装目录内，`../../core/target/...` 不存在。需改为：优先读打包进安装包的 `resources/`（见第 2 步 extraResources）下的 `pulse-core.exe`，找不到时回退到开发路径。**不要把 `--fake` 分支硬编码成唯一模式**——`--live` 是当前真实模式。
2. **electron-builder `extraResources`**：`package.json` build 未含 `extraResources`。加一条把 `core/target/release/pulse-core.exe` 拷进 `resources/`（可 `process.resourcesPath` 定位），并以 release 构建产物为准（先 `cargo build --release`）。
3. **`--live` 断线自动重连**：`core/src/live.rs::run_live` 当前单次（断线即 `closesocket`+`WSACleanup`+`return Ok`，进程退出）。断线重连需 `run_live` 外层加**循环重连**（或新增 `--live` 的自动重连策略）：断开后等待重试重新 `connect_and_authenticate`，有限次重试并记录；保持 `core.bt` 在重连期间正确状态。**重连必须走与前一次相同的基础（复用 Session 状态机认证）**，不重复发明。
4. **`daemon.stop` 干净退出**：`--fake` 的 `daemon.stop` 删 `core.json` + 进程退出。确认 `--live` 下 `daemon.stop` 同样删 `core.json`、释放 SPP（`closesocket`）。断线恢复测试需要 `daemon.stop` 干净退出释放链路。

## 第 1 步：前置（运行并贴原文）

```powershell
Get-Process Pulse,oronbox,pulse-core -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
cd C:\dev\pulse-band2\core ; cargo test --all ; cargo build --release
```

- 有 Pulse/oronbox 在跑：停止（请用户自行退出），避免抢连接与端口。
- `device.json` 存在、authkey 16B（只查长度）。
- `cargo test --all`、`cargo build --release` 必须过；失败就如实报告，不伪造。

## 第 2 步：打包集成（离线可做）

- 在 `package.json` build 加 `extraResources`：把 `core/target/release/pulse-core.exe` 拷进安装包 `resources/`；
- 改 `oronbox-client.ts` `CORE_EXE`：优先 `path.join(process.resourcesPath, 'pulse-core.exe')`，`fs.existsSync` 不存在时回退开发路径；
- 验证：`npm run dist` 或 `electron-builder` 出安装包后，解包确认 `resources/pulse-core.exe` 存在、`fs.existsSync(CORE_EXE)` 为真。
- **不要**改 `--fake` 分支语义；`--live` 是真机模式。

## 第 3 步：`--live` 断线自动重连（离线可做）

- 让 `run_live` 外层加重连循环：连上→跑业务循环→断开→记录→重试（建议最多 N=3 次、间隔数秒）→ 重新 `connect_and_authenticate`；
- 重连期间 `core.bt` 里旧 `DownlinkCtx` 应清理、再设置；断线要 `closesocket`+`WSACleanup`（或按需重新 `WSAStartup`）；
- 每条重连日志记录：尝试号、断开原因、重连结果、失败计数。敏感字节占位。
- 加/更新单元测试（如需）；`cargo test --all` `--live` 相关不触网。

## 第 4 步：断线恢复实测（需用户配合 + 授权真机）

三种场景，各测一次，每次记录「断开手段 → 观察 pulse-core 日志 → 是否自动重连 → 手环/Pulse Dev 是否恢复」：
1. **拔蓝牙**（或禁用系统蓝牙）；
2. **手环走出范围**（远离/关机）；
3. **杀掉 core 进程**（`taskkill /IM pulse-core.exe /F`）。

- 恢复后 Pulse Dev 应自动重连 `--live` 并再次显示真机状态；手环显示额度（如适用）。
- 任一场景无法自愈 → 记录并定位（是否重连循环/端点文件/客户端 `ensureDaemon` 未感知新 pid）。

## 第 5 步：回归

```powershell
cd C:\dev\pulse-band2
node --test scripts/test-pc-v1.1.mjs
cd core ; cargo test --all ; cargo build --release
```

- `node --test scripts/test-pc-v1.1.mjs`（19 测试）必须通过；`cargo test --all` 通过。

## 第 6 步：M1 验收（需用户配合）

- **OronBox 进程不存在**时，Pulse Dev 全流程正常：启动 Pulse Dev → 连 `--live`（真机模式）→ 手环 App 显示真实额度数字 → 三种断线自愈。
- 贴：`Get-Process OronBox -ErrorAction SilentlyContinue`（应为空）、Pulse Dev 设备页截图/状态、手环显示、断线恢复日志。

## 汇报格式

必须含：
1. 第 1 步前置命令与原始输出；
2. 打包集成改动与 `resources/pulse-core.exe` 存在证据；
3. `--live` 断线重连实现的代码摘要 + `cargo test --all`/`cargo build --release` 输出；
4. 三种断线场景逐次记录（断开手段→日志→恢复结果）；
5. `node --test scripts/test-pc-v1.1.mjs` 原文输出；
6. **「我确认了什么」** 与 **「我没能确认什么」**（不为空）；
7. 明确结论：是否达 M1 验收、是否进 M2。

## 完成标准（全部须真）

1. `pulse-core.exe` 打进安装包且 `CORE_EXE` 在打包后可寻址；
2. `--live` 断线自动重连，三种场景均自愈；
3. `daemon.stop` 干净退出并释放 SPP 链路；
4. `node --test scripts/test-pc-v1.1.mjs`、`cargo test --all`、`cargo build --release` 全过；
5. M1 验收：OronBox 不存在时 Pulse Dev 全流程正常、手环显示额度、断线自愈。

**不达标**不宣称完成，写 `STATUS.md` 停在阶段 7；**不要 `git push`**，等用户验收。

## 2026-09-09 现场验收结果与范围变更

首次连接、认证、状态查询、`__hs__`、连续额度请求和手动断开后重连均通过真机验证，且没有出现 Windows
配对弹窗或手环“配对失败”。关闭再开启 Windows 蓝牙后等待 60 秒没有自动恢复。

用户随后明确把系统蓝牙开关恢复和离开范围恢复移出当前版本范围，并接受断链后手动重新连接。因此 M1
最终按调整后的产品范围通过。上文原始“三种断线均自愈”标准保留为历史计划与后续可靠性参考，不再作为
当前 M1 或 Pulse 2.0 首版的发布门槛。最新状态以 `future_version/STATUS.md` 为准。

## 授权条目（用户需逐条确认）

- [ ] 授权打包集成与 `CORE_EXE` 路径改造（离线）。
- [ ] 授权 `--live` 断线自动重连代码实现（离线）。
- [ ] 授权**真机断线恢复实测**（拔蓝牙/手环出范围/杀 core，需用户配合物理操作）。
- [ ] 未授权：`git reset`/`git push`、修改或删除 `device.json`、删除 pcapng、读取/输出任何 authkey/挑战应答/会话密钥/MAC/额度原文、进入 M2（产出/卸载 OronBox/发布）。
