//! pulse-core —— Pulse Dev 的设备守护进程（阶段 1：RPC 契约层 + 假设备）。
//!
//! 职责（见 future_version/2026-09-08-pulse-v2-native-core.md §1.2/§1.3/§1.4）：
//! - 监听 127.0.0.1:0（动态端口），行分隔 JSON 的 RPC，token 校验
//! - 把端点写进 %LOCALAPPDATA%\PulseDev\run\core.json（port/token/pid/protocolVersion）
//! - `--fake` 模式：假设备（device.connect/status/disconnect）+ 假手环
//!   （主动发 `__hs__` 握手和 fetch 请求事件，接住客户端的应答并断言）
//!
//! 阶段 1 只有 --fake 是真的；不带 --fake 启动直接报错退出，
//! 因为蓝牙层（阶段 2~4 的证据）还不存在，假装能连真设备比明确拒绝更危险。

use std::fs;
use std::io::Write as _;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod fake;
mod rpc;
pub mod crc;
pub mod frame;

use fake::FakeDevice;
use rpc::ClientHandle;

/// 客户端严格校验 daemon.info 返回值里的 protocolVersion（oronbox-client.ts 的
/// checkProtocolVersion），不是端点文件里这个。两处都写 6，但只有返回值才算数。
pub const PROTOCOL_VERSION: u64 = 6;

pub struct Core {
    pub token: String,
    pub run_dir: PathBuf,
    pub started: Instant,
    pub clients: Mutex<Vec<ClientHandle>>,
    pub device: Mutex<FakeDevice>,
}

impl Core {
    /// 给所有连着的 RPC 客户端广播一条事件行。
    pub fn broadcast(&self, event: &str, fields: serde_json::Value) {
        let line = {
            let mut obj = serde_json::json!({ "messageType": "event", "event": event });
            if let (Some(dst), Some(src)) = (obj.as_object_mut(), fields.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            obj.to_string()
        };
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|c| c.send_line(&line));
    }

    pub fn log(&self, msg: &str) {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        eprintln!("[pulse-core {ts}] {msg}");
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.run_dir.join("core.log"))
            .and_then(|mut f| writeln!(f, "[pulse-core {ts}] {msg}"));
    }
}

fn run_dir() -> Result<PathBuf, String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA 环境变量不存在".to_string())?;
    let dir = PathBuf::from(base).join("PulseDev").join("run");
    fs::create_dir_all(&dir).map_err(|e| format!("创建运行目录失败 {dir:?}: {e}"))?;
    Ok(dir)
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 已有另一个活的 pulse-core 在跑就直接退出，避免两个 core 抢同一个端点文件。
/// 用协议握手探测（daemon.info + token），比猜 pid 是否被复用可靠。
fn already_running(run_dir: &PathBuf) -> bool {
    let Ok(raw) = fs::read_to_string(run_dir.join("core.json")) else {
        return false;
    };
    let Ok(ep) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let (Some(port), Some(token)) = (
        ep["port"].as_u64(),
        ep["token"].as_str().map(str::to_string),
    ) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("loopback addr"),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let probe = serde_json::json!({
        "id": "probe", "method": "daemon.info", "params": {}, "token": token
    });
    let mut line = String::new();
    use std::io::BufRead as _;
    if stream.write_all(probe.to_string().as_bytes()).is_err()
        || std::io::BufReader::new(stream).read_line(&mut line).is_err()
    {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&line)
        .ok()
        .and_then(|v| v["ok"].as_bool())
        .unwrap_or(false)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|a| a == "--fake") {
        eprintln!("pulse-core: 真设备模式尚未实现（蓝牙层要等阶段 2~4 的抓包证据），请用 --fake 启动");
        std::process::exit(2);
    }

    let run_dir = match run_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("pulse-core: {e}");
            std::process::exit(2);
        }
    };
    if already_running(&run_dir) {
        eprintln!("pulse-core: 已有实例在运行（core.json 的端点可达），退出");
        std::process::exit(0);
    }

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("pulse-core: 监听回环端口失败: {e}");
            std::process::exit(2);
        }
    };
    let port = listener.local_addr().expect("local addr").port();
    let core = Arc::new(Core {
        token: random_token(),
        run_dir: run_dir.clone(),
        started: Instant::now(),
        clients: Mutex::new(Vec::new()),
        device: Mutex::new(FakeDevice::new()),
    });

    let endpoint = serde_json::json!({
        "port": port,
        "token": core.token,
        "pid": std::process::id(),
        "protocolVersion": PROTOCOL_VERSION,
    });
    if let Err(e) = fs::write(run_dir.join("core.json"), endpoint.to_string()) {
        eprintln!("pulse-core: 写端点文件失败: {e}");
        std::process::exit(2);
    }

    core.log(&format!(
        "started --fake pid={} port={port} token={}…(截断) endpoint={}",
        std::process::id(),
        &core.token[..6],
        run_dir.join("core.json").display()
    ));

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let core = Arc::clone(&core);
        std::thread::spawn(move || rpc::serve(core, stream));
    }
}
