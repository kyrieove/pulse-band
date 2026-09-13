//! `--fake` 模式：假设备 + 假手环。
//!
//! 假设备：device.connect/status/disconnect 返回固定数据，按 §1.3 的真实形状发
//! device.state 事件（connected 的判据是 state.protocolState === "ready"）。
//!
//! 假手环：设备连接后主动走一遍真实手环快应用的报文序列（报文形状逐字段照抄
//! band-app/src/pages/index/index.ux，不自己发明）：
//!   1. `__hs__` 握手（count:0 + caps v3）→ 客户端应回 count+1 + caps
//!   2. 收到握手应答后发 fetch 请求：{tag:"fetch", id, url, options}
//!      url 与真机一致：http://127.0.0.1:8765/api/status/compact?all=1
//!   3. 收到 fetch 响应后逐项断言（id 匹配 / resp.ok / 额度字段形状），
//!      结果写入 run 目录的 last-fetch-response.json 作为验收证据。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::Core;

pub const BAND_PACKAGE: &str = "com.codeisland.band";
pub const FAKE_DEVICE_ID: &str = "fakedevice-0001";

/// 假设备状态。fetch_seq 给假手环的请求编 id（真机是 reqSeq 从 r1 递增）。
pub struct FakeDevice {
    pub connected: bool,
    pub fetch_seq: u32,
    pub pending_fetch_id: Option<String>,
}

impl FakeDevice {
    pub fn new() -> Self {
        FakeDevice { connected: false, fetch_seq: 0, pending_fetch_id: None }
    }
}

/// safeDevice（pulse-core-bridge.ts）要求 name/addr 是字符串才认；disconnected 必须
/// 显式 false，否则 `raw.disconnected !== false` 会把它当成已断开。
fn fake_device() -> serde_json::Value {
    serde_json::json!({
        "name": "PulseDev Fake Band",
        "addr": "FA:KE:00:00:00:01",
        "connectType": "spp",
        "codename": "o66",
        "disconnected": false
    })
}

fn device_event(state: &str, connecting: bool) -> serde_json::Value {
    serde_json::json!({
        "state": {
            "currentDevice": if state == "disconnected" { serde_json::Value::Null } else { fake_device() },
            "protocolState": state,
            "connecting": connecting,
            "error": ""
        }
    })
}

/// 手环快应用的握手包，与 band-app doSendHandshake 逐字段一致。
fn handshake_packet() -> serde_json::Value {
    serde_json::json!({
        "tag": "__hs__",
        "count": 0,
        "caps": {
            "version": 3,
            "chunk": true,
            "maxChunkSize": 768,
            "encodings": ["text", "base64"],
            "ack": true
        }
    })
}

fn send_interconnect(core: &Core, packet: &serde_json::Value) {
    let payload: Vec<u8> = packet.to_string().into_bytes();
    core.broadcast(
        "device.interconnect",
        serde_json::json!({
            "packageName": BAND_PACKAGE,
            "deviceId": FAKE_DEVICE_ID,
            "payload": payload
        }),
    );
    core.log(&format!("band → app: {}", compact(packet)));
}

fn compact(v: &serde_json::Value) -> String {
    let s = v.to_string();
    if s.len() > 120 { format!("{}…({}B)", &s[..120], s.len()) } else { s }
}

pub fn device_connect(core: &Arc<Core>, id: &serde_json::Value) -> String {
    {
        let mut dev = core.device.lock().unwrap();
        dev.connected = true;
        dev.fetch_seq = 0;
        dev.pending_fetch_id = None;
    }
    core.log("device.connect → connecting");
    core.broadcast("device.state", device_event("connecting", true));
    let core2 = Arc::clone(core);
    std::thread::spawn(move || {
        // 给 UI 一个能观察到 connecting 的窗口，也留出 DirectFetchBridge 就位的时间
        std::thread::sleep(Duration::from_millis(250));
        core2.log("device.state → ready（客户端判据 protocolState === 'ready'）");
        core2.broadcast("device.state", device_event("ready", false));
        std::thread::sleep(Duration::from_millis(100));
        core2.log("假手环发 __hs__ 握手（count:0 + caps，照抄 band-app doSendHandshake）");
        send_interconnect(&core2, &handshake_packet());
    });
    serde_json::json!({ "id": id, "ok": true, "result": fake_device() }).to_string()
}

pub fn device_disconnect(core: &Arc<Core>, id: &serde_json::Value) -> String {
    {
        let mut dev = core.device.lock().unwrap();
        dev.connected = false;
        dev.pending_fetch_id = None;
    }
    core.log("device.disconnect");
    core.broadcast("device.state", device_event("disconnected", false));
    serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string()
}

pub fn device_status(core: &Arc<Core>, id: &serde_json::Value) -> String {
    let dev = core.device.lock().unwrap();
    let result = serde_json::json!({
        "connected": dev.connected,
        "protocolState": if dev.connected { "ready" } else { "disconnected" },
        "device": if dev.connected { fake_device() } else { serde_json::Value::Null },
        "error": ""
    });
    serde_json::json!({ "id": id, "ok": true, "result": result }).to_string()
}

pub fn interconnect_send(core: &Arc<Core>, id: &serde_json::Value, params: &serde_json::Value) -> String {
    let package = params["package"].as_str().unwrap_or("");
    let Some(payload) = params["payload"].as_array() else {
        core.log("device.interconnect.send: payload 不是数组，拒绝");
        return crate::rpc::error_resp(id, "bad_request", "payload 必须是整数数组").to_string();
    };
    let bytes: Vec<u8> = payload
        .iter()
        .map(|v| v.as_u64().unwrap_or(0) as u8)
        .collect();
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            core.log(&format!("device.interconnect.send: payload 不是合法 JSON（{e}），忽略"));
            return serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string();
        }
    };
    core.log(&format!(
        "app → band (package={package}): {}",
        compact(&parsed)
    ));

    match parsed["tag"].as_str() {
        Some("__hs__") => {
            let seq = {
                let mut dev = core.device.lock().unwrap();
                dev.fetch_seq += 1;
                dev.fetch_seq
            };
            let fetch_id = format!("r{seq}");
            core.device.lock().unwrap().pending_fetch_id = Some(fetch_id.clone());
            let req = serde_json::json!({
                "tag": "fetch",
                "id": fetch_id,
                "url": "http://127.0.0.1:8765/api/status/compact?all=1",
                "options": { "method": "GET" }
            });
            send_interconnect(core, &req);
        }
        Some("fetch") => {
            let expected = core.device.lock().unwrap().pending_fetch_id.clone();
            let report = validate_fetch_response(expected.as_deref(), &parsed);
            write_record(core, &parsed, &report);
            if report.passed {
                core.log("FETCH ROUNDTRIP PASS（详见 last-fetch-response.json）");
            } else {
                core.log("FETCH ROUNDTRIP FAIL —— 断言未全过，见 last-fetch-response.json");
            }
        }
        other => core.log(&format!("假手环忽略 tag={other:?} 的报文")),
    }
    serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string()
}

struct Check {
    name: String,
    passed: bool,
    detail: String,
}

struct Report {
    passed: bool,
    checks: Vec<Check>,
}

impl Report {
    fn push(&mut self, name: &str, passed: bool, detail: String) {
        self.passed &= passed;
        self.checks.push(Check { name: name.to_string(), passed, detail });
    }
}

/// 完成标准第 3 条的 core 侧断言：resp.ok、id 匹配、额度字段符合
/// status-server /api/status/compact?all=1 的现有协议定义（leanLimit/leanSession）。
/// 「与数据源结果一致」的对照在验收步骤做（直接 curl 同一端点比对 limits）。
fn validate_fetch_response(expected_id: Option<&str>, packet: &serde_json::Value) -> Report {
    let mut r = Report { passed: true, checks: Vec::new() };

    let resp_id = packet["id"].as_str().unwrap_or("");
    r.push(
        "响应 id 与请求 id 匹配",
        !resp_id.is_empty() && Some(resp_id) == expected_id,
        format!("expected={expected_id:?} actual={resp_id:?}"),
    );

    let resp = &packet["resp"];
    let ok = resp["ok"].as_bool();
    r.push("resp.ok === true", ok == Some(true), format!("resp.ok={:?}", ok));
    r.push(
        "resp.status === 200",
        resp["status"].as_u64() == Some(200),
        format!("resp.status={:?}", resp["status"]),
    );

    let body = resp["body"].as_str().unwrap_or("");
    let body_json: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    r.push("resp.body 是合法 JSON", body_json.is_object(), format!("body 前 80 字节: {:?}", &body[..body.len().min(80)]));
    if !body_json.is_object() {
        return r;
    }

    r.push(
        "body.ts 是数字（服务端给的墙上时间）",
        body_json["ts"].as_u64().is_some(),
        format!("ts={:?}", body_json["ts"]),
    );

    let limits = &body_json["limits"];
    let is_limit_obj = limits.as_object().map(|m| {
        ["claude", "codex", "antigravity"].iter().all(|k| m.contains_key(*k))
    });
    r.push(
        "limits 含 claude/codex/antigravity 三键",
        is_limit_obj == Some(true),
        format!("limits keys={:?}", limits.as_object().map(|m| m.keys().collect::<Vec<_>>())),
    );

    // 每个非 null 的 limit 要长成 leanLimit 的形状；额度数据来自外部服务，
    // 拉不到时是 null，这里只验形状不验「必须非空」。
    for key in ["claude", "codex", "antigravity"] {
        let l = &limits[key];
        if l.is_null() {
            r.push(&format!("limits.{key} 形状"), true, "null（外部额度源无数据时合法）".into());
            continue;
        }
        let shape_ok = l["pct5h"].is_number()
            && l["pct7d"].is_number()
            && l["level5h"].is_string()
            && l["level7d"].is_string()
            // resetText/reset7dText 经 leanLimit 的 shortReset 处理，上游无数据时是 null
            && (l["resetText"].is_string() || l["resetText"].is_null())
            && (l["reset7dText"].is_string() || l["reset7dText"].is_null())
            && l["authoritative"].is_boolean();
        r.push(
            &format!("limits.{key} 形状"),
            shape_ok,
            format!("pct5h={:?} pct7d={:?} authoritative={:?}", l["pct5h"], l["pct7d"], l["authoritative"]),
        );
    }

    let sessions = &body_json["sessions"];
    let sessions_ok = sessions.as_object().map(|m| {
        ["claude", "codex", "antigravity"].iter().all(|k| {
            let s = &m[*k];
            s.is_object() && (s["status"].is_null() || s["status"].is_string())
        })
    });
    r.push(
        "sessions 含 claude/codex/antigravity 三键（leanSession 形状）",
        sessions_ok == Some(true),
        format!("sessions keys={:?}", sessions.as_object().map(|m| m.keys().collect::<Vec<_>>())),
    );

    r
}

fn write_record(core: &Core, packet: &serde_json::Value, report: &Report) {
    let resp = &packet["resp"];
    let record = serde_json::json!({
        "receivedAt": now_ms(),
        "receivedAtIso": iso_now(),
        "requestId": packet["id"],
        "respOk": resp["ok"],
        "respStatus": resp["status"],
        "respStatusText": resp["statusText"],
        "bodyRaw": resp["body"],
        "bodyParsed": serde_json::from_str::<serde_json::Value>(resp["body"].as_str().unwrap_or("null")).unwrap_or(serde_json::Value::Null),
        "checks": report.checks.iter().map(|c| serde_json::json!({
            "name": c.name, "passed": c.passed, "detail": c.detail
        })).collect::<Vec<_>>(),
        "passed": report.passed,
    });
    let path = core.run_dir.join("last-fetch-response.json");
    if let Err(e) = std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap()) {
        core.log(&format!("写验收记录失败 {path:?}: {e}"));
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn iso_now() -> String {
    // 只用于人读记录，精度到秒就够；不引 chrono，手写 UTC 日期换算。
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let (hh, mm, ss) = (
        secs % 86400 / 3600,
        secs % 3600 / 60,
        secs % 60,
    );
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    // Howard Hinnant 的公历算法（公有领域）
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
