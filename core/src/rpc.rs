//! RPC 连接处理：行分隔 JSON 请求 → 分发 → 行响应；事件经 ClientHandle 广播。
//!
//! 线协议按 §1.3（从 oronbox-client.ts 的 onData/call 逐行核对）：
//! 请求 {"id":"r1","method":"…","params":{…},"token":"…"}
//! 响应 {"id":"r1","ok":true,"result":…} / {"id":"r1","ok":false,"error":{"code","message"}}
//! 事件 {"messageType":"event","event":"…",…其余字段平铺}

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use crate::fake;
use crate::Core;

/// 一个已连接的 RPC 客户端。写操作经同一把互斥锁串行化，
/// 请求响应（本连接写）和广播事件（别的线程写）不会把行写花。
#[derive(Clone)]
pub struct ClientHandle {
    pub id: u64,
    writer: Arc<Mutex<TcpStream>>,
}

impl ClientHandle {
    pub fn send_line(&self, line: &str) -> bool {
        let Ok(mut w) = self.writer.lock() else {
            return false;
        };
        writeln!(w, "{line}").is_ok() && w.flush().is_ok()
    }
}

pub fn serve(core: Arc<Core>, stream: TcpStream) {
    let Ok(writer) = stream.try_clone() else {
        return;
    };
    let id = next_client_id();
    let handle = ClientHandle {
        id,
        writer: Arc::new(Mutex::new(writer)),
    };
    core.clients.lock().unwrap().push(handle.clone());

    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // daemon.stop 的响应必须先落到 socket 再退出进程，所以 dispatch
        // 只返回退出意图，写完这一行才执行。
        let (resp, shutdown) = dispatch(&core, &line);
        if !handle.send_line(&resp) {
            break;
        }
        if shutdown {
            core.shutdown_requested
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // 先对这条连接发 FIN（数据已 write+flush），客户端就能读到响应而不是吃 RST
            if let Ok(w) = handle.writer.lock() {
                let _ = w.shutdown(std::net::Shutdown::Both);
            }
            // 清除 core.bt 并释放 SPP socket（由 DownlinkCtx 的 Drop 保证 closesocket 与 WSACleanup）
            if let Some(_ctx) = core.bt.lock().unwrap().take() {
                core.log("daemon.stop: SPP socket 显式释放");
            }
            let _ = fs::remove_file(core.run_dir.join("core.json"));
            core.log("daemon.stop: 端点文件已删，进程退出");
            std::process::exit(0);
        }
    }
    core.clients.lock().unwrap().retain(|c| c.id != id);
}

fn next_client_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub fn error_resp(id: &serde_json::Value, code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "ok": false,
        "error": { "code": code, "message": message }
    })
}

/// 返回 (响应行, 是否要退出进程)
fn dispatch(core: &Arc<Core>, line: &str) -> (String, bool) {
    let req: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            return (
                error_resp(&serde_json::Value::Null, "bad_request", "不是合法 JSON").to_string(),
                false,
            )
        }
    };
    let id = req["id"].clone();
    let method = req["method"].as_str().unwrap_or("");
    let params = req["params"].clone();

    if req["token"].as_str() != Some(core.token.as_str()) {
        return (
            error_resp(&id, "unauthorized", "token 不匹配").to_string(),
            false,
        );
    }

    match method {
        "daemon.info" => {
            let result = serde_json::json!({
                "pid": std::process::id(),
                "protocolVersion": crate::PROTOCOL_VERSION,
                "platform": "windows",
                "endpoint": format!("127.0.0.1:{}", endpoint_port(core)),
                "uptimeSeconds": core.started.elapsed().as_secs(),
            });
            (
                serde_json::json!({ "id": id, "ok": true, "result": result }).to_string(),
                false,
            )
        }
        "daemon.stop" => (
            serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string(),
            true,
        ),
        "device.connect" => {
            let resp = match core.mode {
                crate::CoreMode::Live => crate::live::device_connect_live(core, &id),
                crate::CoreMode::Fake => fake::device_connect(core, &id),
            };
            (resp, false)
        }
        "device.disconnect" => {
            let resp = match core.mode {
                crate::CoreMode::Live => crate::live::device_disconnect_live(core, &id),
                crate::CoreMode::Fake => fake::device_disconnect(core, &id),
            };
            (resp, false)
        }
        "device.status" => {
            let resp = match core.mode {
                crate::CoreMode::Live => crate::live::device_status_live(core, &id),
                crate::CoreMode::Fake => fake::device_status(core, &id),
            };
            (resp, false)
        }
        "device.interconnect.send" => {
            let resp = match core.mode {
                crate::CoreMode::Live => crate::live::handle_downlink(core, &id, &params),
                crate::CoreMode::Fake => fake::interconnect_send(core, &id, &params),
            };
            (resp, false)
        }
        "settings.set" => {
            core.log(&format!(
                "settings.set key={}（no-op：core 没有设置系统）",
                params["key"].as_str().unwrap_or("?")
            ));
            (
                serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string(),
                false,
            )
        }
        // 降级决策见 docs/protocol/rpc-contract.md：客户端对 plugin.* 的调用全部包着
        // try/catch，报 method_not_found 只会让「FetchBridge 插件」显示为未安装/未运行，
        // 这是 core 无插件系统的诚实表达。
        "plugin.list" => (
            serde_json::json!({ "id": id, "ok": true, "result": [] }).to_string(),
            false,
        ),
        "plugin.open" | "plugin.close" | "device.sync.time" | "install.local" => {
            let msg = match method {
                "device.sync.time" => {
                    "禁止实现：OronBox 的 syncTime 有 +4h 硬编码 bug（fetch-bridge-direct.ts 文件头）"
                }
                _ => "pulse-core 没有插件系统",
            };
            (error_resp(&id, "method_not_found", msg).to_string(), false)
        }
        other => (
            error_resp(&id, "method_not_found", &format!("未知方法 {other}")).to_string(),
            false,
        ),
    }
}

/// endpoint 字段只是 daemon.info 的展示信息（refreshDaemonHealth 原样透传），
/// 客户端从不解析它；从端点文件读回来填，保持诚实。
fn endpoint_port(core: &Core) -> u16 {
    fs::read_to_string(core.run_dir.join("core.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["port"].as_u64())
        .map(|p| p as u16)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn create_test_core(mode: crate::CoreMode) -> Arc<Core> {
        Arc::new(Core {
            mode,
            token: "test_token".to_string(),
            run_dir: PathBuf::from("target/test_run_dir"),
            started: Instant::now(),
            clients: Mutex::new(Vec::new()),
            device: Mutex::new(crate::fake::FakeDevice::new()),
            bt: Mutex::new(None),
            shutdown_requested: std::sync::atomic::AtomicBool::new(false),
            desired_connected: std::sync::atomic::AtomicBool::new(false),
            live_state: Mutex::new(crate::live::LiveStatus::Disconnected),
        })
    }

    #[test]
    fn test_rpc_mode_dispatch_live_vs_fake() {
        let live_core = create_test_core(crate::CoreMode::Live);
        let fake_core = create_test_core(crate::CoreMode::Fake);

        // 1. device.status: 处于 Disconnected 时，--live 绝不调用 fake::device_status
        let live_status_req = serde_json::json!({
            "id": "s1", "method": "device.status", "token": "test_token"
        })
        .to_string();
        let (resp_live, _) = dispatch(&live_core, &live_status_req);
        let v_live: serde_json::Value = serde_json::from_str(&resp_live).unwrap();
        assert_eq!(v_live["result"]["connected"], false);
        assert_eq!(v_live["result"]["protocolState"], "disconnected");
        assert!(v_live["result"]["device"].is_null());

        // 2. device.connect: --live 设置 desired_connected=true
        let live_conn_req = serde_json::json!({
            "id": "c1", "method": "device.connect", "token": "test_token"
        })
        .to_string();
        let (resp_c, _) = dispatch(&live_core, &live_conn_req);
        let v_c: serde_json::Value = serde_json::from_str(&resp_c).unwrap();
        assert_eq!(v_c["ok"], true);
        assert_eq!(
            live_core
                .desired_connected
                .load(std::sync::atomic::Ordering::SeqCst),
            true
        );

        // 3. device.disconnect: --live 设置 desired_connected=false
        let live_disconn_req = serde_json::json!({
            "id": "d1", "method": "device.disconnect", "token": "test_token"
        })
        .to_string();
        let (resp_d, _) = dispatch(&live_core, &live_disconn_req);
        let v_d: serde_json::Value = serde_json::from_str(&resp_d).unwrap();
        assert_eq!(v_d["ok"], true);
        assert_eq!(
            live_core
                .desired_connected
                .load(std::sync::atomic::Ordering::SeqCst),
            false
        );

        // 4. device.interconnect.send: --live 在未建链时由 live handler 拦截返回 not_live
        let send_req = serde_json::json!({
            "id": "tx1", "method": "device.interconnect.send",
            "params": { "package": "com.codeisland.band", "payload": [1, 2, 3] },
            "token": "test_token"
        })
        .to_string();
        let (resp_send_live, _) = dispatch(&live_core, &send_req);
        let v_send_live: serde_json::Value = serde_json::from_str(&resp_send_live).unwrap();
        assert_eq!(v_send_live["ok"], false);
        assert_eq!(v_send_live["error"]["code"], "not_live");

        // 而在 --fake 下，走 fake::interconnect_send，不返回 not_live
        let (resp_send_fake, _) = dispatch(&fake_core, &send_req);
        let v_send_fake: serde_json::Value = serde_json::from_str(&resp_send_fake).unwrap();
        assert_ne!(v_send_fake["error"]["code"].as_str(), Some("not_live"));
    }
}
