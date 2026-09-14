"""阶段 2 取证脚本：从 pcapng 导出的 RFCOMM 载荷推断 a5a5 帧结构与校验参数。

输入：tshark -Y "btrfcomm && data" -T fields -e frame.number -e hci_h4.direction -e data.data
输出：帧切分表 + CRC16 参数暴力搜索结果（逐帧比对，不允许只对上一帧就下结论）。
"""

import sys
from collections import Counter

CSV = sys.argv[1] if len(sys.argv) > 1 else "/tmp/rfcomm.csv"

rows = []
for line in open(CSV):
    parts = line.strip().split(",")
    if len(parts) < 3 or not parts[2]:
        continue
    rows.append((int(parts[0]), int(parts[1], 16), bytes.fromhex(parts[2])))

# 按方向重组字节流：0x00 = host->band（sent），0x01 = band->host（rcvd）
streams = {0: bytearray(), 1: bytearray()}
# 记录每个流内字节偏移对应的首个 frame.number，便于回溯包号
origin = {0: [], 1: []}
for num, direction, payload in rows:
    streams[direction].extend(payload)
    origin[direction].extend([num] * len(payload))


def split_frames(buf, org):
    """按 a5a5 + 8 字节头 + len(2B LE) 切帧。返回 (包号, 流内偏移, 帧字节, 是否完整)。"""
    out = []
    i = 0
    while i + 8 <= len(buf):
        if buf[i] != 0xA5 or buf[i + 1] != 0xA5:
            i += 1
            continue
        ln = int.from_bytes(buf[i + 4:i + 6], "little")
        end = i + 8 + ln
        complete = end <= len(buf)
        out.append((org[i], i, bytes(buf[i:end]) if complete else bytes(buf[i:]), complete))
        i = end if complete else len(buf)
    return out


def crc16(data, poly, init, refin, refout, xorout, width=16):
    if refin:
        crc = init
        poly_r = int(format(poly, "016b")[::-1], 2)
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ (poly_r if crc & 1 else 0)
    else:
        crc = init
        for b in data:
            crc ^= b << 8
            for _ in range(8):
                crc = ((crc << 1) ^ poly) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    crc ^= xorout
    if refin != refout:
        crc = int(format(crc, "016b")[::-1], 2)
    return crc & 0xFFFF


POLYS = [0x8005, 0x1021, 0xC867, 0x8BB7, 0xA097, 0x0589, 0x3D65, 0x8D95, 0x080B, 0x1DCF]

frames = {d: split_frames(streams[d], origin[d]) for d in (0, 1)}

print("=== 帧切分结果（按 len=offset4..5 LE，头 8 字节）===")
for d in (0, 1):
    label = "host->band" if d == 0 else "band->host"
    fl = frames[d]
    print(f"\n-- 方向 {label}: 流 {len(streams[d])} 字节，切出 {len(fl)} 帧，"
          f"截断 {sum(1 for f in fl if not f[3])} 帧")
    for num, off, fr, ok in fl[:12]:
        t, seq = fr[2], fr[3]
        ln = int.from_bytes(fr[4:6], "little")
        chk = fr[6:8].hex()
        print(f"   包#{num} off={off} type=0x{t:02x} seq=0x{seq:02x} len={ln} "
              f"chk={chk} payload={fr[8:8+ln].hex()[:48]}{'...' if ln > 24 else ''} {'' if ok else 'TRUNC'}")

# 长度自洽性：完整帧且切分后紧接下一个 a5a5，说明 len 规则成立
allf = [f for d in (0, 1) for f in frames[d] if f[3]]
print(f"\n=== 长度规则自洽 ===\n完整帧 {len(allf)} 个；"
      f"其中 8+len 恰好落在下一帧 a5a5 边界或流尾的比例见下")
for d in (0, 1):
    fl = [f for f in frames[d] if f[3]]
    good = sum(1 for f in fl if streams[d][f[1] + len(f[2]):f[1] + len(f[2]) + 2] in (b"\xa5\xa5", b""))
    print(f"   方向 {'host->band' if d == 0 else 'band->host'}: {good}/{len(fl)} 帧边界对齐")

print("\n=== type 分布 ===")
print(Counter((f[2][2]) for f in allf))

# CRC 暴力搜索：覆盖范围候选 × 参数候选，要求对全部非空载荷帧逐帧命中
nonempty = [f for f in allf if int.from_bytes(f[2][4:6], "little") > 0]
lens = {}
for f in nonempty:
    lens.setdefault(int.from_bytes(f[2][4:6], "little"), f)
print(f"\n非空载荷帧 {len(nonempty)} 个，出现 {len(lens)} 种不同长度")

COVERAGE = {
    "payload only (8..8+len)": lambda fr, ln: fr[8:8 + ln],
    "type..end (2..8+len, chk 置零)": lambda fr, ln: fr[2:6] + b"\x00\x00" + fr[8:8 + ln],
    "type,seq,len (2..6)+payload": lambda fr, ln: fr[2:6] + fr[8:8 + ln],
    "whole frame w/ chk zeroed": lambda fr, ln: fr[0:6] + b"\x00\x00" + fr[8:8 + ln],
}

hits = []
for cov_name, cov in COVERAGE.items():
    for poly in POLYS:
        for init in (0x0000, 0xFFFF):
            for refin in (False, True):
                for refout in (False, True):
                    for xorout in (0x0000, 0xFFFF):
                        for order in ("le", "be"):
                            ok = 0
                            for f in nonempty:
                                fr = f[2]
                                ln = int.from_bytes(fr[4:6], "little")
                                want = int.from_bytes(fr[6:8], "little" if order == "le" else "big")
                                if crc16(cov(fr, ln), poly, init, refin, refout, xorout) == want:
                                    ok += 1
                                else:
                                    break
                            if ok == len(nonempty) and nonempty:
                                hits.append((cov_name, poly, init, refin, refout, xorout, order, ok))

print("\n=== CRC16 全命中参数组 ===")
if not hits:
    print("无：没有任何 CRC16 参数组能对全部帧命中 —— 校验机制仍是假设")
for h in hits:
    print(f"   覆盖={h[0]} poly=0x{h[1]:04x} init=0x{h[2]:04x} refin={h[3]} "
          f"refout={h[4]} xorout=0x{h[5]:04x} 字段字节序={h[6]} 命中 {h[7]}/{len(nonempty)}")

# 部分命中率最高的组合，便于判断是否接近
if not hits:
    best = []
    for cov_name, cov in COVERAGE.items():
        for poly in POLYS:
            for init in (0x0000, 0xFFFF):
                for refin in (False, True):
                    for refout in (False, True):
                        for xorout in (0x0000, 0xFFFF):
                            for order in ("le", "be"):
                                ok = 0
                                for f in nonempty:
                                    fr = f[2]
                                    ln = int.from_bytes(fr[4:6], "little")
                                    want = int.from_bytes(fr[6:8], "little" if order == "le" else "big")
                                    if crc16(cov(fr, ln), poly, init, refin, refout, xorout) == want:
                                        ok += 1
                                best.append((ok, cov_name, poly, init, refin, refout, xorout, order))
    best.sort(reverse=True)
    print("\n=== 命中率最高的 5 组（仅供判断方向，不构成结论）===")
    for b in best[:5]:
        print(f"   {b[0]}/{len(nonempty)} 覆盖={b[1]} poly=0x{b[2]:04x} init=0x{b[3]:04x} "
              f"refin={b[4]} refout={b[5]} xorout=0x{b[6]:04x} 序={b[7]}")

print("\n=== 首包方向 ===")
first = min(rows, key=lambda r: r[0])
print(f"   RFCOMM 首个数据包 #{first[0]} 方向={'host->band' if first[1] == 0 else 'band->host'} "
      f"前 16 字节={first[2][:16].hex()}")
firsta5 = min((f for d in (0, 1) for f in frames[d]), key=lambda f: f[0])
print(f"   首个 a5a5 帧 出自包#{firsta5[0]}")
