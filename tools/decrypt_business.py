"""Decrypt and dump business protocol stream from pcapng captures.

Offline forensic tool for Phase 6A.
Reuses cryptographic logic from verify_auth.py without modifying it.
Strictly desensitized: no raw credentials, tokens, or plaintext dumped to stdout.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# 导入 verify_auth 的基础数据提取逻辑
ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from tools.verify_auth import frames, fields, one, mac, crc16, BASELINES


def get_authkey():
    credential_path = Path(os.environ["LOCALAPPDATA"]) / "PulseDev/run/device.json"
    raw = json.loads(credential_path.read_text(encoding="utf-8"))
    return bytes.fromhex(raw["authkey"])


def derive_keys(captured, authkey):
    handshake = [f for f in captured if f[3] == 3 and f[4].startswith(b"\x01\x01")]
    if len(handshake) != 4:
        raise ValueError(f"Handshake frames count mismatch: {len(handshake)} != 4")
    bodies = []
    for index, (number, direction, offset, _, payload) in enumerate(handshake):
        command = fields(payload[2:])
        account = fields(one(command, 3, 2))
        bodies.append(fields(one(account, 30 + index, 2)))
    phone = one(bodies[0], 1, 2)
    watch = one(bodies[1], 1, 2)
    prk = mac(phone + watch, authkey)
    t1 = mac(prk, b"miwear-auth\x01")
    block = t1 + mac(prk, t1 + b"miwear-auth\x02")
    dec_key = block[:16]
    enc_key = block[16:32]
    return dec_key, enc_key


def dump_proto_fields(field_map, indent="      "):
    lines = []
    for f_num, f_list in sorted(field_map.items()):
        for wire, val in f_list:
            if wire == 0:
                lines.append(f"{indent}field {f_num} [varint]: {val}")
            elif wire == 1:
                lines.append(f"{indent}field {f_num} [fixed64]: <fixed64>")
            elif wire == 5:
                lines.append(f"{indent}field {f_num} [fixed32]: <fixed32>")
            elif wire == 2:
                # 检查是否可被递归解析为 protobuf
                is_nested = False
                try:
                    sub = fields(val)
                    if sub and all(isinstance(k, int) and 0 < k < 1000 for k in sub.keys()):
                        lines.append(f"{indent}field {f_num} [nested_proto, {len(val)}B]:")
                        lines.extend(dump_proto_fields(sub, indent + "  "))
                        is_nested = True
                except Exception:
                    pass
                if not is_nested:
                    # 检查是否为 JSON (如 FastApp interconnect fetch 载荷)
                    is_json = False
                    try:
                        j = json.loads(val.decode("utf-8"))
                        if isinstance(j, dict):
                            keys = list(j.keys())
                            tag = j.get("tag")
                            req_id = j.get("id")
                            desc = f"{indent}field {f_num} [json, {len(val)}B]: keys={keys}"
                            if tag:
                                desc += f", tag=\"{tag}\""
                            if req_id:
                                desc += f", id=\"{req_id}\""
                            if "url" in j:
                                u = str(j["url"])
                                # 脱敏 URL 中的 query 参数
                                base_url = u.split("?")[0] if "?" in u else u
                                desc += f", url=\"{base_url}?...\","
                            if "options" in j and isinstance(j["options"], dict):
                                method = j["options"].get("method", "GET")
                                desc += f", method=\"{method}\""
                            if "resp" in j and isinstance(j["resp"], dict):
                                r = j["resp"]
                                desc += f", resp.ok={r.get('ok')}, resp.status={r.get('status')}, resp.body=<quota-json:{len(str(r.get('body', '')))}B>"
                            lines.append(desc)
                            is_json = True
                    except Exception:
                        pass
                    if not is_json:
                        # 检查是否为可打印公开标识符（如已知公开包名）
                        try:
                            s = val.decode("utf-8")
                            if s in ("com.codeisland.band", "com.bandbbs.ebook.plus", "Pulse", "OronBox"):
                                lines.append(f"{indent}field {f_num} [string, {len(val)}B]: \"{s}\" (public identifier)")
                            elif s.isprintable() and len(s) > 0:
                                lines.append(f"{indent}field {f_num} [string, {len(val)}B]: <printable_str:{len(val)}B>")
                            else:
                                lines.append(f"{indent}field {f_num} [bytes, {len(val)}B]: <bytes:{len(val)}B>")
                        except Exception:
                            lines.append(f"{indent}field {f_num} [bytes, {len(val)}B]: <bytes:{len(val)}B>")
    return lines


def analyze_pcapng(pcap_path, authkey):
    captured = frames(pcap_path)
    dec_key, enc_key = derive_keys(captured, authkey)
    
    # 消息类型名称映射（依据 WearPacket proto 定义）
    type_names = {
        1: "ACCOUNT",
        2: "DEVICE_INFO",
        4: "FITNESS",
        10: "WEATHER",
        20: "THIRDPARTY_APP",
        23: "FACTORY_OR_EXT",
    }
    
    print(f"\n================================================================================")
    print(f"PCAPNG: {pcap_path.name}")
    print(f"Total Captured Frames: {len(captured)}")
    print(f"Session Keys: dec_key=<key:16B>, enc_key=<key:16B>")
    print(f"================================================================================")
    
    timeline = []
    
    for number, direction, offset, kind, payload in captured:
        if kind != 3 or not payload.startswith(b"\x01\x02"):
            continue
        
        dir_label = "Host->Band (TX)" if direction == 0 else "Band->Host (RX)"
        key = enc_key if direction == 0 else dec_key
        decryptor = Cipher(algorithms.AES(key), modes.CTR(key)).decryptor()
        decoded = decryptor.update(payload[2:]) + decryptor.finalize()
        
        cmd = fields(decoded)
        msg_type = one(cmd, 1, 0)
        msg_id = one(cmd, 2, 0)
        nested_num = next((k for k in cmd if k not in (1, 2)), None)
        
        type_name = type_names.get(msg_type, f"TYPE_{msg_type}")
        
        # 识别该消息的特征
        feature = f"{type_name} (id={msg_id})"
        if msg_type == 20 and msg_id == 0:
            feature += " [QuickApp Installed List Query/Response]"
        elif msg_type == 20 and msg_id == 6:
            feature += " [QuickApp Connect Request (REQUEST_PHONE_APP_STATUS)]"
        elif msg_type == 20 and msg_id == 7:
            feature += " [QuickApp Connect Response (SYNC_PHONE_APP_STATUS)]"
        elif msg_type == 20 and msg_id == 8:
            feature += " [QuickApp Host->Band Downlink (SEND_PHONE_MESSAGE)]"
        elif msg_type == 20 and msg_id == 9:
            feature += " [QuickApp Band->Host Uplink (SEND_WEAR_MESSAGE)]"
        elif msg_type == 2 and msg_id == 1:
            feature += " [Heartbeat Ping/Pong]"
        elif msg_type == 10:
            feature += " [Weather Sync/Config]"
        elif msg_type == 4:
            feature += " [Fitness/Health Sync]"
            
        timeline.append({
            "packet": number,
            "direction": direction,
            "dir_label": dir_label,
            "offset": offset,
            "type": msg_type,
            "id": msg_id,
            "payload_len": len(payload),
            "feature": feature,
            "cmd": cmd,
            "nested_num": nested_num,
        })
        
        # 打印非心跳消息的完整结构树（跳过大量心跳 ping pong 以保证日志可读性）
        if not (msg_type == 2 and msg_id == 1):
            crc_val = crc16(payload)
            print(f"\n[Pkt #{number:03d}] {dir_label} | offset={offset} | len={len(payload)}B | CRC=0x{crc_val:04x} | {feature}")
            print(f"    WearPacket: type={msg_type} (wire=0), id={msg_id} (wire=0), payload_field={nested_num}")
            if nested_num and nested_num != 100:
                raw_sub = one(cmd, nested_num, 2)
                try:
                    sub_map = fields(raw_sub)
                    for l in dump_proto_fields(sub_map, "    "):
                        print(l)
                except Exception as e:
                    print(f"    <sub_proto decode failed: {e}>")
            elif nested_num == 100:
                print(f"    Status Field 100 [varint]: {one(cmd, 100, 0)}")

    print(f"\n--------------------------------------------------------------------------------")
    print(f"Summary Timeline for {pcap_path.name}:")
    print(f"--------------------------------------------------------------------------------")
    for t in timeline:
        if not (t["type"] == 2 and t["id"] == 1):
            print(f"  Pkt #{t['packet']:03d} | {t['dir_label']:<16} | len={t['payload_len']:<4}B | {t['feature']}")
    print(f"--------------------------------------------------------------------------------\n")


def main():
    parser = argparse.ArgumentParser(description="Offline business protocol decryptor")
    parser.add_argument("pcapng", nargs="?", help="Specific pcapng file to inspect")
    args = parser.parse_args()

    authkey = get_authkey()
    
    if args.pcapng:
        analyze_pcapng(Path(args.pcapng), authkey)
    else:
        for name in BASELINES:
            p = ROOT / name
            if p.exists():
                analyze_pcapng(p, authkey)


if __name__ == "__main__":
    main()
