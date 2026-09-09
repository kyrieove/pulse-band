//! 真机业务数据泵（阶段 6B）—— 业务帧加解密与快应用 interconnect 报文编解码。
//!
//! 依据 docs/protocol/business.md §3.2 的真实抓包结构（fetchevidence-2026-09-09.pcapng）：
//! - 业务帧：`type=0x03`，payload = `01 02 || AES-128-CTR(ciphertext)`，IV = 该方向密钥（16B）。
//! - 解密后明文为 WearPacket protobuf：field1=type(varint), field2=id(varint), field22=ThirdpartyApp。
//! - ThirdpartyApp.field 9 = MessageContent：field1=BasicInfo(package_name,fingerprint), field2=content(bytes, UTF-8 JSON)。
//! - 上行（手环→主机）id=9（SEND_WEAR_MESSAGE）；下行（主机→手环）id=8（SEND_PHONE_MESSAGE）。
//!
//! fingerprint 从上行报文的 BasicInfo 动态获取（不硬编码、不打印），下行应答复用同一 BasicInfo。

use aes::Aes128;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr128BE;

use std::time::Duration;

use crate::Core;
use crate::frame::{decode, encode, Frame};
use crate::rfcomm;
use crate::session::{
    Session, SessionState, encode_field, encode_varint_bytes, extract_one_bytes,
    extract_one_varint, parse_protobuf,
};

/// AES-128-CTR，128 位大端计数器，nonce/IV = 完整 16B 方向密钥（与 verify_auth.py 的 `modes.CTR(key)` 一致）。
type BizCtr = Ctr128BE<Aes128>;

/// 业务载荷前缀：`01 02`。
pub const BIZ_PREFIX: [u8; 2] = [0x01, 0x02];

/// 对业务密文做 AES-128-CTR（IV=key）解密。CTR 加密/解密同一 keystream，故加解密同函数。
pub fn biz_stream(key: &[u8; 16], data: &[u8]) -> Vec<u8> {
    let mut buf = data.to_vec();
    // AES-128-CTR：key 与 128 位大端初始计数器(IV) 同为本方向密钥（与 verify_auth.py 的 `modes.CTR(key)` 一致）。
    let mut cipher = BizCtr::new_from_slices(key, key).expect("AES-128-CTR key+IV 各 16B");
    cipher.apply_keystream(&mut buf);
    buf
}

/// 解密一个业务帧的 payload（`01 02 || ct`），返回明文 protobuf。
pub fn decrypted_business_payload(key: &[u8; 16], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 2 || payload[0..2] != BIZ_PREFIX {
        return None;
    }
    Some(biz_stream(key, &payload[2..]))
}

/// 把明文 protobuf 封装为可下发的业务帧 payload（`01 02 || ct`）。
pub fn business_frame_payload(key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + plaintext.len());
    out.extend_from_slice(&BIZ_PREFIX);
    out.extend_from_slice(&biz_stream(key, plaintext));
    out
}

/// BasicInfo：快应用标识（package_name 字符串 + 20B fingerprint）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicInfo {
    pub package_name: String,
    pub fingerprint: Vec<u8>,
}

/// 上行 fetch 报文内容：BasicInfo + content(原始 UTF-8 JSON 字节)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UplinkFetch {
    pub basic: BasicInfo,
    pub content: Vec<u8>,
}

fn parse_basic_info(raw: &[u8]) -> Result<BasicInfo, String> {
    let m = parse_protobuf(raw).map_err(|e| format!("BasicInfo 解析失败: {e}"))?;
    let package_name = extract_one_bytes(&m, 1)
        .map_err(|_| "BasicInfo 缺 field 1 package_name")?
        .to_vec();
    let fingerprint = extract_one_bytes(&m, 2)
        .map_err(|_| "BasicInfo 缺 field 2 fingerprint")?
        .to_vec();
    Ok(BasicInfo {
        package_name: String::from_utf8(package_name).unwrap_or_default(),
        fingerprint,
    })
}

/// 从 WeaPacket 明文解析出「上行 fetch/业务」内容（type=20, id=9, field22→field9→content）。
/// 非握手/非 fetch 的 type=20 帧（如 id=0 列表、id=6/7 建链）返回 None，不视为错误。
pub fn parse_uplink(decoded: &[u8]) -> Result<Option<UplinkFetch>, String> {
    let wp = parse_protobuf(decoded).map_err(|e| format!("WearPacket 解析失败: {e}"))?;
    let msg_type = extract_one_varint(&wp, 1).map_err(|_| "WearPacket 缺 type")?;
    let msg_id = extract_one_varint(&wp, 2).map_err(|_| "WearPacket 缺 id")?;
    if msg_type != 20 {
        return Ok(None);
    }
    // 只有 id=9 (SEND_WEAR_MESSAGE, 手环→主机) 是需要桥接给客户端的业务上行；
    // 建链(id=6)、握手(content=__hs__)、列表(id=0)等由本阶段先透传或忽略。
    if msg_id != 9 {
        return Ok(None);
    }
    let thirdparty = parse_protobuf(extract_one_bytes(&wp, 22).map_err(|_| "缺 field22")?)
        .map_err(|e| format!("ThirdpartyApp 解析失败: {e}"))?;
    let msg_content = parse_protobuf(extract_one_bytes(&thirdparty, 9).map_err(|_| "缺 field9")?)
        .map_err(|e| format!("MessageContent 解析失败: {e}"))?;
    let basic = parse_basic_info(extract_one_bytes(&msg_content, 1).map_err(|_| "缺 field9.field1")?)?;
    let content = extract_one_bytes(&msg_content, 2)
        .map_err(|_| "缺 field9.field2 content")?
        .to_vec();
    Ok(Some(UplinkFetch { basic, content }))
}

/// 从 WearPacket 明文解析出下行内容（type=20, id=8）的 content 字节，用于校验我们对端回传。
pub fn parse_downlink_content(decoded: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let wp = parse_protobuf(decoded).map_err(|e| format!("WearPacket 解析失败: {e}"))?;
    let msg_type = extract_one_varint(&wp, 1).map_err(|_| "WearPacket 缺 type")?;
    let msg_id = extract_one_varint(&wp, 2).map_err(|_| "WearPacket 缺 id")?;
    if msg_type != 20 || msg_id != 8 {
        return Ok(None);
    }
    let thirdparty = parse_protobuf(extract_one_bytes(&wp, 22).map_err(|_| "缺 field22")?)
        .map_err(|e| format!("ThirdpartyApp 解析失败: {e}"))?;
    let msg_content = parse_protobuf(extract_one_bytes(&thirdparty, 9).map_err(|_| "缺 field9")?)
        .map_err(|e| format!("MessageContent 解析失败: {e}"))?;
    Ok(Some(
        extract_one_bytes(&msg_content, 2)
            .map_err(|_| "缺 field9.field2 content")?
            .to_vec(),
    ))
}

/// 构造下行 fetch 响应 WearPacket 明文（type=20, id=8, field22→field9→BasicInfo + content）。
/// basic 应复用上行报文里拿到的同一 BasicInfo（保证 fingerprint 一致）；content 为客户端回传的响应 JSON 字节。
pub fn build_downlink_payload(basic: &BasicInfo, content: &[u8]) -> Vec<u8> {
    // MessageContent: field1 = BasicInfo, field2 = content (length-delimited)
    let mut basic_raw = Vec::new();
    basic_raw.extend_from_slice(&encode_field(1, 2, basic.package_name.as_bytes()));
    basic_raw.extend_from_slice(&encode_field(2, 2, &basic.fingerprint));
    let mut msg_content = Vec::new();
    msg_content.extend_from_slice(&encode_field(1, 2, &basic_raw));
    msg_content.extend_from_slice(&encode_field(2, 2, content));
    // ThirdpartyApp: field 9 = MessageContent
    let thirdparty = encode_field(9, 2, &msg_content);
    // WearPacket: field1=type(20), field2=id(8), field22=ThirdpartyApp
    let mut wp = Vec::new();
    wp.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(20)));
    wp.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(8)));
    wp.extend_from_slice(&encode_field(22, 2, &thirdparty));
    wp
}

/// 构造一个已加密的业务帧（type=0x03，payload=`01 02 || ct`），可直接发给手环。
pub fn build_downlink_frame(key: &[u8; 16], basic: &BasicInfo, content: &[u8], seq: u8) -> Frame {
    let decoded = build_downlink_payload(basic, content);
    Frame {
        frame_type: 0x03,
        seq,
        payload: business_frame_payload(key, &decoded),
    }
}

/// 数据泵下行桥接上下文：RPC 线程可通过它向手环写下行帧。
pub struct DownlinkCtx {
    pub sock: usize,
    pub enc_key: [u8; 16],
    pub basic: Option<BasicInfo>,
    pub seq_out: u8,
}

fn read_device_auth_mac() -> Result<([u8; 16], u64), String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA 不存在")?;
    let path = std::path::Path::new(&base).join("PulseDev/run/device.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读 device.json 失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 device.json 失败: {e}"))?;
    let authkey_hex = v["authkey"].as_str().ok_or("device.json 缺 authkey")?;
    if authkey_hex.len() != 32 {
        return Err(format!("authkey hex 长度须 32，实际 {}", authkey_hex.len()));
    }
    let mut authkey = [0u8; 16];
    for i in 0..16 {
        authkey[i] = u8::from_str_radix(&authkey_hex[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("authkey hex 解码失败: {e}"))?;
    }
    let addr = v["addr"].as_str().ok_or("device.json 缺 addr")?;
    let hex: String = addr.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return Err("MAC 格式异常".to_string());
    }
    let mut mac = [0u8; 6];
    for i in 0..6 {
        mac[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| "MAC 解析失败")?;
    }
    // BTH_ADDR 按大端组合（与 rfcomm::run_probe 的 0x0434c3979a06 同构）。
    let mac_u64 = mac.iter().fold(0u64, |acc, b| (acc << 8) | (*b as u64));
    Ok((authkey, mac_u64))
}

fn spp_guid() -> rfcomm::Guid {
    rfcomm::Guid {
        data1: 0x00001101,
        data2: 0x0000,
        data3: 0x1000,
        data4: [0x80, 0x00, 0x00, 0x80, 0x5F, 0x9B, 0x34, 0xFB],
    }
}

fn connect_rfcomm(mac_u64: u64) -> Result<usize, String> {
    let sock = unsafe { rfcomm::socket(rfcomm::AF_BTH, rfcomm::SOCK_STREAM, rfcomm::BTHPROTO_RFCOMM) };
    if sock == rfcomm::INVALID_SOCKET {
        return Err(format!("socket 失败: {}", unsafe { rfcomm::WSAGetLastError() }));
    }
    let sockaddr = rfcomm::SockAddrBth {
        address_family: rfcomm::AF_BTH as u16,
        bt_addr: mac_u64,
        service_class_id: spp_guid(),
        port: 0,
    };
    let ret = unsafe {
        rfcomm::connect(
            sock,
            &sockaddr as *const rfcomm::SockAddrBth,
            std::mem::size_of::<rfcomm::SockAddrBth>() as i32,
        )
    };
    if ret != 0 {
        let err = unsafe { rfcomm::WSAGetLastError() };
        unsafe { rfcomm::closesocket(sock) };
        return Err(format!("connect 失败: {err}"));
    }
    // 前导帧与协商帧（transport.md §7/§9）
    let preamble = [0xba, 0xdc, 0xfe, 0x00, 0xc0, 0x03, 0x00, 0x00, 0x01, 0x00, 0xef];
    send_all(sock, &preamble)?;
    let mut pre_buf = [0u8; 64];
    let pre_n = recv_into(sock, &mut pre_buf)?;
    if pre_n < 14 || !pre_buf[..14].starts_with(&[0xba, 0xdc, 0xfe]) {
        return Err("前导响应异常".to_string());
    }
    let nego = Frame {
        frame_type: 0x02,
        seq: 0x00,
        payload: vec![
            0x01, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0xfc, 0x03, 0x02,
            0x00, 0x20, 0x00, 0x04, 0x02, 0x00, 0x10, 0x27,
        ],
    };
    send_all(sock, &encode(&nego))?;
    Ok(sock)
}

fn send_all(sock: usize, data: &[u8]) -> Result<(), String> {
    let n = unsafe { rfcomm::send(sock, data.as_ptr(), data.len() as i32, 0) };
    if n != data.len() as i32 {
        return Err(format!("send 失败 sent={n}"));
    }
    Ok(())
}

fn recv_into(sock: usize, buf: &mut [u8]) -> Result<usize, String> {
    let n = unsafe { rfcomm::recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0) };
    if n <= 0 {
        let err = unsafe { rfcomm::WSAGetLastError() };
        return Err(format!("recv 失败 n={n} err={err}"));
    }
    Ok(n as usize)
}

/// 连接 + 前导/协商 + Session 认证，返回 (socket, enc_key, dec_key)。
fn connect_and_authenticate() -> Result<(usize, [u8; 16], [u8; 16]), String> {
    let (authkey, mac) = read_device_auth_mac()?;
    unsafe {
        let mut wsa = std::mem::zeroed::<rfcomm::WsaData>();
        if rfcomm::WSAStartup(0x0202, &mut wsa) != 0 {
            return Err("WSAStartup 失败".to_string());
        }
    }
    let sock = connect_rfcomm(mac)?;
    let mut session = Session::new(authkey);
    let step1 = session.start_auth(None).map_err(|e| format!("start_auth: {e}"))?;
    send_all(sock, &encode(&step1))?;

    let mut rx = Vec::new();
    let mut raw = [0u8; 1024];
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut enc_key = [0u8; 16];
    let mut dec_key = [0u8; 16];
    let mut authed = false;
    while std::time::Instant::now() < deadline && !authed {
        unsafe { rfcomm::setsockopt(sock, rfcomm::SOL_SOCKET, rfcomm::SO_RCVTIMEO, &1000u32 as *const u32 as *const u8, 4) };
        let n = unsafe { rfcomm::recv(sock, raw.as_mut_ptr(), raw.len() as i32, 0) };
        if n > 0 {
            rx.extend_from_slice(&raw[..n as usize]);
        } else if n < 0 {
            let err = unsafe { rfcomm::WSAGetLastError() };
            if err != rfcomm::WSAETIMEDOUT {
                unsafe { rfcomm::closesocket(sock) };
                return Err(format!("认证recv失败 err={err}"));
            }
            continue;
        } else {
            unsafe { rfcomm::closesocket(sock) };
            return Err("对端认证中断".to_string());
        }
        loop {
            match decode(&rx) {
                Ok((frame, consumed)) => {
                    rx.drain(..consumed);
                    if frame.frame_type == 0x01 {
                        continue;
                    }
                    if frame.frame_type == 0x02 {
                        let ack = Frame { frame_type: 0x01, seq: frame.seq, payload: vec![] };
                        send_all(sock, &encode(&ack))
                            .map_err(|e| { unsafe { rfcomm::closesocket(sock) }; e })?;
                        continue;
                    }
                    if frame.frame_type != 0x03 {
                        continue;
                    }
                    match session.process_frame(&frame) {
                        Ok(Some(step3)) => {
                            send_all(sock, &encode(&step3)).map_err(|e| {
                                unsafe { rfcomm::closesocket(sock) };
                                e
                            })?;
                        }
                        Ok(None) => {
                            if let SessionState::Authenticated { .. } = session.state() {
                                let (dk, ek) =
                                    session.business_keys().map_err(|e| format!("密钥: {e}"))?;
                                dec_key = dk;
                                enc_key = ek;
                                authed = true;
                            }
                        }
                        Err(e) => {
                            unsafe { rfcomm::closesocket(sock) };
                            return Err(format!("认证状态机错误: {e}"));
                        }
                    }
                }
                Err(crate::frame::DecodeError::Incomplete) => break,
                Err(_) => break,
            }
            if authed {
                break;
            }
        }
    }
    if !authed {
        unsafe { rfcomm::closesocket(sock) };
        return Err("认证超时/未完成".to_string());
    }
    Ok((sock, enc_key, dec_key))
}

fn broadcast_interconnect(core: &Core, content: &[u8]) {
    let payload: Vec<serde_json::Value> = content.iter().map(|b| serde_json::json!(b)).collect();
    core.broadcast(
        "device.interconnect",
        serde_json::json!({
            "packageName": "com.codeisland.band",
            "deviceId": "pulse-core-live",
            "payload": payload,
        }),
    );
}

/// 阶段 6B 数据泵入口：连接真机、认证、而后进入业务收循环，把上行 fetch/快应用消息转发给客户端。
pub fn run_live(core: &Core) -> Result<(), String> {
    let (sock, enc_key, dec_key) = connect_and_authenticate()?;
    unsafe { rfcomm::setsockopt(sock, rfcomm::SOL_SOCKET, rfcomm::SO_RCVTIMEO, &300u32 as *const u32 as *const u8, 4) };
    *core.bt.lock().unwrap() = Some(DownlinkCtx { sock, enc_key, basic: None, seq_out: 0 });
    core.log("阶段 6B 数据泵：已认证，进入业务转发循环（脱敏）");

    let mut rx = Vec::new();
    let mut raw = [0u8; 1024];
    loop {
        let n = unsafe { rfcomm::recv(sock, raw.as_mut_ptr(), raw.len() as i32, 0) };
        if n > 0 {
            rx.extend_from_slice(&raw[..n as usize]);
        } else if n < 0 {
            let err = unsafe { rfcomm::WSAGetLastError() };
            if err != rfcomm::WSAETIMEDOUT {
                core.log(&format!("数据泵 recv 错误 err={err}，退出"));
                break;
            }
            continue;
        } else {
            core.log("数据泵：对端断开，退出");
            break;
        }
        loop {
            match decode(&rx) {
                Ok((frame, consumed)) => {
                    rx.drain(..consumed);
                    if frame.frame_type == 0x02 {
                        let ack = Frame { frame_type: 0x01, seq: frame.seq, payload: vec![] };
                        let _ = send_all(sock, &encode(&ack));
                        continue;
                    }
                    if frame.frame_type != 0x03 || !frame.payload.starts_with(&BIZ_PREFIX) {
                        continue;
                    }
                    if let Some(plain) = decrypted_business_payload(&dec_key, &frame.payload) {
                        if let Ok(Some(up)) = parse_uplink(&plain) {
                            let tag: String = String::from_utf8_lossy(&up.content).chars().take(12).collect();
                            core.log(&format!("数据泵上行 id=9 content tag≈ {tag}(脱敏) len={}", up.content.len()));
                            {
                                let mut bt = core.bt.lock().unwrap();
                                if let Some(ctx) = bt.as_mut() {
                                    ctx.basic = Some(up.basic.clone());
                                }
                            }
                            broadcast_interconnect(core, &up.content);
                        }
                    }
                }
                Err(crate::frame::DecodeError::Incomplete) => break,
                Err(_) => break,
            }
        }
    }
    unsafe { rfcomm::closesocket(sock); rfcomm::WSACleanup(); }
    *core.bt.lock().unwrap() = None;
    Ok(())
}

/// RPC `device.interconnect.send` 的桥接：把客户端回传的 content（`__hs__` 应答或 fetch 响应 JSON）
/// 构造为下行 id=8 帧发回手环。返回 RPC 响应字符串。
pub fn handle_downlink(core: &Core, req_id: &serde_json::Value, params: &serde_json::Value) -> String {
    let content = match params["payload"].as_array() {
        Some(a) => a.iter().filter_map(|v| v.as_u64().map(|u| u as u8)).collect::<Vec<u8>>(),
        None => return crate::rpc::error_resp(req_id, "bad_request", "payload 缺整数数组").to_string(),
    };
    let mut bt = core.bt.lock().unwrap();
    let Some(ctx) = bt.as_mut() else {
        return crate::rpc::error_resp(req_id, "not_live", "数据泵未连接").to_string();
    };
    let Some(basic) = ctx.basic.clone() else {
        return crate::rpc::error_resp(req_id, "no_basic", "尚未收到上行 BasicInfo").to_string();
    };
    let frame = build_downlink_frame(&ctx.enc_key, &basic, &content, ctx.seq_out);
    ctx.seq_out = ctx.seq_out.wrapping_add(1);
    let raw = encode(&frame);
    match send_all(ctx.sock, &raw) {
        Ok(()) => serde_json::json!({ "id": req_id, "ok": true, "result": {} }).to_string(),
        Err(e) => crate::rpc::error_resp(req_id, "send_failed", &e).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::decode;

    const KEY: [u8; 16] = [0x11u8; 16];

    fn basic() -> BasicInfo {
        BasicInfo {
            package_name: "com.codeisland.band".to_string(),
            fingerprint: vec![0x22u8; 20],
        }
    }

    fn fetch_content(id: &str) -> Vec<u8> {
        format!(r#"{{"tag":"fetch","id":"{id}","url":"http://127.0.0.1:8765/api/status/compact?all=1","options":{{"method":"GET"}}}}"#)
            .into_bytes()
    }

    #[test]
    fn test_biz_ctr_roundtrip() {
        let plain = b"hello business payload";
        let enc = biz_stream(&KEY, plain);
        assert_ne!(enc, plain.as_slice());
        let dec = biz_stream(&KEY, &enc);
        assert_eq!(dec, plain.as_slice());
    }

    #[test]
    fn test_uplink_parse_and_downlink_roundtrip() {
        // 构造上行 id=8? 不，上行 id=9。先构造一个上行明文 WearPacket 并加密成业务帧 payload。
        // 上行: type=20, id=9, field22->field9(MessageContent: field1 BasicInfo, field2 content)
        let basic = basic();
        let content = fetch_content("r1");
        let mut basic_raw = Vec::new();
        basic_raw.extend_from_slice(&encode_field(1, 2, basic.package_name.as_bytes()));
        basic_raw.extend_from_slice(&encode_field(2, 2, &basic.fingerprint));
        let mut msg_content = Vec::new();
        msg_content.extend_from_slice(&encode_field(1, 2, &basic_raw));
        msg_content.extend_from_slice(&encode_field(2, 2, &content));
        let thirdparty = encode_field(9, 2, &msg_content);
        let mut wp = Vec::new();
        wp.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(20)));
        wp.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(9)));
        wp.extend_from_slice(&encode_field(22, 2, &thirdparty));

        let payload = business_frame_payload(&KEY, &wp);
        assert!(payload.starts_with(&BIZ_PREFIX));
        let dec = decrypted_business_payload(&KEY, &payload).expect("decrypt");
        let up = parse_uplink(&dec).expect("parse").expect("uplink present");
        assert_eq!(up.basic.package_name, "com.codeisland.band");
        assert_eq!(up.basic.fingerprint, vec![0x22u8; 20]);
        let json: serde_json::Value = serde_json::from_slice(&up.content).unwrap();
        assert_eq!(json["tag"], "fetch");
        assert_eq!(json["id"], "r1");

        // 用上行拿到的 BasicInfo + 客户端响应构造下行 id=8 帧，再解析回 content 验证。
        let resp = br#"{"tag":"fetch","id":"r1","resp":{"ok":true,"status":200,"statusText":"OK","headers":{"content-type":"application/json"},"body":"{\"ts\":1,\"limits\":{}}"}}"#;
        let frame = build_downlink_frame(&KEY, &up.basic, resp, 0x07);
        assert_eq!(frame.frame_type, 0x03);
        assert_eq!(frame.seq, 0x07);
        let raw = encode(&frame);
        let (decoded_frame, consumed) = decode(&raw).expect("frame decode");
        assert_eq!(consumed, raw.len());
        assert_eq!(decoded_frame.frame_type, 0x03);
        let dec_down = decrypted_business_payload(&KEY, &decoded_frame.payload).expect("decrypt down");
        let content = parse_downlink_content(&dec_down).expect("parse").expect("content");
        // 解析回 content 为 JSON，字段一致
        let down: serde_json::Value = serde_json::from_slice(&content).unwrap();
        assert_eq!(down["tag"], "fetch");
        assert_eq!(down["id"], "r1");
        assert_eq!(down["resp"]["ok"], true);
    }
}
