"""Offline baseline audit. Requires Python 3.10+, cryptography and tshark.

No network/device access; credentials and decrypted bytes stay in memory.
Protocol source: OronBox 26dd89e7ceea153cb6258660790a20e5e4675cb0.
"""

import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESCCM

ROOT = Path(__file__).resolve().parents[1]
BASELINES = {
    "baseline-2026-09-08-01.pcapng": "2fe44431438f1cd7350f3a5f4b10f2d2199a89b4dfb4a27ff30ba5dc5fd5b099",
    "baseline-2026-09-08-02.pcapng": "3f3fd740c81bfc9ad7c5354d3743ab2e1073627a40e9deb5e72cdc1857e0a377",
}


def require(condition):
    if not condition:
        raise ValueError("validation failed")


def varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        require(pos < len(data))
        byte = data[pos]
        pos += 1
        require(shift != 63 or byte <= 1)
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError("invalid varint")


def fields(data):
    """Consume every byte; retain duplicates for explicit schema checks."""
    result = {}
    pos = 0
    while pos < len(data):
        tag, pos = varint(data, pos)
        number, wire = tag >> 3, tag & 7
        require(0 < number < 2**29)
        if wire == 0:
            value, pos = varint(data, pos)
        else:
            require(wire in (1, 2, 5))
            if wire == 2:
                size, pos = varint(data, pos)
            else:
                size = 8 if wire == 1 else 4
            require(pos + size <= len(data))
            value = data[pos:pos + size]
            pos += size
        result.setdefault(number, []).append((wire, value))
    return result


def one(message, number, wire):
    values = message.get(number, [])
    require(len(values) == 1 and values[0][0] == wire)
    return values[0][1]


def encode_varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    return bytes(out) + bytes([value])


def encode_field(number, wire, value):
    encoded = encode_varint(value) if wire == 0 else encode_varint(len(value)) + value
    return encode_varint(number * 8 + wire) + encoded


def crc16(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def frames(path):
    command = [r"C:\Program Files\Wireshark\tshark.exe", "-r", str(path),
               "-Y", "btrfcomm && data", "-T", "fields", "-e", "frame.number",
               "-e", "hci_h4.direction", "-e", "data.data"]
    output = subprocess.run(command, capture_output=True, text=True, check=True).stdout
    streams = [bytearray(), bytearray()]
    origins = [[], []]
    for line in output.splitlines():
        number, direction, raw = line.split("\t")
        direction = int(direction, 16)
        require(direction in (0, 1))
        data = bytes.fromhex(raw.replace(",", ""))
        streams[direction].extend(data)
        origins[direction].extend([int(number)] * len(data))
    result = []
    for direction, stream in enumerate(streams):
        pos = stream.find(b"\xa5\xa5")
        require(pos >= 0)
        print(f"  direction={direction} preamble_bytes={pos}")
        while pos < len(stream):
            require(stream[pos:pos + 2] == b"\xa5\xa5" and pos + 8 <= len(stream))
            end = pos + 8 + int.from_bytes(stream[pos + 4:pos + 6], "little")
            require(end <= len(stream))
            payload = bytes(stream[pos + 8:end])
            require(crc16(payload) == int.from_bytes(stream[pos + 6:pos + 8], "little"))
            result.append((origins[direction][pos], direction, pos, stream[pos + 2], payload))
            pos = end
    return sorted(result)


def mac(key, data):
    return hmac.digest(key, data, "sha256")


def audit(path, authkey):
    require(hashlib.sha256(path.read_bytes()).hexdigest() == BASELINES[path.name])
    print(f"SESSION {path.name} sha256=PASS")
    captured = frames(path)
    print(f"  complete_frames_crc=PASS count={len(captured)}")
    handshake = [f for f in captured if f[3] == 3 and f[4].startswith(b"\x01\x01")]
    require(len(handshake) == 4)
    bodies = []
    for index, (number, direction, offset, _, payload) in enumerate(handshake):
        require(direction == index % 2)
        command = fields(payload[2:])
        require(set(command) == {1, 2, 3})
        require(one(command, 1, 0) == 1 and one(command, 2, 0) == 26 + index // 2)
        account = fields(one(command, 3, 2))
        require(set(account) == {30 + index})
        bodies.append(fields(one(account, 30 + index, 2)))
        require(set(bodies[-1]) == ({1}, {1, 2}, {1, 2}, {1, 2, 3})[index])
        print(f"  step={index + 1} packet={number} direction={direction} stream_offset={offset} payload_bytes={len(payload)}")
    phone = one(bodies[0], 1, 2)
    watch = one(bodies[1], 1, 2)
    require(len(phone) == len(watch) == len(authkey) == 16)
    prk = mac(phone + watch, authkey)
    t1 = mac(prk, b"miwear-auth\x01")
    block = t1 + mac(prk, t1 + b"miwear-auth\x02")
    dec_key, enc_key = block[:16], block[16:32]
    require(hmac.compare_digest(mac(dec_key, watch + phone), one(bodies[1], 2, 2)))
    print("  step2_hmac=PASS bytes=32")
    signature = mac(enc_key, phone + watch)
    require(hmac.compare_digest(signature, one(bodies[2], 1, 2)))
    print("  step3_app_sign=PASS bytes=32")
    nonce = block[36:40] + bytes(8)
    cipher = AESCCM(enc_key, tag_length=4)
    ciphertext = one(bodies[2], 2, 2)
    plaintext = cipher.decrypt(nonce, ciphertext, b"")
    companion = fields(plaintext)
    require(set(companion) == {1, 3, 4})
    require(one(companion, 1, 0) in (0, 1, 2, 15))
    one(companion, 3, 2).decode("utf-8")
    require(one(companion, 4, 0) <= 0xFFFFFFFF)
    # Independently construct the public OronBox companion constants; retain
    # platform enum as an explicitly capture-derived input, never print it.
    rebuilt = (encode_field(1, 0, one(companion, 1, 0))
               + encode_field(3, 2, b"OronBox")
               + encode_field(4, 0, 0xFFFFFFFF))
    require(rebuilt == plaintext)
    encrypted = cipher.encrypt(nonce, rebuilt, b"")
    require(encrypted == ciphertext)
    step3 = encode_field(1, 2, signature) + encode_field(2, 2, encrypted)
    packet = (b"\x01\x01" + encode_field(1, 0, 1) + encode_field(2, 0, 27)
              + encode_field(3, 2, encode_field(32, 2, step3)))
    require(packet == handshake[2][4])
    print(f"  step3_ccm_tag=PASS plaintext_bytes={len(plaintext)} tag_bytes=4")
    print("  step3_public_companion_rebuild=PASS platform_input=capture")
    print(f"  step3_full_payload=PASS bytes={len(packet)}")
    bad = ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
    try:
        cipher.decrypt(nonce, bad, b"")
    except InvalidTag:
        print("  negative_control_modified_ccm_tag=REJECTED")
    else:
        raise ValueError("negative control failed")
    require(set(bodies[3]) == {1, 2, 3})
    require(one(bodies[3], 1, 0) == 1)
    for number in (2, 3):
        require(one(bodies[3], number, 0) <= 0xFFFFFFFF)
    print("  step4_confirm_result=true capability_fields=2,3")
    # WearPacket schema: known type -> corresponding oneof payload number.
    payload_fields = {1: 3, 2: 4, 4: 6, 5: 7, **{n: n + 2 for n in range(7, 24)}}
    totals = [[0, 0], [0, 0]]
    for number, direction, offset, kind, payload in captured:
        if kind != 3 or not payload.startswith(b"\x01\x02"):
            continue
        try:
            require(number > handshake[3][0])
            key = enc_key if direction == 0 else dec_key
            decryptor = Cipher(algorithms.AES(key), modes.CTR(key)).decryptor()
            decoded = decryptor.update(payload[2:]) + decryptor.finalize()
            command = fields(decoded)
            msg_type = one(command, 1, 0)
            require(msg_type in payload_fields and one(command, 2, 0) <= 0xFFFFFFFF)
            # Proto2 oneof payload is optional (e.g. a query with only type/id).
            require(set(command) in ({1, 2}, {1, 2, payload_fields[msg_type]}, {1, 2, 100}))
            nested_number = next((n for n in command if n not in (1, 2)), None)
            if nested_number == 100:
                one(command, 100, 0)
            elif nested_number is not None:
                fields(one(command, nested_number, 2))
            totals[direction][0] += 1
        except ValueError:
            totals[direction][1] += 1
            print(f"  business_envelope=FAIL packet={number} direction={direction} stream_offset={offset}")
    for direction, (passed, failed) in enumerate(totals):
        print(f"  business direction={direction} envelope_pass={passed} failed={failed} skipped=0")
    require(sum(n[0] for n in totals) > 0 and sum(n[1] for n in totals) == 0)
    print("  RESULT=PASS (business envelope/wire validation, not full nested semantics)")


if __name__ == "__main__":
    try:
        credential = Path(os.environ["LOCALAPPDATA"]) / "PulseDev/run/device.json"
        authkey = bytes.fromhex(json.loads(credential.read_text(encoding="utf-8"))["authkey"])
        for name in BASELINES:
            audit(ROOT / name, authkey)
    except Exception as error:
        # Exception messages may contain input material; disclose only the type.
        print(f"AUDIT FAILED ({type(error).__name__}); sensitive details suppressed")
        sys.exit(1)
