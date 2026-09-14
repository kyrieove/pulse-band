# 阶段 6B-PRE 执行交接单（真机 fetch 抓包取证，验证业务推断模型）

工作目录 `C:\dev\pulse-band2`，分支 `main`，HEAD 预期 `612903e`。本文件是本轮唯一指令来源。

## 目标

阶段 6A 只能确认业务帧解密、快应用列表（type=20, id=0）与包名路由；fetch/额度结构（type=20, id=8 `SEND_PHONE_MESSAGE`）目前**仍是基于公开源码+客户端契约的推断，未抓包实证**（现有两份抓包无 id=8/9/7 帧）。本阶段 6B-PRE 通过一次**真机 fetch 抓包**，捕获并解密一条真实的 `type=20, id=8` 往返，验证或修正 `docs/protocol/business.md` 的推断模型，为阶段 6B（数据泵）提供可信依据。

> 这是真机物理操作（连手环 + 用户点开快应用）。执行前必须由用户授权并配合。未获确认前只允许完成文档/准备，不连手环、不发包、不点开应用。

## 开工前必读

1. `future_version/PHASE6A-BRIEF.md`、`docs/protocol/business.md`（§3.2 推断模型、§5 判定）。
2. `tools/verify_auth.py`、`tools/decrypt_business.py`（复用解密逻辑）。
3. `docs/protocol/transport.md`、`auth.md`。`core/src/session.rs`（`--auth` 认证驱动）。
4. 记忆：btvs+Wireshark 抓包手法（`btvs.exe -Mode Wireshark`，只收单客户端，复用 GUI 落盘）。

## 第 −1 条：敏感纪律（同前，尤其严格）

1. authkey / W / P / dec_key / enc_key / 业务帧解密明文 / 真实用户数据（额度、token、JSON 内容）——绝不打印、绝不写 docs/fixture/commit，只用占位符（`<authkey:16B>`、`<content:NB>`、`<quota-json:NB>` 等）。
2. authkey 只从 `%LOCALAPPDATA%\PulseDev\run\device.json` 读入内存，不打印。
3. 新抓包用**新文件名**（如 `fetchevidence-2026-09-09.pcapng`），**绝不覆盖** `baseline-*`；不删、不改旧 pcapng。
4. 不 `git reset --hard`；不 `git push`。

## 第 0 步：前置闸门（运行并贴原文）

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
```

- 任一流程在运行 → 停止，请用户确认（避免抢连接）。
- device.json 存在且 authkey 16B（只查长度）。

## 第 1 步：准备抓包环境

- 用 `btvs.exe -Mode Wireshark`（提权）拉起 Wireshark，开始抓包，落盘为新文件 `fetchevidence-2026-09-09.pcapng`。
- 先建立一次干净的 RFCOMM 链路（可用 `cargo run -- --auth` 完成认证并保持连接，或按实际可用方式；若需保持连接做后续观察，认证后不要立刻关闭 socket，改为进入事件监听/等待收包）。
  - ⚠️ 若 `--auth` 目前是"认证完即关闭 socket"，则需在本次取证中**追加一个"认证后保持连接 N 秒并持续 recv/dump"的最小路径**，或改用 OronBox 保持连接；两种任选其一，需在报告里说明用哪种、为何。

## 第 2 步：用户配合——在物理手环上点开 Pulse 快应用

- **需要用户在物理手环实际操作**：解锁手环，打开 Pulse App（显示名 "Pulse"），让它进入首页/触发一次数据刷新（从而发起一条真实 fetch）。
- 记录点开时间与操作步骤，便于与抓包包号对位。
- 保持抓包约 30~60 秒，覆盖 fetch 发起与可能的下行响应。

## 第 3 步：解密新抓包，定位 id=8 帧

用 `tools/verify_auth.py` / `tools/decrypt_business.py`（或复用其函数）对 `fetchevidence-2026-09-09.pcapng`：
- 确认 SHA256、完整帧、CRC、认证四步全过；
- 解密所有业务帧，重点搜索/列出所有 `type=20` 的帧及其 `id`（0 / 7 / 8 / 9）；
- 对每条 `type=20, id=8`（SEND_PHONE_MESSAGE）帧：
  - 打印方向、包号、流内偏移、长度、CRC；
  - 解析 `field 22 → field 9 (MessageContent)`，打印 `field 1 (basic_info)` 长度与 `field 2 (content, bytes)` 的长度；content 判为 JSON 则只打印其**结构/键名/长度**（脱敏），不打印完整明文；确有必要时打印脱敏后的键名与红actioned值。
  - 判断上行/下行：手环→主机为 fetch 请求，主机→手环为 fetch 响应（若有）。
- 若出现 `type=20, id=7`（SYNC_PHONE_APP_STATUS）建链协商帧，一并记录。

## 第 4 步：对比推断模型并更新文档

- 将实测的 `type=20, id=8` 字段结构、content 编码、额度封包形状，与 `business.md` §3.2 / §3.3 的推断模型逐一对比。
- 完全吻合 → 将 `business.md` §3.2 从「仍是假设」升级为「来源：自己抓包 · 2026-09-09」，附命令原文 + 输出摘录 + 包号。
- 有出入 → 修正 `business.md` 的字段号或封包形状，并明确差额。
- 未捕获到 id=8 → 如实报告「未捕获 fetch 帧」，列出已捕获的 type=20 帧的 id，并说明可能原因（未点开/应用未发 fetch/连接如OronBox无法转发等）。

## 第 5 步：汇报

必须含：
1. 第 0 步前置命令与输出；
2. 抓包文件路径、SHA256、总帧数；
3. 用户点开快应用的操作与时刻（若由用户提供）；
4. 解密后所有 `type=20` 帧的 id 与关键结构（脱敏）；
5. **「我确认了什么」**（哪些推断被证实/修正）；
6. **「我没能确认什么」**（不许为空）；
7. **明确结论**：阶段 6 能否据此进入 6B 数据泵实现？若 fetch 帧捕获充分 → 可；否则列出还缺什么。
8. `git status --short`、`git diff --stat` 原文；`git log --oneline -3`。

## 完成标准与边界

- **达标** = 成功捕获并解密至少一条真实的 `type=20, id=8` 往返（上行 fetch 请求 + 若有下行响应），并用其更新 `business.md`（§3.2/§3.3 改为抓包实证）。
- **未达标** = 未捕获 id=8 帧 → 按第 4 步如实报告，不升级 `business.md`，不开始 6B。
- **授权条目**：需用户明确授权本次真机连手环 + 抓包；并需用户**亲自在手环点开 Pulse 快应用**。未授权不得连手环/不点应用/不发包。未授权：`git reset`/`git push`、改删 `device.json`、覆盖旧 pcapng。
