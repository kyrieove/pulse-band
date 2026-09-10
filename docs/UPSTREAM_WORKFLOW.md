# 上游同步工作流

本仓库当前把作者仓库保留为 `origin`：

```text
origin  https://github.com/kyrieove/pulse-band.git
```

本地 macOS 与多 Agent 改造维护在 `feature/macos-multi-agent-support`，不要直接在 `main` 上继续开发。

## 获取作者后续更新

先确认工作区没有未提交改动，再把功能分支变基到作者最新 `main`：

```bash
git switch feature/macos-multi-agent-support
git status --short
git fetch origin
git rebase origin/main
npm test
npm run build
```

发生冲突时逐个解决并测试，然后执行 `git rebase --continue`。若只是想退出本次变基，可执行 `git rebase --abort`，不会丢失变基前的分支状态。

## 有自己的 GitHub fork 后

将作者仓库改名为 `upstream`，把自己的 fork 设为 `origin`：

```bash
git remote rename origin upstream
git remote add origin <你的-fork-url>
git push -u origin feature/macos-multi-agent-support
```

之后同步作者更新使用：

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin feature/macos-multi-agent-support
```

`--force-with-lease` 仅用于变基后的个人功能分支；不要对共享的 `main` 使用强制推送。

## 发布物与私有文件

- `assets/band-app.rpk` 是桌面端内置安装包，功能变化后应随源码一起提交。
- `build/icon.icns` 是 macOS 打包输入，应提交；`build/icon.iconset/` 是可再生中间目录，不提交。
- `band-app/sign/` 含签名私钥与证书，已被 `.gitignore` 排除，任何情况下都不要提交。
- `release/`、`band-app/dist/` 等构建产物不提交；用对应源码提交重新生成。
