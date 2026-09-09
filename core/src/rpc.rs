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
        let Ok(mut w) = self.writer.lock() else { return false };
        writeln!(w, "{line}").is_ok() && w.flush().is_ok()
    }
}

pub fn serve(core: Arc<Core>, stream: TcpStream) {
    let Ok(writer) = stream.try_clone() else { return };
    let id = next_client_id();
    let handle = ClientHandle { id, writer: Arc::new(Mutex::new(writer)) };
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
            // 先对这条连接发 FIN（数据已 write+flush），客户端就能读到响应而不是吃 RST
            if let Ok(w) = handle.writer.lock() {
                let _ = w.shutdown(std::net::Shutdown::Both);
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
        return (error_resp(&id, "unauthorized", "token 不匹配").to_string(), false);
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
            (serde_json::json!({ "id": id, "ok": true, "result": result }).to_string(), false)
        }
        "daemon.stop" => (serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string(), true),
        "device.connect" => (fake::device_connect(core, &id), false),
        "device.disconnect" => (fake::device_disconnect(core, &id), false),
        "device.status" => (fake::device_status(core, &id), false),
        "device.interconnect.send" => {
            // 真机数据泵模式下，把客户端回传的 content 构造为下行 id=8 帧发回手环；
            // 否则走 --fake 假手环的自证逻辑。
            let resp = if core.bt.lock().unwrap().is_some() {
                crate::live::handle_downlink(core, &id, &params)
            } else {
                fake::interconnect_send(core, &id, &params)
            };
            (resp, false)
        }
        "settings.set" => {
            core.log(&format!(
                "settings.set key={}（no-op：core 没有设置系统）",
                params["key"].as_str().unwrap_or("?")
            ));
            (serde_json::json!({ "id": id, "ok": true, "result": {} }).to_string(), false)
        }
        // 降级决策见 docs/protocol/rpc-contract.md：客户端对 plugin.* 的调用全部包着
        // try/catch，报 method_not_found 只会让「FetchBridge 插件」显示为未安装/未运行，
        // 这是 core 无插件系统的诚实表达。
        "plugin.list" => (serde_json::json!({ "id": id, "ok": true, "result": [] }).to_string(), false),
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
