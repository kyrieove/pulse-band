# 认证握手结构记录（阶段 5 · 离线分析）

状态：**认证算法仍未确认，禁止据此连接真机或发送猜测认证包。**

证据来源（两份独立成功会话）：

- `C:\dev\pulse-band2\baseline-2026-09-08-01.pcapng`
  - SHA256：`2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099`
  - 总包数：704
- `C:\dev\pulse-band2\baseline-2026-09-08-02.pcapng`
  - SHA256：`3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377`
  - 总包数：400

来源：自己抓包 · 2026-09-08。敏感材料（authkey、challenge、response、session key）不写入本文档。

## 1. 复现命令

导出 RFCOMM data 层：

```powershell
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-01.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
& "C:\Program Files\Wireshark\tshark.exe" -r baseline-2026-09-08-02.pcapng -Y "btrfcomm && data" -T fields -e frame.number -e frame.time_relative -e hci_h4.direction -e data.data
```

认证帧筛选规则（离线分析）：A5A5 帧中 `type=0x03` 且 payload 前两个字节为 `01 01`。
该筛选输出的脱敏统计：

```text
会话 1 握手帧数量: 4, 会话 2 握手帧数量: 4
步骤 1: Host->Band, payload 29B
步骤 2: Band->Host, payload 63B
步骤 3: Host->Band, payload 68B
步骤 4: Band->Host, payload 22B
```

定位：会话 1 包 #116、#120、#122、#125；会话 2 包 #112、#115、#117、#120。帧级 type/seq/len 和方向来自上述 tshark 导出，完整帧的 CRC 由阶段 2 已确认的 CRC-16/ARC 规则校验。

## 2. 可确认的字节形状

两份会话的四步握手都呈现相同的外层形状：

```text
payload = 01 01 | field-encoded body
```

对 `01 01` 之后的 body 做 wire-type 风格解析，得到以下结构。这里的“protobuf wire type 风格”只描述字节形状，**不等于确认协议就是 protobuf**。

| 步骤 | 方向 | 外层字段形状 | 内层材料长度 |
|---|---|---|---:|
| 1 | Host -> Band | field 1 varint=1；field 2 varint=26；field 3 bytes；其内 field 30 bytes；再内 field 1 bytes | `<challenge:16B>` |
| 2 | Band -> Host | field 1 varint=1；field 2 varint=26；field 3 bytes；其内 field 31 bytes；再内 field 1 bytes + field 2 bytes | `<challenge:16B>` + `<response:32B>` |
| 3 | Host -> Band | field 1 varint=1；field 2 varint=27；field 3 bytes；其内 field 32 bytes；再内 field 1 bytes + field 2 bytes | `<response:32B>` + `<session-auth:21B>` |
| 4 | Band -> Host | field 1 varint=1；field 2 varint=27；field 3 bytes；其内 field 33 bytes；再内 field 1 varint + field 2 varint + field 3 varint | 无高熵材料 |

复现输出原文摘录（只列字段编号和长度，不列敏感内容）：

```text
=== 步1 包#116 H->B field3 内容的结构 ===
field=1 varint = 1
field=2 varint = 26
field=3 bytes(21)
  field=30 bytes(18)
    field=1 bytes(16)  <-- 材料，不打印内容

=== 步2 包#120 B->H field3 内容的结构 ===
field=1 varint = 1
field=2 varint = 26
field=3 bytes(55)
  field=31 bytes(52)
    field=1 bytes(16)  <-- 材料，不打印内容
    field=2 bytes(32)  <-- 材料，不打印内容

=== 步3 包#122 H->B field3 内容的结构 ===
field=1 varint = 1
field=2 varint = 27
field=3 bytes(60)
  field=32 bytes(57)
    field=1 bytes(32)  <-- 材料，不打印内容
    field=2 bytes(21)  <-- 材料，不打印内容

=== 步4 包#125 B->H field3 内容的结构 ===
field=1 varint = 1
field=2 varint = 27
field=3 bytes(14)
  field=33 bytes(11)
    field=1 varint = 1
    field=2 varint = <整数，原始值不写入>
    field=3 varint = <整数，原始值不写入>
```

## 3. 两会话交叉结果

两份抓包的命令输出显示四步握手的方向、帧长度和材料长度一致；高熵材料本身随会话变化。第四步在两个成功会话中都是 22B，但两个会话都是成功会话，因此只能得到：

```text
两份成功会话中均出现长度为 22B 的候选认证后响应；
随后出现 type=0x03、payload 前缀为 0x0102 的业务流。
```

这不足以证明该响应“只有认证成功才会返回”，也不足以证明握手算法已知。

## 4. 当前仍是假设

以下项目没有足够的独立依据，全部保持“仍是假设”：

- `01 01` 后的协议是否真的使用 protobuf；
- 16B 材料是否是 nonce/challenge；
- 32B 材料是否是 HMAC、签名、密文或其他数据；
- 21B 材料的含义和派生方式；
- authkey 是否直接参与这些材料的计算，以及具体输入顺序；
- 使用的密码学套件；
- 22B 响应是否是认证成功专属响应。

## 5. 阶段 5 闸门

当前不允许：

- 实现猜测性的 `core/src/session.rs` 认证算法；
- 向手环发送猜测 payload；
- 用“send 成功”“recv 非空”“CRC 正确”“没有 NAK”宣布认证成功；
- 进入阶段 6。

允许的下一步只有：获得可信公开协议依据、获得失败认证对照抓包，或在不连接手环的前提下继续整理字段结构。任何新增协议事实都必须附完整命令、输出原文、pcapng 路径 + SHA256 + 包号/偏移。
