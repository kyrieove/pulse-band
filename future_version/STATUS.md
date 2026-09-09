# STATUS — 2026-09-09（M1 真机验收通过，Pulse 2.0 设计完成）

## 当前结论

M1 已按用户在 2026-09-09 确认的产品范围通过。日常链路为：

```text
Pulse Dev → pulse-core --live → Windows RFCOMM/SPP → Xiaomi Smart Band 10
```

## 已确认事实

- 阶段 1–5 完成：协议帧层、RFCOMM 和认证完成；认证真机三次测试 3/3 PASS。
- 阶段 6A/6B 完成：自研 `pulse-core --live` 与业务数据泵真机闭环通过。
- `pulse-core.exe` 已通过 electron-builder `extraResources` 打进 Pulse Dev 安装包。
- 打包后的 Pulse Dev 成功启动真实 `pulse-core.exe --live`。
- 现场日志确认第一次尝试完成 RFCOMM 连接与 Session 认证，收到状态查询并应答 `CONNECTED`，完成
  `__hs__` 握手，并连续收到额度请求 `r1`–`r11`。
- 用户现场确认手环额度显示正常，没有 Windows 配对弹窗，也没有手环“配对失败”。
- 用户手动断开后再次点击连接，认证、数据泵和额度显示恢复正常。
- 最近一次完整离线回归：`npm test`、`cargo test --all`、`cargo build --release` 全部通过。

## 用户确认的 M1 范围

关闭再开启 Windows 蓝牙后等待 60 秒，链路没有自动恢复。用户明确决定以下能力不属于当前版本需求：

- Windows 蓝牙关闭再开启后的自动恢复；
- 手环离开范围再返回后的自动恢复。

当前版本接受断链后由用户在 Pulse Dev 中手动重新连接。因此这里记录的是**用户调整范围后的 M1 通过**，
不是阶段 7 原始交接单中“三种断线全部自愈”的通过。自动恢复代码保留，但不声明已经通过真机验证。

## 已知限制

- 系统蓝牙关闭、超出范围或其他链路中断后，可能需要用户手动重新连接。
- 当前代码仍有历史内部命名和用户文案；Pulse 2.0 将统一清理。
- 全新电脑上的 Windows 配对和 RPK 安装尚未由自研 core 完成真机闭环。

## 下一步

Pulse 2.0 产品和首次设置重构设计已经确认：

- 规格：`docs/superpowers/specs/2026-09-09-pulse-2.0-redesign-design.md`
- 子项目 1：Pulse 2.0 UI 基础与日常页面；
- 子项目 2：日志导入、DPAPI、Windows 配对与认证；
- 子项目 3：内置及第三方 RPK 安装闭环与历史内部命名清理。

三个子项目全部完成前不发布。最终在一台干净 Windows 11 x64 电脑上，从无 Pulse 配置、无现成 Windows
bond 的状态完成首次设置真机验收。
