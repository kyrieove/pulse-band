# STATUS — 2026-09-09（阶段 7 · daemon 打包集成与断线恢复离线实现完成 · 真机恢复验收未执行）

- **已有基础与历史事实**：
  - 阶段 1–5 完成（协议帧层、RFCOMM 通信、状态机认证真机三次验收 3/3 PASS）。
  - 阶段 6A/6B 完成：自研 `pulse-core --live` 与业务数据泵真机闭环验证通过（commit `d6aaede` & `81c3851`），手环已成功显示真实额度。
- **本次完成（阶段 7 离线实现）**：
  1. **安装包集成**：在 `package.json` 的 electron-builder 配置中加入 `extraResources`，成功把 `core/target/release/pulse-core.exe` 复制到安装包 `resources/pulse-core.exe`。执行 `npm run dist` 实测产物已存在（`release\win-unpacked\resources\pulse-core.exe`，1,892,212 字节）。
  2. **客户端路径与启动策略**：
     - 在 `src/main/services/oronbox-policy.ts` 中抽取纯函数 `resolveCoreExePath`、`resolveDaemonArgs` 及重试决策函数；
     - `src/main/services/oronbox-client.ts` 打包环境优先寻址 `resources/pulse-core.exe`，未打包回退开发路径；
     - `ensureDaemon()` 根据设备配置自适应启动：正式设备环境存在 `device.json` 时启动 `--live`，测试/假设备环境启动 `--fake`。
  3. **`--live` 断线自动恢复与并发安全**：
     - `core/src/live.rs::run_live` 外层实现 `ReconnectPolicy` 有限重连循环，遵守 §0.5 保护条款最多重试 3 次，每次重试间隔 3 秒，成功后重置计数；
     - 每次重试均重新执行 `connect_and_authenticate` 建立全新 Session 认证与业务密钥；
     - 并发安全：链路断开清理时先从 `core.bt.lock().unwrap().take()` 取走 `DownlinkCtx` 再调用 `rfcomm::closesocket`，彻底避免下行 RPC 写入已关闭 socket；
     - 脱敏纪律：日志绝不输出 MAC、authkey、nonce、密钥、业务明文或额度；
     - 状态反映：`device.status` 与 `device.state` 实时反映 `connecting`、`ready`、`reconnecting`、`error`、`disconnected`。
  4. **`daemon.stop` 优雅退出**：
     - `core/src/rpc.rs` 收到 `daemon.stop` 后先向客户端发回成功响应；
     - 设置 `shutdown_requested = true` 中止重连循环；
     - 清除 `core.bt` 并显式释放 SPP socket（`closesocket` + `WSACleanup`）；
     - 发送 TCP FIN 并删除 `core.json` 后退出进程。
  5. **自动化测试与回归验证**：
     - `core`: `cargo test --all` 25 个测试全部 PASS；`cargo build --release` 成功。
     - 客户端: `npm test` 28 个测试全部 PASS（新增路径选择、启动参数自适应、重试停止条件及打包目录真实文件存在性断言）。
     - RPC 回归: `node scripts/test-pulse-core.mjs` 假设备往返与 `daemon.stop` 干净退出全部 PASS。
- **限制与未确认项（客观边界）**：
  - **阶段 7 离线实现完成，真机恢复验收未执行**。
  - 尚未进行真实物理手环的三种断线恢复场景测试（拔系统蓝牙、手环走出范围、强制杀 core 进程）。
  - 按照验收标准，**尚未达到 M1**（必须在三种真机断线恢复测试全部自愈验证后方可确认达标）。
- **下一步（真机验收准备清单）**：
  - 等待用户执行真机断线恢复操作清单并验收。
