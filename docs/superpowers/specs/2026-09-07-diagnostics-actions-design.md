# Pulse 一键诊断与自动发布设计

## 目标

1. 将现有“运行诊断”页从状态展示升级为可手动触发的一次性完整检查，并为每个异常提供用户可执行的下一步。
2. 在 GitHub Actions 中持续验证 Windows 构建，并在推送版本 Tag 后自动创建 GitHub Release。

## 范围

- 保留现有诊断页面、OronBox 桥接和状态轮询，仅增加结构化诊断结果与顶部操作区。
- 一键诊断本身只读，不自动修改蓝牙、设备或第三方配置。
- 继续使用仓库现有的两个自检脚本，不引入新的测试框架。
- 自动发布只处理 Windows NSIS 安装包和 SHA-256 文件，不处理代码签名。

## 一键诊断

### 返回契约

主进程返回按执行顺序排列的检查项：

```ts
type DiagnosticStatus = 'pass' | 'warn' | 'fail';

interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  nextStep?: string;
}

interface DiagnosticReport {
  checkedAt: number;
  checks: DiagnosticCheck[];
}
```

`summary` 面向普通用户，不直接暴露 `ENOENT`、`ECONNREFUSED` 等底层错误。需要排查价值的原始错误继续保留在现有错误日志中。

### 检查项目

| 项目 | 通过条件 | 失败或警告建议 |
|---|---|---|
| Pulse 状态服务 | `/api/status` 可读取 | 重启 Pulse；若仍失败，检查 8765 端口 |
| Claude Hook | 所有事件已配置且命令存在 | 点击现有“安装 Hook”按钮 |
| Claude Hook 服务 | `/health` 可读取 | 重启 Pulse；检查 41789 端口占用 |
| OronBox daemon | RPC 已连接 | 确认安装 OronBox 并重启它与 Pulse |
| OronBox 协议 | 已连接且未降级 | 更新 OronBox；降级状态作为警告 |
| 桥接模式 | 插件模式或直连模式已正常响应 | 根据当前模式检查 FetchBridge 或关闭冲突客户端 |
| 手环连接 | OronBox 报告设备已连接 | 断开小米运动健康后重试连接 |
| 内置手环应用 | 打包资源中的 `band-app.rpk` 存在 | 重新安装完整 Pulse 安装包 |
| AI 额度 | 至少一个来源可用 | 登录相应 Agent；估算值作为警告而非失败 |

无法由软件可靠检测的限制（手机蓝牙互斥、OronBox 可能导致时间异常）不伪装成检测结果，继续作为 README 中的静态警告。

### 代码位置和数据流

1. `src/main/services/diagnostics.ts` 提供不依赖 Electron 的纯函数，负责根据采集结果生成 `DiagnosticReport`，并把底层错误映射为用户提示。
2. `OronBoxBridge` 注册 `pulse:run-diagnostics` IPC，读取自身已消毒的状态快照，并采集 Hook 状态、资源路径和两个本地 HTTP 服务的健康状态后交给纯函数。
3. `src/preload/index.ts` 与 `src/renderer/env.d.ts` 暴露类型化 API。
4. `DiagnosticsScreen.tsx` 顶部增加“开始完整诊断”按钮、检查时间、汇总计数和逐项结果。现有额度、daemon、错误日志与 Hook 区域保持不变。

诊断正在执行时按钮禁用。单项检查异常不会中断其余检查；最终报告总能返回已经完成的结果。

### 测试

- 先为纯错误映射和报告汇总编写失败测试，再添加最小实现。
- 使用 Node 内置测试运行器，新增 `scripts/test-diagnostics.mjs`，避免引入测试框架依赖。
- 验证典型超时、端口拒绝、文件缺失和未知错误都得到稳定、可读的提示。
- 最终运行三个自检脚本和 `npm run build`。

## GitHub Actions

### CI

`.github/workflows/ci.yml` 在 `main` push 和 pull request 时运行 Windows Job：

1. checkout；
2. 安装 Node 24 并启用 npm 缓存；
3. `npm ci`；
4. 运行三个自检脚本；
5. `npm run build`；
6. `npm audit --omit=dev`。

### Release

`.github/workflows/release.yml` 只在 `v*` Tag push 时运行，声明最小的 `contents: write` 权限：

1. 安装依赖并运行全部自检；
2. 校验 Tag `vX.Y.Z` 与 `package.json` 中的版本完全一致；
3. 在 `windows-latest` 执行 `npm run dist`；
4. 对 `Pulse-Setup-X.Y.Z.exe` 生成同名 `.sha256`；
5. 使用 Runner 自带的 GitHub CLI 和 `GITHUB_TOKEN` 创建非草稿、非预发布 Release，并上传两个文件。

不使用第三方 Release Action，减少供应链依赖。已有同名 Release 时任务失败，不静默覆盖资产。

## 验收标准

- 用户点击一次按钮后能看到所有检查结果、汇总和针对性建议。
- 任意单项失败不会导致整份报告消失。
- 现有诊断信息和设备功能不回归。
- 本地三个自检脚本、TypeScript/Vite 构建和 YAML 解析全部通过。
- CI workflow 覆盖 `main` 与 PR；Release workflow 仅匹配版本 Tag，权限仅为 `contents: write`。
- Tag 与包版本不一致时不会发布；一致时生成安装包和 SHA-256 并创建 Release。
