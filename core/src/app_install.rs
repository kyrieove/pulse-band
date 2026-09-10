//! 快应用安装协议契约与传输抽象层 (App Install Transport Abstraction)
//!
//! 纪律要求：
//! - trait 只定义抽象接口
//! - 禁止蓝牙通信实现
//! - 禁止真实手环连接或修改设备协议
//! - 阶段状态仅允许 preparing / transferring / verifying / cancelled，禁止 completed 伪状态

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

/// 快应用安装传输抽象 Trait
pub trait AppInstallTransport {
    fn prepare(
        &mut self,
        metadata: InstallMetadata,
    ) -> Result<InstallSession>;

    fn send_chunk(
        &mut self,
        chunk: InstallChunk,
    ) -> Result<ChunkAck>;

    fn commit(
        &mut self,
        session_id: String,
    ) -> Result<InstallResult>;

    fn cancel(
        &mut self,
        session_id: String,
    ) -> Result<()>;
}

/// 快应用安装包元数据契约
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallMetadata {
    #[serde(alias = "packageId")]
    pub package_id: String,
    #[serde(alias = "versionName")]
    pub version_name: String,
    #[serde(alias = "versionCode")]
    pub version_code: u32,
    #[serde(alias = "fileSize")]
    pub file_size: u64,
    pub hash: String,
}

/// 快应用安装分块数据契约
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallChunk {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub index: u32,
    pub size: u32,
    #[serde(default)]
    pub data: Vec<u8>,
}

/// 分块接收应答
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkAck {
    pub session_id: String,
    pub index: u32,
    pub received_bytes: u64,
}

/// 快应用安装会话结构体
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSession {
    pub session_id: String,
    pub status: String,
    pub file_size: u64,
    pub chunk_size: u32,
    pub total_chunks: u32,
}

/// 快应用提交结果契约
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub status: String,
}

/// Mock 传输实现（供 RPC 契约与单元测试链路验证）
#[derive(Debug, Default)]
pub struct MockAppInstallTransport {
    pub active_session: Option<InstallSession>,
    pub received_chunks_count: u32,
    pub total_received_bytes: u64,
}

impl MockAppInstallTransport {
    pub const fn new() -> Self {
        Self {
            active_session: None,
            received_chunks_count: 0,
            total_received_bytes: 0,
        }
    }
}

impl AppInstallTransport for MockAppInstallTransport {
    fn prepare(&mut self, metadata: InstallMetadata) -> Result<InstallSession> {
        if metadata.file_size == 0 {
            return Err("file_size 必须大于 0".to_string());
        }
        let chunk_size = 512u32;
        let total_chunks = ((metadata.file_size + chunk_size as u64 - 1) / chunk_size as u64) as u32;
        let session_id = format!("inst_{}_{}", metadata.package_id, metadata.version_code);

        let session = InstallSession {
            session_id,
            status: "preparing".to_string(),
            file_size: metadata.file_size,
            chunk_size,
            total_chunks,
        };

        self.active_session = Some(session.clone());
        self.received_chunks_count = 0;
        self.total_received_bytes = 0;

        Ok(session)
    }

    fn send_chunk(&mut self, chunk: InstallChunk) -> Result<ChunkAck> {
        let session = match &self.active_session {
            Some(s) => s,
            None => return Err("未找到活跃的安装会话".to_string()),
        };

        if session.session_id != chunk.session_id {
            return Err("session_id 不匹配".to_string());
        }

        self.received_chunks_count += 1;
        self.total_received_bytes += chunk.size as u64;

        Ok(ChunkAck {
            session_id: chunk.session_id,
            index: chunk.index,
            received_bytes: self.total_received_bytes,
        })
    }

    fn commit(&mut self, session_id: String) -> Result<InstallResult> {
        let session = match &self.active_session {
            Some(s) => s,
            None => return Err("未找到活跃的安装会话".to_string()),
        };

        if session.session_id != session_id {
            return Err("session_id 不匹配".to_string());
        }

        // 阶段约束：返回 verifying，严禁返回 completed 或 installed
        Ok(InstallResult {
            status: "verifying".to_string(),
        })
    }

    fn cancel(&mut self, session_id: String) -> Result<()> {
        if let Some(session) = &self.active_session {
            if session.session_id == session_id {
                self.active_session = None;
                self.received_chunks_count = 0;
                self.total_received_bytes = 0;
                return Ok(());
            }
        }
        self.active_session = None;
        self.received_chunks_count = 0;
        self.total_received_bytes = 0;
        Ok(())
    }
}

/// 小米手环 10 快应用原生安装传输适配层（占位骨架，未接入真实硬件）
///
/// 纪律要求：
/// - 只能作为设备适配占位层
/// - 禁止 RFCOMM 调用
/// - 禁止 BLE 调用
/// - 禁止修改 live.rs / session.rs
/// - 严禁发送真实数据
/// - 返回 device_unavailable / not_implemented
/// - 禁止返回 completed / installed
#[derive(Debug, Default)]
pub struct XiaomiBand10Transport {
    pub active_session_id: Option<String>,
}

impl XiaomiBand10Transport {
    pub const fn new() -> Self {
        Self {
            active_session_id: None,
        }
    }
}

impl AppInstallTransport for XiaomiBand10Transport {
    fn prepare(&mut self, _metadata: InstallMetadata) -> Result<InstallSession> {
        Err("device_unavailable: 小米手环10硬件传输层尚未接入 (not_implemented)".to_string())
    }

    fn send_chunk(&mut self, _chunk: InstallChunk) -> Result<ChunkAck> {
        Err("device_unavailable: 小米手环10硬件传输层尚未接入 (not_implemented)".to_string())
    }

    fn commit(&mut self, _session_id: String) -> Result<InstallResult> {
        Err("device_unavailable: 小米手环10硬件传输层尚未接入 (not_implemented)".to_string())
    }

    fn cancel(&mut self, _session_id: String) -> Result<()> {
        self.active_session_id = None;
        Ok(())
    }
}

/// 快应用传输层运行模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    Mock,
    Device,
}

/// 传输后端枚举分发器（支持 Mock 与 Device 双模式切换）
#[derive(Debug)]
pub enum InstallTransportDispatcher {
    Mock(MockAppInstallTransport),
    Device(XiaomiBand10Transport),
}

impl InstallTransportDispatcher {
    pub const fn new_mock() -> Self {
        Self::Mock(MockAppInstallTransport::new())
    }

    pub const fn new_device() -> Self {
        Self::Device(XiaomiBand10Transport::new())
    }

    pub fn set_mode(&mut self, mode: TransportMode) {
        match mode {
            TransportMode::Mock => {
                if !matches!(self, Self::Mock(_)) {
                    *self = Self::Mock(MockAppInstallTransport::new());
                }
            }
            TransportMode::Device => {
                if !matches!(self, Self::Device(_)) {
                    *self = Self::Device(XiaomiBand10Transport::new());
                }
            }
        }
    }

    pub fn mode(&self) -> TransportMode {
        match self {
            Self::Mock(_) => TransportMode::Mock,
            Self::Device(_) => TransportMode::Device,
        }
    }
}

impl AppInstallTransport for InstallTransportDispatcher {
    fn prepare(&mut self, metadata: InstallMetadata) -> Result<InstallSession> {
        match self {
            Self::Mock(t) => t.prepare(metadata),
            Self::Device(t) => t.prepare(metadata),
        }
    }

    fn send_chunk(&mut self, chunk: InstallChunk) -> Result<ChunkAck> {
        match self {
            Self::Mock(t) => t.send_chunk(chunk),
            Self::Device(t) => t.send_chunk(chunk),
        }
    }

    fn commit(&mut self, session_id: String) -> Result<InstallResult> {
        match self {
            Self::Mock(t) => t.commit(session_id),
            Self::Device(t) => t.commit(session_id),
        }
    }

    fn cancel(&mut self, session_id: String) -> Result<()> {
        match self {
            Self::Mock(t) => t.cancel(session_id),
            Self::Device(t) => t.cancel(session_id),
        }
    }
}

/// 全局可切换传输实例（受互斥锁保护，默认 Mock 模式）
#[allow(dead_code)]
pub static GLOBAL_INSTALL_TRANSPORT: Mutex<InstallTransportDispatcher> =
    Mutex::new(InstallTransportDispatcher::new_mock());

/// 切换全局快应用传输后端模式
#[allow(dead_code)]
pub fn set_global_transport_mode(mode: TransportMode) {
    let mut transport = GLOBAL_INSTALL_TRANSPORT.lock().unwrap();
    transport.set_mode(mode);
}

/// 获取当前全局快应用传输后端模式
#[allow(dead_code)]
pub fn get_global_transport_mode() -> TransportMode {
    let transport = GLOBAL_INSTALL_TRANSPORT.lock().unwrap();
    transport.mode()
}
