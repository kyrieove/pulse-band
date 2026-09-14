# 阶段 5B 执行交接单（离线认证结构分析，不连接手环）

工作目录：`C:\dev\pulse-band2`。本文件是本轮唯一指令来源；与 `future_version/STATUS.md` 冲突时以本文件为准。

## 目标

在不连接手环、不发包、不实现猜测性认证算法的前提下，把阶段 5 已有两份 pcapng 中的认证帧结构整理清楚，并判断是否存在足够证据安全实现 `session.rs`。

本轮不是破解、试错或真机探测；没有闭环证据就必须停下。

## 已知状态（以此为准，不要照抄旧 STATUS）

- 阶段 1~4 已完成。
- 阶段 4 真机 RFCOMM 首通成功，但阶段 5 尚未进行真机认证。
- 阶段 5 已按用户授权生成本机配置：`%LOCALAPPDATA%\PulseDev\run\device.json`。
- `device.json` 只允许读取；authkey 是 16B，只能在内存中使用，绝不打印。
- 两份只读证据：
  - `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng`
  - `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng`
- 已知帧结构：`A5A5 | type(1) | seq(1) | len(2 LE) | CRC(2 LE) | payload`。
- CRC-16/ARC 只覆盖 payload；不要重新设计或调参。
- 当前仍未确认：authkey 如何参与计算、16B/32B/21B 材料的派生算法、具体密码学套件、22B 响应是否为认证成功专属响应。

## 硬性安全规则

1. **禁止连接手环、禁止发送任何数据、禁止运行 `cargo run -- --probe`。**
2. **禁止读取 OronBox、AstroBox-NG、Gadgetbridge 源代码。**可以读取本仓库文档、公开协议页面和公开逆向文章。
3. `device.json` 只检查字段名和长度，不打印 MAC、authkey、JSON 原文或任何秘密值。
4. 挑战、应答、会话密钥的真实字节不得进入终端、文档、日志、fixture、commit message 或 Git 历史。只能写 `<challenge:NB>`、`<response:NB>`、`<session-key:NB>`。
5. 不得删除、覆盖、重新生成已有 pcapng。不得修改或删除 `device.json`。
6. 不得因为长度相同、前缀相似或“像 protobuf”就宣布字段或算法已确认。
7. 不得尝试 AES、HMAC、SHA、ECDH、XOR 等算法去凑抓包结果。只有公开资料明确给出输入、输出和算法，且能独立对应两份抓包，才可升级结论。
8. 报告失败优于编造成功。无法闭环就明确写“仍是假设”。

## 第 0 步：前置检查

运行并贴原文：

```powershell
Get-Process Pulse,oronbox -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\PulseDev\run\device.json"
Test-Path "C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng"
Test-Path "C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng"
```

若 Pulse 或 OronBox 在运行，立即停止，不许 kill。若任一 pcapng 不存在，立即停止并写 STATUS.md。

只做脱敏配置检查：

```powershell
python -c "..."
```

脚本必须只输出 JSON 可解析性、字段名、connectType 是否为 spp、authkey 长度是否为 32、authkey 是否为 hex、addr 是否存在；不得输出任何值。

## 第 1 步：离线解析握手帧结构

对两份 pcapng 导出 RFCOMM 数据：

```powershell
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-01.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-02.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
```

用一次性本地脚本解析 `A5A5` 帧，但输出只能包含：

- pcapng 名称、包号、方向
- type、seq、len、CRC
- payload 总长度
- 固定公共前缀长度
- 嵌套字段的编号、wire type、材料长度
- 敏感材料占位符和长度

不得输出挑战、应答、会话密钥的原始 hex。

重点核对两份会话是否都出现相同的 4 步形状：

- Host → Band：29B
- Band → Host：63B
- Host → Band：68B
- Band → Host：22B

如果识别出 protobuf 风格字段，只能报告“字节形状与 protobuf wire type 一致”，不能报告“协议就是 protobuf”，除非有独立公开依据。

## 第 2 步：检查公开协议依据

只查公开网页、公开 wiki、公开 issue、第三方逆向文章；禁止读取相关项目源代码。

每个来源必须记录：

- URL
- 页面标题
- 明确写出的算法、输入和输出长度
- 是否涉及 Bluetooth Classic RFCOMM/SPP
- 是否能解释本项目 16B、32B、21B 字段
- 匹配或不匹配理由

长度相似不能算匹配。若没有闭环依据，必须报告：

```text
未找到足以闭环认证算法的公开依据；不能安全实现 session.rs，也不能连接真机试错。
```

## 第 3 步：判定是否允许实现和连接

只有同时满足以下条件，才可建议下一步实现 `session.rs`：

1. 算法名称已由公开资料或抓包证据明确支持；
2. 输入字段、输出字段和长度关系可写成确定公式；
3. 两份 pcapng 的对应步骤都能独立复现；
4. 能定义“只有认证成功对端才会返回”的可区分响应；
5. 不需要向真机发送猜测数据。

否则必须明确：

- 不允许实现 `session.rs` 的认证算法；
- 不允许连接手环或发包；
- 继续等待新协议依据或失败认证对照证据。

## 第 4 步：文档和 Git

只在必要时更新 `future_version/STATUS.md`，写清：

- 本轮离线分析做了什么；
- 确认了什么；
- 没确认什么；
- 是否允许实现 `session.rs`；
- 是否允许连接手环；
- 下一项具体取证动作。

不要修改 `docs/protocol/transport.md`，除非有完整复现三件套。若修改，每条事实必须带：完整命令、输出原文摘录、pcapng 路径 + sha256 + 包号或字节范围。

运行并贴原文：

```powershell
cd C:\dev\pulse-band2
git diff -- future_version/STATUS.md
git status --short
```

只提交必要的脱敏文档变更；不要提交临时分析脚本、device.json、authkey 或敏感字节；不要执行 `git reset --hard`；不要 git push。

## 汇报格式

报告必须包含：

1. 前置检查命令和原始输出；
2. 两份 pcapng 的路径、sha256、包数；
3. 握手帧结构分析的命令和原始输出；
4. 所有公开来源 URL 与匹配判断；
5. “我确认了什么”；
6. “我没能确认什么”（不许为空）；
7. 是否允许实现 `session.rs`；
8. 是否允许连接手环；
9. `git diff`、`git status` 和 commit hash（如有提交）。

最终判定必须诚实：若算法仍未知，就停在阶段 5 离线分析，不得宣布认证完成，不得进入阶段 6。
