# 表盘安装真机验证记录：发现与修复的 Bug（2026-09-11）

本文记录表盘整包安装（PREPARE_INSTALL_WATCH_FACE → Mass → REPORT_INSTALL_RESULT）
真机验证过程中发现并修复的三个协议实现缺陷、两个真机行为修正，以及已证实的设备行为。
全部结论有 core 日志或设备返回数据支撑；样本文件不入库，仅记录哈希与来源。

**结果**：3/3 社区表盘（97KB / 394KB / 884KB）真机安装成功，GET_INSTALLED_LIST(0)、
SET_WATCH_FACE(1)、PREPARE_INSTALL(4)+Mass(16)+RESULT(5) 三条命令链全部真机闭环。

---

## Bug 1：Mass 分片 seq(u8) 回绕后累积 ACK 比较永久卡死

- **现象**：884KB 表盘（217 片，slice=4096）传输中途窗口停滞，`等待 Mass 分片 ACK 超时`。
  首次失败时 core 日志显示下行 seq 从 255 回绕到 0。
- **根因**：自实现的累积确认用了 `inflight.front() <= ack_seq` 的线性比较。Frame seq 是 u8，
  传输超过 256 帧后回绕，`253 <= 1` 永假，窗口永不推进。
- **修复**：删除自实现，复用 RPK 路径的 `protocol.rs::ack_cumulative`——模 256 半区间判断
  `ack_seq.wrapping_sub(front) < 128`（与上游 `_handleAck` 语义一致）。
- **教训**：同 crate 内已有经过真机验证的工具函数时，必须复用而不是重写；
  重写版本在小文件（<256 片）测试里全绿，回绕路径完全没有被覆盖。

## Bug 2：硬等"全部 ACK 排空"造成传输完成后死锁

- **现象**：修复 Bug 1 后，217 片全部发出（core 日志：最后一片 seq=220 明文=974B），
  仍报 `等待 Mass 分片 ACK 超时`——传输其实已经完成。
- **根因**：我的实现要求 inflight 窗口排空后才进入结果等待。而设备在收满 Mass prepare
  声明的 data_length 后**直接进入安装处理，不再逐片确认尾部**（10s per-ACK 等待内一个
  尾部 ACK 都没来，两次真机复现）。上游 `_enforceFlowControl` 是软背压：backlog 低于
  软限就一直发，**发完即走**，成功判定完全交给 REPORT_INSTALL_RESULT。
- **修复**：`watchface_install.rs::transfer_mass_body` 发送循环结束后改为 best-effort
  收集已到达的 ACK（500ms 无新 ACK 即止），尾部未确认片数仅记日志，流程直接进入
  RESULT 等待（60s）。成功判定标准不变：只依据设备上报结果码（2=SUCCESS / 3=USED）。
- **教训**："传完字节数"与"收到全部 ACK"都不是成功判据；协议层对成功/失败只有
  RESULT 一个真相来源。上游的流控是背压手段，不是完成条件。

## Bug 3：全零内嵌 ID 被当作合法表盘 ID

- **现象**：BetaUI-黑塔.bin 的 0x28 处为 12 字节全零，安装时被原样用作表盘 ID
  （以 `000000000000` 装入手环）。
- **根因**：`is_valid_watchface_id` 只校验字符集与长度（`^[a-zA-Z0-9_-]{1,12}$`），
  漏了上游 `_validWatchfaceId` 中的全零拒绝（`!^[0]+$`）。0x28 全零语义是"文件未写 ID"。
- **修复**：`is_valid_watchface_id` 增加全零拒绝；此类文件走随机生成 ID 分支。
- **遗留**：`000000000000` 这个 ID 已真实存在于测试手环（功能正常），未提供设备侧删除能力
  （REMOVE_WATCH_FACE 未实现）前无法清理。

## 真机行为修正（实现时理解错误，非代码 bug）

1. **设备不会自发推送表盘列表**。SET_WATCH_FACE 后轮询 `is_current` 时，每轮必须重新发送
   GET_INSTALLED_LIST 查询；只收不发会双端互相干等直至超时。
2. **每断开一次链路，手环即退出「连接新手机」就绪态**。每次真机验证前都需要重新进入该界面；
   10060 超时首先应怀疑该前置，而不是代码。

## 已证实的设备行为（单机单样本，仅记录不过度推广）

- 设备协商 Mass slice=4096（与 RPK 安装的实测参数一致），394KB 传输约 3 秒。
- **安装完成后手环自动把新表盘切换为当前表盘**（两次复现）。
- 全新安装也会返回 `INSTALL_USED(3)`，与 `INSTALL_SUCCESS(2)` 并存；上游两者都视为成功。
  USED 的确切语义未查明，报告中不得与 SUCCESS 混同表述。
- 未签名（`PrepareInfo.verification` 不填）的社区表盘文件，手环**接受安装**——
  这解除了交接单中最大的未知项（样本来源与哈希见下）。

## 样本文件来源记录（版权内容，文件本体不入库）

| 文件 | 大小 | MD5 | SHA256 | 来源 |
|---|---|---|---|---|
| BetaUI-黑塔.bin | 394216B | e7b293eb4bd00eee92b65316effa384a | d1a39f5a0e6a4448854b667c18f90bb074fdbef68ccb6d20cf9fc17f5a823aa4 | bandbbs.cn 资源页附件，用户手动下载（2026-09-11） |
| wf_design.bin | 97281B | bd333753e915976ac4c64800357f34da | a32879d6d47fe45f04780e8bb29a0675064c17b6f9832a4a5abebeb31e152121 | 同上 |
| 丝柯克2.0-1.bin | 884382B | 46dcbd9602491c03c3fcbca44e645149 | f099ec383f47efb9b422b07c2b2ab1085de0c05a2e9fd6ef95ae5dcd9064fa14 | 同上 |

三份文件均为 `5A A5 34 12` 魔数的 Vela 裸表盘二进制；来源为社区作者上传的免费资源，
仅用于本机传输验证，不再分发。

## 仍未实现 / 未验证

- REMOVE_WATCH_FACE(2)、EDIT_WATCH_FACE(11)：未实现。
- `INSTALL_USED` 与 `INSTALL_SUCCESS` 的语义差异：未查明。
- 表盘安装的 Electron UI 入口：未实现（当前只有 RPC `device.watchface.install {path,md5,id?}`）。
- 多文件连续安装的稳定性：本轮 3 个文件分 3 次连接完成，未验证单链路连续安装 N 个。
