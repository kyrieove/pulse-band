"""生成 CRC 参数的逐帧比对表（帧号 / 覆盖字节 / 算得值 / 抓到值），并导出一个测试向量。

用法：python tools/crc_table.py /tmp/rfcomm.csv
参数按 tools/analyze_frames.py 的全命中结果固定：CRC-16/ARC（poly 0x8005, init 0,
refin=refout=true, xorout 0），覆盖范围仅载荷，字段小端。此处**不再调参**，只做验伪。
"""

import sys

CSV = sys.argv[1] if len(sys.argv) > 1 else "/tmp/rfcomm.csv"

rows = []
for line in open(CSV):
    p = line.strip().split(",")
    if len(p) >= 3 and p[2]:
        rows.append((int(p[0]), int(p[1], 16), bytes.fromhex(p[2])))

streams, origin = {0: bytearray(), 1: bytearray()}, {0: [], 1: []}
for num, d, pl in rows:
    streams[d].extend(pl)
    origin[d].extend([num] * len(pl))


def crc16_arc(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc & 0xFFFF


def frames(d):
    buf, org, out, i = streams[d], origin[d], [], 0
    while i + 8 <= len(buf):
        if buf[i] != 0xA5 or buf[i + 1] != 0xA5:
            i += 1
            continue
        ln = int.from_bytes(buf[i + 4:i + 6], "little")
        if i + 8 + ln > len(buf):
            break
        out.append((org[i], i, bytes(buf[i:i + 8 + ln])))
        i += 8 + ln
    return out


allf = [(("host->band" if d == 0 else "band->host"), n, off, fr)
        for d in (0, 1) for (n, off, fr) in frames(d)]

# 每种长度取第一帧，按长度升序取若干，长度互不相同
by_len, table = {}, []
for dirn, n, off, fr in allf:
    ln = int.from_bytes(fr[4:6], "little")
    if ln > 0 and ln not in by_len:
        by_len[ln] = (dirn, n, off, fr)
for ln in sorted(by_len)[:8]:
    dirn, n, off, fr = by_len[ln]
    payload = fr[8:8 + ln]
    got = int.from_bytes(fr[6:8], "little")
    calc = crc16_arc(payload)
    table.append((n, dirn, ln, off + 8, off + 8 + ln - 1, calc, got, calc == got))

print("| 包号 | 方向 | 载荷长度 | 覆盖字节（方向流内偏移，含两端） | 算得值 | 抓到值 | 是否一致 |")
print("|---|---|---|---|---|---|---|")
for n, dirn, ln, a, b, calc, got, ok in table:
    print(f"| #{n} | {dirn} | {ln} | {a}..{b} | 0x{calc:04x} | 0x{got:04x} | {'一致' if ok else '不一致'} |")

tot = [f for f in allf if int.from_bytes(f[3][4:6], "little") > 0]
ok = sum(1 for _, _, _, fr in tot
         if crc16_arc(fr[8:8 + int.from_bytes(fr[4:6], "little")])
         == int.from_bytes(fr[6:8], "little"))
print(f"\n全量：{ok}/{len(tot)} 个非空载荷帧的 CRC-16/ARC 与抓到值一致；"
      f"覆盖 {len({int.from_bytes(f[3][4:6],'little') for f in tot})} 种不同长度")

zero = [f for f in allf if int.from_bytes(f[3][4:6], "little") == 0]
print(f"空载荷帧 {len(zero)} 个，校验字段全部为 "
      f"{sorted({f[3][6:8].hex() for f in zero})}")

# 测试向量：选 type=0x02 的协商帧（TLV 形态，不含疑似密钥/挑战材料）
vec = next(fr for _, _, _, fr in allf if fr[2] == 0x02)
out = "core/tests/fixtures/frame-type02-2026-09-08.bin"
open(out, "wb").write(vec)
print(f"\n测试向量已写入 {out}：{len(vec)} 字节 hex={vec.hex()}")
