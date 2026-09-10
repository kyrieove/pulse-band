//! 快应用安装传输契约与底层设备适配层 (App Install Transport & Device Adapters)

use std::collections::VecDeque;
use std::sync::Mutex;
use crate::frame::Frame;
use super::model::{ChunkAck, InstallChunk, InstallMetadata, InstallResult, InstallSession, Result, TransportMode};
use super::protocol::AppInstallProtocol;

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

/// Mock 传输实现（供 RPC 契约与单元测试链路验证）
#[derive(Debug, Default)]
pub struct MockAppInstallTransport {
    pub active_session: Option<InstallSession>,
    pub received_chunks_count: u32,
    pub total_received_bytes: u64,
}

#[allow(dead_code)]
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

/// 手环底层设备通信抽象 Trait
///
/// 职责：
/// - connect: 建立底层传输连接
/// - disconnect: 断开底层连接
/// - is_connected: 链路状态检测
/// - send_frame: 发送单个基础数据帧
/// - receive_frame: 接收单个基础数据帧（带超时机制）
///
/// 纪律要求：
/// - 禁止包含小米快应用安装业务协议实现
/// - 禁止修改现有 RFCOMM / session 状态机
/// - 禁止发送真实安装数据
#[allow(dead_code)]
pub trait BandDeviceTransport: std::fmt::Debug + Send + Sync {
    fn connect(&mut self, target_addr: &str) -> Result<()>;
    fn disconnect(&mut self) -> Result<()>;
    fn is_connected(&self) -> bool;
    fn send_frame(&mut self, frame: &Frame) -> Result<()>;
    fn receive_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>>;
}

/// 用于测试与离线模拟的手环底层通信 Mock 实现
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockBandDeviceTransport {
    pub connected: bool,
    pub target_addr: Option<String>,
    pub sent_frames: Vec<Frame>,
    pub incoming_queue: VecDeque<Frame>,
}

#[allow(dead_code)]
impl MockBandDeviceTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue_incoming(&mut self, frame: Frame) {
        self.incoming_queue.push_back(frame);
    }
}

impl BandDeviceTransport for MockBandDeviceTransport {
    fn connect(&mut self, target_addr: &str) -> Result<()> {
        self.connected = true;
        self.target_addr = Some(target_addr.to_string());
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        self.connected = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        if !self.connected {
            return Err("device_not_connected: 底层设备未连接".to_string());
        }
        self.sent_frames.push(frame.clone());
        Ok(())
    }

    fn receive_frame(&mut self, _timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.connected {
            return Err("device_not_connected: 底层设备未连接".to_string());
        }
        Ok(self.incoming_queue.pop_front())
    }
}

/// 小米手环 10 快应用原生安装传输适配层（内部依赖 AppInstallProtocol 与 BandDeviceTransport 抽象）
///
/// 分层结构：
/// XiaomiBand10Transport
///   ↓
/// AppInstallProtocol
///   ↓
/// BandDeviceTransport
///
/// 纪律要求：
/// - 只能作为设备适配占位层
/// - 禁止直接调用 RFCOMM
/// - 禁止直接调用 BLE
/// - 禁止修改 live.rs / session.rs
/// - 严禁发送真实数据
/// - 无真实设备或未接入安装协议时安全失败（返回 device_unavailable / not_implemented）
/// - 禁止返回 completed / installed
#[derive(Debug, Default)]
pub struct XiaomiBand10Transport {
    pub active_session_id: Option<String>,
    pub protocol: Option<Box<dyn AppInstallProtocol>>,
    pub device_transport: Option<Box<dyn BandDeviceTransport>>,
}

#[allow(dead_code)]
impl XiaomiBand10Transport {
    pub fn new() -> Self {
        Self {
            active_session_id: None,
            protocol: None,
            device_transport: None,
        }
    }

    pub fn with_device_transport(transport: Box<dyn BandDeviceTransport>) -> Self {
        Self {
            active_session_id: None,
            protocol: None,
            device_transport: Some(transport),
        }
    }

    pub fn with_protocol_and_device(
        protocol: Box<dyn AppInstallProtocol>,
        transport: Box<dyn BandDeviceTransport>,
    ) -> Self {
        Self {
            active_session_id: None,
            protocol: Some(protocol),
            device_transport: Some(transport),
        }
    }

    pub fn set_protocol(&mut self, protocol: Box<dyn AppInstallProtocol>) {
        self.protocol = Some(protocol);
    }

    pub fn set_device_transport(&mut self, transport: Box<dyn BandDeviceTransport>) {
        self.device_transport = Some(transport);
    }

    pub fn protocol(&self) -> Option<&dyn AppInstallProtocol> {
        self.protocol.as_deref()
    }

    pub fn device_transport(&self) -> Option<&dyn BandDeviceTransport> {
        self.device_transport.as_deref()
    }

    pub fn device_transport_mut(&mut self) -> Option<&mut (dyn BandDeviceTransport + 'static)> {
        self.device_transport.as_deref_mut()
    }
}

impl AppInstallTransport for XiaomiBand10Transport {
    fn prepare(&mut self, metadata: InstallMetadata) -> Result<InstallSession> {
        let dt = match self.device_transport.as_mut() {
            Some(dt) => dt,
            None => {
                return Err(
                    "device_unavailable: 小米手环10底层设备通信未接入 (not_implemented)".to_string(),
                )
            }
        };
        if !dt.is_connected() {
            return Err("device_unavailable: 小米手环10底层设备未连接 (not_implemented)".to_string());
        }
        let proto = match self.protocol.as_mut() {
            Some(p) => p,
            None => {
                return Err(
                    "device_unavailable: 小米手环10快应用安装协议尚未实现 (not_implemented)".to_string(),
                )
            }
        };
        let session = proto.prepare_install(dt.as_mut(), &metadata)?;
        self.active_session_id = Some(session.session_id.clone());
        Ok(session)
    }

    fn send_chunk(&mut self, chunk: InstallChunk) -> Result<ChunkAck> {
        let dt = match self.device_transport.as_mut() {
            Some(dt) => dt,
            None => {
                return Err(
                    "device_unavailable: 小米手环10底层设备通信未接入 (not_implemented)".to_string(),
                )
            }
        };
        if !dt.is_connected() {
            return Err("device_unavailable: 小米手环10底层设备未连接 (not_implemented)".to_string());
        }
        let proto = match self.protocol.as_mut() {
            Some(p) => p,
            None => {
                return Err(
                    "device_unavailable: 小米手环10硬件传输层尚未接入 (not_implemented)".to_string(),
                )
            }
        };
        proto.send_package_chunk(dt.as_mut(), &chunk)
    }

    fn commit(&mut self, session_id: String) -> Result<InstallResult> {
        let dt = match self.device_transport.as_mut() {
            Some(dt) => dt,
            None => {
                return Err(
                    "device_unavailable: 小米手环10底层设备通信未接入 (not_implemented)".to_string(),
                )
            }
        };
        if !dt.is_connected() {
            return Err("device_unavailable: 小米手环10底层设备未连接 (not_implemented)".to_string());
        }
        let proto = match self.protocol.as_mut() {
            Some(p) => p,
            None => {
                return Err(
                    "device_unavailable: 小米手环10硬件传输层尚未接入 (not_implemented)".to_string(),
                )
            }
        };
        proto.verify_package(dt.as_mut(), &session_id)?;
        proto.commit_install(dt.as_mut(), &session_id)
    }

    fn cancel(&mut self, session_id: String) -> Result<()> {
        self.active_session_id = None;
        if let (Some(proto), Some(dt)) = (self.protocol.as_mut(), self.device_transport.as_mut()) {
            let _ = proto.cancel_install(dt.as_mut(), &session_id);
        }
        if let Some(dt) = self.device_transport.as_mut() {
            let _ = dt.disconnect();
        }
        Ok(())
    }
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

    pub fn new_device() -> Self {
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
