# Pulse on macOS 交接文档

> 用途：把 Pulse（`kyrieove/pulse-band`，AI Agent 状态实时推送到小米手环 10，任务完成/失败震动手环）完整跑在 macOS 上，并接入 ZCode / OpenCode / Claude Code / Codex 等 agent。
> 本文档给接手 agent 提供全部上下文：已完成改动、当前状态、待办操作、关键结论、遗留问题。

---

## 1. 最终目标与现状

- **目标**：Mac 上的 Codex / ZCode / opencode / Claude Code 任务实时显示在小米手环 10 上；任务完成（completed）或失败（error）时手环双长震动。
- **现状**：
  - Codex（tailer 读 `~/.codex/sessions`）、ZCode（hooks 转发）、Claude Code（hooks 转发）**已验证可震动**。
  - OpenCode（插件转发）事件链路、独立页面和完成震动均已实机验证；插件已修复 `session.idle` 完成错会话，并补充 `session.status: busy` 作为每轮开始事件。
  - ZCode 已从 Claude 卡片拆出为独立 `zcode` agent 和第 5 个手环页面。
  - 手环端震动依赖：Pulse 桌面端「连接手环」开启的 **DirectFetchBridge** 必须运行，且手环上 Pulse 应用在轮询（息屏会冻结，见 §7）。

---

## 2. 代码仓库与运行方式

- 源码目录：`/Users/wangtanzhi/Desktop/code_proj/pulse-band`（clone 自 github.com/kyrieove/pulse-band）
- 开发运行：`cd /Users/wangtanzhi/Desktop/code_proj/pulse-band && npx electron .`
  - 日志：`/tmp/pulse-dev.log`
  - 状态服务：`http://127.0.0.1:8765/api/status/compact?all=1`（手环数据源）
  - hook 服务：`http://127.0.0.1:41789/events`（各 agent 事件入口）
- 桌面启动器：`~/Desktop/启动Pulse.command`（打开 `/Applications/Pulse.app`）
- 当前源码已重新打出包含 OpenCode/ZCode 独立页面的 1.1.2 安装包，见 §5。

---

## 3. macOS 平台移植（已完成的代码改动）

### 3.1 OronBox 客户端 mac 适配 — `src/main/services/oronbox-client.ts`
- mac 版 OronBox 的 daemon 用 **Unix domain socket**（`$TMPDIR/oronbox/daemon.sock`），不是 Windows 的 `daemon.json` TCP 端点；RPC 报文协议与 Windows 完全一致（`{id, method, params, token}` + 换行）。
- 改动：
  - `ORONBOX_EXE`：darwin 下为 `/Applications/OronBox.app/Contents/MacOS/OronBox`
  - 新增 `DAEMON_SOCK_FILE = path.join(os.tmpdir(), 'oronbox', 'daemon.sock')`
  - `DaemonEndpoint` 加可选 `socketPath`；`readEndpoint()`/`openSocket()` 按平台分支（mac 免 token，pid 恒 1）
  - `doEnsureDaemon()` 的"等端点文件内容变化"在 mac 改为等 socket mtime 变化
- 实测：`daemon.info` 返回 `protocolVersion: 6`，与 `EXPECTED_PROTOCOL_VERSION` 一致，无降级。
- 注意：mac 版 OronBox 需先手动启动（`/Applications/OronBox.app`），或在 Pulse 连接时由客户端 spawn。

### 3.2 Claude Code hook 检测的 mac 适配
- `src/main/services/claude-hook-merge.ts`：`isOurs` 现在同时认 `pulse-hook.cmd`（Windows 包装器）和 `claude-hook.cjs`（mac 直连 node 命令）。
- `src/main/services/claude-hook-install.ts`：`getHookStatus()` 在 darwin 下不再要求 `.cmd` 包装器存在，只检查仓库 `scripts/claude-hook.cjs` 存在 + settings.json 有 4 个 HOOK_EVENTS 的条目。

### 3.3 opencode 独立 agent（本轮核心改造）
- `src/common/types.ts`：`AgentKind` 加 `'opencode'` 和 `'zcode'`。
- `src/main/services/claude-hook-server.ts`：按 `payload.agent` 将 Claude、OpenCode、ZCode 路由到独立 agent，并为缺失 session id 的来源使用独立 fallback id。
- `src/main/services/status-server.ts`：`?all=1` 响应 `sessions` 与 `limits` 包含 `opencode`、`zcode`（两者 limits 恒 null → 手环卡片显示 `--`）。
- `band-app/src/pages/index/index.ux`：
  - `AGENTS = ['claude','codex','antigravity','opencode','zcode']`
  - `prevStatus` 含 5 个槽位（长度必须与 AGENTS 一致）
  - 第 4 屏 OpenCode 与第 5 屏 ZCode 都使用和前三屏一致的双卡骨架、完整状态绑定和 5 个指示点
- `band-app/src/common/agent-opencode.png`：复制自 `agent-claude.png`（占位图标，可换）；ZCode 使用已有 `agent-zcode.png`。

---

## 4. 各 agent 接入配置

### 4.1 Codex（tailer，零配置）
Pulse 的 `CodexSessionTailer` 监听 `~/.codex/sessions/**/*.jsonl`（`CODEX_HOME` 可覆盖）。CLI 与 Codex Desktop 共用该存储，自动支持。解析 `task_complete`/`turn_complete` → completed，`turn_aborted`/`error` → error。

### 4.2 ZCode（hooks 转发）
- 转发脚本：`/Users/wangtanzhi/Desktop/code_proj/pulse-band/scripts/zcode-forward.cjs`（读 stdin JSON + 事件名参数 → POST `127.0.0.1:41789/events`；固定附加 `agent: 'zcode'`；Pulse 不在时静默退出，不阻塞 ZCode）。
- 配置文件：`~/.zcode/cli/config.json`（新创建），`hooks.enabled: true`，6 个事件：`SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop`，命令 `node "<pulse-band>/scripts/zcode-forward.cjs" <事件>`，`timeoutMs: 2000`。
- ⚠️ 配置文件 hooks 默认禁用，必须 `enabled: true`；hook 内联执行，转发脚本必须即发即弃（500ms 超时）。

### 4.3 OpenCode（插件转发）
- 仓库内唯一维护源：`scripts/opencode-forward.cjs`。
- 实际加载位置：`~/.config/opencode/plugins/pulse-forward.js`。安装或更新命令：`cp scripts/opencode-forward.cjs ~/.config/opencode/plugins/pulse-forward.js`。
- 导出格式（opencode 1.x 的坑）：`module.exports = { server: <函数> }`，server 是 `async ({directory}) => { return { event, 'tool.execute.before', 'tool.execute.after' } }`。**导出对象会报 `invalid server export`**。
- 事件映射：`session.created → SessionStart`，`tool.execute.before → PreToolUse`，`tool.execute.after → PostToolUse`，`session.idle → Stop`，`session.error → error`。
- 所有 payload 带 `agent: 'opencode'`。`session.idle` 必须取 `event.properties.sessionID`，不能依赖全局最近会话；`session.status: busy` 映射为 `UserPromptSubmit`，保证无工具调用的回合也有 running→completed 跳变。
- 插件改完需重启 opencode 才加载（`opencode run` 单次进程也会加载）。

### 4.4 Claude Code（hooks 转发）
- `~/.claude/settings.json` 已追加 6 个事件 hook，命令 `node "/Users/wangtanzhi/Desktop/code_proj/pulse-band/scripts/claude-hook.cjs" <事件>`。原文件备份在 `~/.claude/settings.json.bak`；用户原有 Clawd on Desk hooks 全部保留。
- 需**重开 Claude Code 会话**才生效。

---

## 5. 打包

### 5.1 桌面端 mac 打包
- `package.json` 的 `build` 加了 `mac: { target: ["dmg","zip"], icon: "build/icon.icns", identity: null }`，artifactName 改为 `Pulse-${version}-${arch}.${ext}`。
- 图标：`band-app/logo/pulse-logo-1024.png` → `build/icon.iconset/` → `iconutil` 生成 `build/icon.icns`（原 256px icon.png 不满足 ≥512px 要求）。
- 打包：`npm run dist`，产物 `release/Pulse-1.1.2-arm64.dmg` / `.zip`。2026-09-10 已重新构建，包含 OpenCode/ZCode 改造。

### 5.2 手环端 .rpk 构建
- 目录：`/Users/wangtanzhi/Desktop/code_proj/pulse-band/band-app`，依赖 `aiot-toolkit@^2.0.5`（已 npm install）。
- `npx aiot build` → 出 debug 包（包名会加 `.debug` 后缀，**不可用**）；`npx aiot release` → 正式包。
- release 需要证书：把 `node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/pem/` 下的 `private.pem`/`certificate.pem` 复制到 `band-app/sign/`（release 签名链 `sign/release/ → sign/`）。当前用的 debug 默认证书，OronBox 安装通道实测不校验签名。
- 当前产物：`band-app/dist/com.codeisland.band.release.1.0.2.rpk`（`versionCode: 27`；包名 `com.codeisland.band`，与 `fetch-bridge-direct.ts` 的 `BAND_PACKAGE` 一致）。
- 已复制到 `assets/band-app.rpk`（Pulse「安装内置版本」推的就是它）。原版备份：`/tmp/band-app.rpk.bak`。

---

## 6. 震动链路与关键排查结论

### 6.1 链路
1. 各 agent 事件 → Pulse `claude-hook-server`（41789）或 tailer → `sessionManager` 更新会话状态。
2. 手环端 `index.ux` 每 5s 轮询 `http://127.0.0.1:8765/api/status/compact?all=1`（经 OronBox interconnect 由 Pulse `DirectFetchBridge` 代发）。
3. `handleData` 对每个 agent 比对 `prevStatus`，**状态从非 completed/error 跳变到 completed/error 时** `buzz()`（vibrator 双长震，间隔 400ms）。
4. `rearmScreen()`：有 agent 在跑 → `brightness.setKeepScreenOn(true)` 保持亮屏（保证震动实时）；全 idle 后 30s 熄屏。

### 6.2 已定位并解决的根因
- **codex/zcode 不震动**：`DirectFetchBridge` 未启动（Pulse 界面没点「连接手环」）。Pulse 纯手动连接：必须「设备管理 → 连接手环」后桥接才应答手环请求。**Pulse 重启后需重新点一次**。
- **opencode 不震动**：opencode 事件原先映射 claude agent，与 ZCode 共用 claude 卡片，ZCode 会话持续 running 时会把 opencode 的 completed 顶掉 → 手环检测不到跳变。解决：独立 opencode agent（§3.3）。
- **ZCode Stop 事件会触发**（曾怀疑不触发，已用 `/tmp/zcode-forward.log` 追踪证实），问题只在手环端拿不到数据。

### 6.3 调试手段
- Pulse 日志：`/tmp/pulse-dev.log`（可临时在 `claude-hook-server.ts` 的 `handleClaudeEvent` 加 `console.log` 看事件到达）。
- ZCode 转发追踪：`/tmp/zcode-forward.log`（`zcode-forward.cjs` 内 `trace()`，查完可删）。
- OronBox 日志：`~/Library/Application Support/org.zxor.oronbox/logs/oronbox-*.log`——看 `interconnect message`：只有 `received + dispatching` 无 `sending` 说明桥接没应答（桥接没启动）；有 `sending ... (825 bytes)` 说明桥接在工作。
- 手环端数据：`curl http://127.0.0.1:8765/api/status/compact?all=1`
- OronBox RPC 直连测试：`node --input-type=module -e "import {OronBoxClient} from '<pulse-band>/src/main/services/oronbox-client.ts'; ..."`（可 `device.status`、`daemon.info`）。

---

## 7. 遗留问题与已知限制

1. **息屏后后台运行/震动**（用户需求，未实现）：Vela 快应用后台运行只支持 `system.audio`/`system.request`/`system.geolocation` 三种接口，普通 `setInterval` 息屏即冻结（作者真机实测，源码注释）。现行方案是"任务进行中屏幕常亮"。若要息屏后也震，唯一路径是 `system.audio` 后台 hack（播放静音循环换取后台资格），未验证，且息屏后 vibrator 可用性未知。
2. **手环电量低**：测试时约 8-9%，建议先充电。
3. **ZCode 屏幕录制权限**：ZCode 无「屏幕录制」授权（系统设置 → 隐私与安全性 → 屏幕录制，授权后需完全退出重启 ZCode），因此无法替用户操作 Pulse 界面，界面步骤需人工。
4. **opencode 图标**：`agent-opencode.png` 是复制占位，可替换为 opencode 官方 logo。
5. **Claude Code hook**：已配置，但需重开会话验证。
6. **后续同步上游**：当前改造维护在 `feature/macos-multi-agent-support` 分支，操作流程见 `docs/UPSTREAM_WORKFLOW.md`。

---

## 8. 后续验证清单

**重装或更新后操作**：
1. Pulse 窗口 →「设备管理 → 连接手环」（重启后桥接需重开，日志确认 `sending interconnect`）。
2.「安装 Pulse 内置版本」推新版 `.rpk`（带 OpenCode 第 4 屏）到手环。
3. 手环 Pulse 应用翻到第 4 屏（OpenCode），跑 OpenCode 任务验证完成震动。
4. 验证 Claude Code hook（重开会话）。
5. 可选：息屏后台震动（§7.1）需改 `band-app` 并重编 `.rpk`。

**接手 agent 可验证清单**：
- `curl http://127.0.0.1:8765/api/status/compact?all=1` 返回 `sessions.opencode`。
- 手环第 4 屏存在且显示 OpenCode。
- opencode 任务：事件链 `SessionStart→PreToolUse→PostToolUse→Stop` 到达 Pulse，手环完成时震动。
