//! 快应用安装协议契约与传输抽象层 (App Install Transport Abstraction)
//!
//! 纪律要求：
//! - trait 只定义抽象接口
//! - 禁止蓝牙通信实现
//! - 禁止真实手环连接或修改设备协议
//! - 阶段状态仅允许 preparing / transferring / verifying / cancelled，禁止 completed 伪状态

use std::collections::VecDeque;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

use crate::frame::Frame;

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

/// 快应用安装业务协议抽象 Trait
///
/// 职责：
/// - prepare_install: 发起安装会话协商
/// - send_package_chunk: 传输安装包分片
/// - verify_package: 安装包校验（如哈希校验/验签）
/// - commit_install: 确认提交安装
/// - cancel_install: 中止/取消安装
///
/// 纪律要求：
/// - 纯业务协议接口，不硬编码具体小米私有命令号与未知 opcode
/// - 严禁修改 live.rs 与 session.rs
/// - 严禁发送真实安装数据
#[allow(dead_code)]
pub trait AppInstallProtocol: std::fmt::Debug + Send + Sync {
    fn prepare_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        metadata: &InstallMetadata,
    ) -> Result<InstallSession>;

    fn send_package_chunk(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        chunk: &InstallChunk,
    ) -> Result<ChunkAck>;

    fn verify_package(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<()>;

    fn commit_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult>;

    fn cancel_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<()>;
}

/// 用于模拟快应用安装业务协议状态机的 Mock 实现
///
/// 状态纪律：
/// - 只能返回 preparing / transferring / verifying
/// - 严禁返回 completed 或 installed 假成功状态
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockAppInstallProtocol {
    pub active_session: Option<InstallSession>,
    pub received_chunks: u32,
    pub total_received_bytes: u64,
    pub verified: bool,
}

#[allow(dead_code)]
impl MockAppInstallProtocol {
    pub fn new() -> Self {
        Self::default()
    }
}

impl AppInstallProtocol for MockAppInstallProtocol {
    fn prepare_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        metadata: &InstallMetadata,
    ) -> Result<InstallSession> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 底层设备未连接 (not_implemented)".to_string());
        }
        let session_id = format!("proto_sess_{}", metadata.version_code);
        let total_chunks = ((metadata.file_size + 511) / 512) as u32;
        let session = InstallSession {
            session_id,
            status: "preparing".to_string(), // 仅允许 preparing
            file_size: metadata.file_size,
            chunk_size: 512,
            total_chunks,
        };
        self.active_session = Some(session.clone());
        self.received_chunks = 0;
        self.total_received_bytes = 0;
        self.verified = false;
        Ok(session)
    }

    fn send_package_chunk(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        chunk: &InstallChunk,
    ) -> Result<ChunkAck> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 底层设备未连接 (not_implemented)".to_string());
        }
        if self.active_session.is_none() {
            return Err("未找到活跃安装会话".to_string());
        }
        self.received_chunks += 1;
        self.total_received_bytes += chunk.size as u64;
        Ok(ChunkAck {
            session_id: chunk.session_id.clone(),
            index: chunk.index,
            received_bytes: self.total_received_bytes,
        })
    }

    fn verify_package(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<()> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 底层设备未连接 (not_implemented)".to_string());
        }
        let session = self.active_session.as_ref().ok_or("未找到活跃会话")?;
        if session.session_id != session_id {
            return Err("session_id 不匹配".to_string());
        }
        self.verified = true;
        Ok(())
    }

    fn commit_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 底层设备未连接 (not_implemented)".to_string());
        }
        let session = self.active_session.as_ref().ok_or("未找到活跃会话")?;
        if session.session_id != session_id {
            return Err("session_id 不匹配".to_string());
        }
        // 严格状态限制：只能返回 verifying，禁止 completed / installed
        Ok(InstallResult {
            status: "verifying".to_string(),
        })
    }

    fn cancel_install(
        &mut self,
        _device_transport: &mut dyn BandDeviceTransport,
        _session_id: &str,
    ) -> Result<()> {
        self.active_session = None;
        self.received_chunks = 0;
        self.total_received_bytes = 0;
        self.verified = false;
        Ok(())
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

// =========================================================================
// 阶段 15: 快应用安装协议取证与 Replay 基础设施
// =========================================================================

/// 数据包传输方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketDirection {
    HostToBand,
    BandToHost,
}

/// 录制的数据帧项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedPacket {
    pub direction: PacketDirection,
    pub timestamp_ms: u64,
    pub frame_type: u8,
    pub seq: u8,
    pub len: u16,
    pub crc: u16,
    pub payload_hex: String,
}

/// 协议录制调试层：用于捕获双向数据帧并导出日志
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct InstallProtocolRecorder {
    pub packets: Vec<RecordedPacket>,
}

#[allow(dead_code)]
impl InstallProtocolRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_tx(&mut self, frame: &Frame) {
        self.record(PacketDirection::HostToBand, frame);
    }

    pub fn record_rx(&mut self, frame: &Frame) {
        self.record(PacketDirection::BandToHost, frame);
    }

    pub fn record(&mut self, direction: PacketDirection, frame: &Frame) {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let crc = crate::crc::crc16_arc(&frame.payload);
        let payload_hex = frame
            .payload
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join("");
        self.packets.push(RecordedPacket {
            direction,
            timestamp_ms,
            frame_type: frame.frame_type,
            seq: frame.seq,
            len: frame.payload.len() as u16,
            crc,
            payload_hex,
        });
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(&self.packets)
            .map_err(|e| format!("序列化录制记录失败: {e}"))
    }

    pub fn from_json(json: &str) -> Result<Self> {
        let packets: Vec<RecordedPacket> =
            serde_json::from_str(json).map_err(|e| format!("反序列化录制记录失败: {e}"))?;
        Ok(Self { packets })
    }

    pub fn clear(&mut self) {
        self.packets.clear();
    }
}

/// 预期的下行数据帧断言契约
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedFrameAssertion {
    pub frame_type: u8,
    pub seq: Option<u8>,
    pub payload_hash: Option<String>,
}

/// 基于回放与捕获的设备传输实现
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockDeviceReplayTransport {
    pub connected: bool,
    pub target_addr: Option<String>,
    pub rx_replay_queue: VecDeque<Frame>,
    pub tx_sent_frames: Vec<Frame>,
    pub expected_tx_frames: VecDeque<Frame>,
    pub expected_assertions: Vec<ExpectedFrameAssertion>,
    pub recorder: Option<InstallProtocolRecorder>,
}

#[allow(dead_code)]
impl MockDeviceReplayTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_recorder(recorder: InstallProtocolRecorder) -> Self {
        Self {
            connected: false,
            target_addr: None,
            rx_replay_queue: VecDeque::new(),
            tx_sent_frames: Vec::new(),
            expected_tx_frames: VecDeque::new(),
            expected_assertions: Vec::new(),
            recorder: Some(recorder),
        }
    }

    /// 设定预期的发送帧断言（用于验证发送顺序、frame_type 与 payload hash）
    pub fn expect_frame(
        &mut self,
        frame_type: u8,
        seq: Option<u8>,
        payload_hash: Option<&str>,
    ) {
        self.expected_assertions.push(ExpectedFrameAssertion {
            frame_type,
            seq,
            payload_hash: payload_hash.map(|s| s.to_string()),
        });
    }

    /// 验证实际发送的帧是否完全满足预期的顺序、类型与哈希契约
    pub fn verify_expected_frames(&self) -> Result<()> {
        if self.tx_sent_frames.len() != self.expected_assertions.len() {
            return Err(format!(
                "断言失败: 发送帧总数不匹配: 期望 {} 帧，实际发送 {} 帧",
                self.expected_assertions.len(),
                self.tx_sent_frames.len()
            ));
        }

        for (i, (expected, actual)) in self
            .expected_assertions
            .iter()
            .zip(self.tx_sent_frames.iter())
            .enumerate()
        {
            if actual.frame_type != expected.frame_type {
                return Err(format!(
                    "断言失败: 第 {i} 帧 frame_type 不匹配: 期望 0x{:02x}，实际 0x{:02x}",
                    expected.frame_type, actual.frame_type
                ));
            }
            if let Some(exp_seq) = expected.seq {
                if actual.seq != exp_seq {
                    return Err(format!(
                        "断言失败: 第 {i} 帧 seq 不匹配: 期望 {}，实际 {}",
                        exp_seq, actual.seq
                    ));
                }
            }
            if let Some(exp_hash) = &expected.payload_hash {
                let actual_hash = compute_payload_sha256(&actual.payload);
                if &actual_hash != exp_hash {
                    return Err(format!(
                        "断言失败: 第 {i} 帧 payload hash 不匹配: 期望 {}，实际 {}",
                        exp_hash, actual_hash
                    ));
                }
            }
        }
        Ok(())
    }

    /// 从录制器中加载回放流（筛选手环发往主机的数据帧作为 rx 队列）
    pub fn load_from_recorder(&mut self, recorder: &InstallProtocolRecorder) {
        for p in &recorder.packets {
            if p.direction == PacketDirection::BandToHost {
                if let Ok(payload) = hex_to_bytes(&p.payload_hex) {
                    self.rx_replay_queue.push_back(Frame {
                        frame_type: p.frame_type,
                        seq: p.seq,
                        payload,
                    });
                }
            }
        }
    }

    /// 从录制器中加载期望的下发流（筛选主机发往手环的数据帧作为 tx 预期断言队列）
    pub fn load_expected_tx(&mut self, recorder: &InstallProtocolRecorder) {
        for p in &recorder.packets {
            if p.direction == PacketDirection::HostToBand {
                if let Ok(payload) = hex_to_bytes(&p.payload_hex) {
                    self.expected_tx_frames.push_back(Frame {
                        frame_type: p.frame_type,
                        seq: p.seq,
                        payload,
                    });
                }
            }
        }
    }

    pub fn queue_rx_frame(&mut self, frame: Frame) {
        self.rx_replay_queue.push_back(frame);
    }
}

impl BandDeviceTransport for MockDeviceReplayTransport {
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
        if let Some(recorder) = self.recorder.as_mut() {
            recorder.record_tx(frame);
        }
        self.tx_sent_frames.push(frame.clone());
        Ok(())
    }

    fn receive_frame(&mut self, _timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.connected {
            return Err("device_not_connected: 底层设备未连接".to_string());
        }
        if let Some(frame) = self.rx_replay_queue.pop_front() {
            if let Some(recorder) = self.recorder.as_mut() {
                recorder.record_rx(&frame);
            }
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }
}

/// 协议分析输出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameInspection {
    pub magic_valid: bool,
    pub frame_type: u8,
    pub frame_type_desc: String,
    pub seq: u8,
    pub payload_len: usize,
    pub payload_hex: String,
    pub crc_expected: u16,
    pub crc_actual: u16,
    pub crc_valid: bool,
    pub protobuf_attempt: ProtobufInspection,
}

/// Protobuf 解析尝试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtobufInspection {
    pub success: bool,
    pub fields_count: usize,
    pub field_tags: Vec<u32>,
    pub note: String,
}

/// 协议分析工具：用于对捕获的原始字节与数据帧进行结构解析与有效性审计
#[allow(dead_code)]
pub struct ProtocolInspector;

#[allow(dead_code)]
impl ProtocolInspector {
    /// 分析已解析的 Frame 结构体
    pub fn inspect_frame(frame: &Frame) -> FrameInspection {
        let crc_actual = crate::crc::crc16_arc(&frame.payload);
        let payload_hex = frame
            .payload
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join("");
        let frame_type_desc = match frame.frame_type {
            0x01 => "ACK".to_string(),
            0x02 => "Negotiation".to_string(),
            0x03 => "Business/Auth".to_string(),
            other => format!("Unknown(0x{other:02x})"),
        };
        let protobuf_attempt = Self::try_inspect_protobuf(&frame.payload);

        FrameInspection {
            magic_valid: true,
            frame_type: frame.frame_type,
            frame_type_desc,
            seq: frame.seq,
            payload_len: frame.payload.len(),
            payload_hex,
            crc_expected: crc_actual,
            crc_actual,
            crc_valid: true,
            protobuf_attempt,
        }
    }

    /// 分析原始二进制字节流（包含 Magic 字节与 CRC 头部校验）
    pub fn inspect_raw_bytes(bytes: &[u8]) -> Result<FrameInspection> {
        if bytes.len() < 8 {
            return Err("数据长度不足 8 字节最小帧头".to_string());
        }
        let magic_valid = bytes[0] == 0xA5 && bytes[1] == 0xA5;
        if !magic_valid {
            return Err(format!(
                "Magic 无效: 0x{:02x}{:02x} (期望 0xa5a5)",
                bytes[0], bytes[1]
            ));
        }
        let frame_type = bytes[2];
        let seq = bytes[3];
        let len = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        let crc_expected = u16::from_le_bytes([bytes[6], bytes[7]]);

        if bytes.len() < 8 + len {
            return Err(format!("帧载荷截断: 期望 {len} 字节，实际剩余 {} 字节", bytes.len() - 8));
        }

        let payload = &bytes[8..8 + len];
        let crc_actual = crate::crc::crc16_arc(payload);
        let crc_valid = crc_actual == crc_expected;

        let frame = Frame {
            frame_type,
            seq,
            payload: payload.to_vec(),
        };

        let mut inspection = Self::inspect_frame(&frame);
        inspection.crc_expected = crc_expected;
        inspection.crc_actual = crc_actual;
        inspection.crc_valid = crc_valid;
        Ok(inspection)
    }

    /// 尝试按 Protobuf wire format 进行格式探测
    pub fn try_inspect_protobuf(payload: &[u8]) -> ProtobufInspection {
        if payload.is_empty() {
            return ProtobufInspection {
                success: false,
                fields_count: 0,
                field_tags: Vec::new(),
                note: "载荷为空".to_string(),
            };
        }

        let mut offset = 0;
        let mut field_tags = Vec::new();

        while offset < payload.len() {
            // 读取 key varint
            let (key, bytes_read) = match read_varint(&payload[offset..]) {
                Some(res) => res,
                None => {
                    return ProtobufInspection {
                        success: false,
                        fields_count: field_tags.len(),
                        field_tags,
                        note: "读取 Key Varint 失败或截断".to_string(),
                    }
                }
            };
            offset += bytes_read;

            let wire_type = (key & 0x07) as u8;
            let field_number = (key >> 3) as u32;

            if field_number == 0 {
                return ProtobufInspection {
                    success: false,
                    fields_count: field_tags.len(),
                    field_tags,
                    note: "非法 Protobuf 字段序号 0".to_string(),
                };
            }

            field_tags.push(field_number);

            match wire_type {
                0 => {
                    // Varint
                    match read_varint(&payload[offset..]) {
                        Some((_, v_read)) => offset += v_read,
                        None => {
                            return ProtobufInspection {
                                success: false,
                                fields_count: field_tags.len(),
                                field_tags,
                                note: "Varint 字段截断".to_string(),
                            }
                        }
                    }
                }
                1 => {
                    // 64-bit
                    if offset + 8 > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "64-bit 字段数据不足".to_string(),
                        };
                    }
                    offset += 8;
                }
                2 => {
                    // Length-delimited
                    let (len, len_read) = match read_varint(&payload[offset..]) {
                        Some(res) => res,
                        None => {
                            return ProtobufInspection {
                                success: false,
                                fields_count: field_tags.len(),
                                field_tags,
                                note: "读取 Length-delimited 长度失败".to_string(),
                            }
                        }
                    };
                    offset += len_read;
                    let len = len as usize;
                    if offset + len > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "Length-delimited 载荷截断".to_string(),
                        };
                    }
                    offset += len;
                }
                5 => {
                    // 32-bit
                    if offset + 4 > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "32-bit 字段数据不足".to_string(),
                        };
                    }
                    offset += 4;
                }
                other => {
                    return ProtobufInspection {
                        success: false,
                        fields_count: field_tags.len(),
                        field_tags,
                        note: format!("遇到不支持或非法的 Protobuf WireType: {other}"),
                    };
                }
            }
        }

        ProtobufInspection {
            success: true,
            fields_count: field_tags.len(),
            field_tags: field_tags.clone(),
            note: format!("成功解析为有效 Protobuf Wire 格式 ({} 个字段)", field_tags.len()),
        }
    }
}

fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut val = 0u64;
    let mut shift = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if i >= 10 {
            return None; // varint 溢出
        }
        val |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Some((val, i + 1));
        }
        shift += 7;
    }
    None
}

fn hex_to_bytes(hex: &str) -> std::result::Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Hex 字符串长度必须为偶数".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|e| format!("解析 Hex 字节失败: {e}"))
        })
        .collect()
}

/// 计算载荷的 SHA-256 哈希 Hex 字符串
pub fn compute_payload_sha256(payload: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(payload);
    format!("{:x}", hasher.finalize())
}

/// 协议分析报告生成器：解析录制记录并生成结构化 Markdown 报告
#[allow(dead_code)]
pub struct ProtocolReportGenerator;

#[allow(dead_code)]
impl ProtocolReportGenerator {
    /// 从录制器 JSON 文本生成 Markdown 格式的完整协议分析报告
    pub fn generate_markdown_from_json(json_str: &str) -> Result<String> {
        let recorder = InstallProtocolRecorder::from_json(json_str)?;
        Self::generate_markdown_report(&recorder)
    }

    /// 从已有的录制器实例生成 Markdown 报告
    pub fn generate_markdown_report(recorder: &InstallProtocolRecorder) -> Result<String> {
        let mut out = String::new();

        out.push_str("# 协议取证与流量分析报告 (Protocol Capture Analysis Report)\n\n");

        let total_frames = recorder.packets.len();
        let mut host_to_band_count = 0usize;
        let mut band_to_host_count = 0usize;
        let mut type_counts: std::collections::BTreeMap<u8, usize> = std::collections::BTreeMap::new();
        let mut payload_counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        let mut total_payload_bytes = 0usize;
        let mut min_len = usize::MAX;
        let mut max_len = 0usize;
        let mut protobuf_candidates: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();

        for p in &recorder.packets {
            match p.direction {
                PacketDirection::HostToBand => host_to_band_count += 1,
                PacketDirection::BandToHost => band_to_host_count += 1,
            }
            *type_counts.entry(p.frame_type).or_insert(0) += 1;
            *payload_counts.entry(p.payload_hex.clone()).or_insert(0) += 1;

            let p_len = p.len as usize;
            total_payload_bytes += p_len;
            if p_len < min_len {
                min_len = p_len;
            }
            if p_len > max_len {
                max_len = p_len;
            }

            if let Ok(raw) = hex_to_bytes(&p.payload_hex) {
                let insp = ProtocolInspector::try_inspect_protobuf(&raw);
                if insp.success {
                    for tag in insp.field_tags {
                        *protobuf_candidates.entry(tag).or_insert(0) += 1;
                    }
                }
            }
        }

        if total_frames == 0 {
            min_len = 0;
        }
        let avg_len = if total_frames > 0 {
            total_payload_bytes as f64 / total_frames as f64
        } else {
            0.0
        };

        // 1. 方向与总量统计
        out.push_str("## 1. 流量概要与方向统计\n\n");
        out.push_str(&format!("- **总捕获帧数**: {}\n", total_frames));
        out.push_str(&format!("- **Host -> Band (下发)**: {} 帧\n", host_to_band_count));
        out.push_str(&format!("- **Band -> Host (上报)**: {} 帧\n\n", band_to_host_count));

        // 2. Frame Type 分布统计
        out.push_str("## 2. Frame Type 分布统计\n\n");
        out.push_str("| Frame Type | 含义说明 | 出现次数 | 占比 |\n");
        out.push_str("| :--- | :--- | :--- | :--- |\n");
        for (&ftype, &count) in &type_counts {
            let desc = match ftype {
                0x01 => "ACK 确认帧",
                0x02 => "Negotiation 链路协商帧",
                0x03 => "Business/Auth 业务或握手数据帧",
                _ => "未知或保留帧类型",
            };
            let pct = if total_frames > 0 {
                (count as f64 / total_frames as f64) * 100.0
            } else {
                0.0
            };
            out.push_str(&format!(
                "| `0x{:02x}` | {} | {} | {:.1}% |\n",
                ftype, desc, count, pct
            ));
        }
        out.push('\n');

        // 3. Payload 长度统计
        out.push_str("## 3. Payload 长度统计\n\n");
        out.push_str(&format!("- **总载荷字节数**: {} 字节\n", total_payload_bytes));
        out.push_str(&format!("- **最小 Payload 长度**: {} 字节\n", min_len));
        out.push_str(&format!("- **最大 Payload 长度**: {} 字节\n", max_len));
        out.push_str(&format!("- **平均 Payload 长度**: {:.2} 字节\n\n", avg_len));

        // 4. 重复 Payload 检测
        out.push_str("## 4. 重复 Payload 检测\n\n");
        let duplicate_payloads: Vec<_> = payload_counts
            .iter()
            .filter(|(_, &count)| count > 1)
            .collect();
        if duplicate_payloads.is_empty() {
            out.push_str("未检测到重复载荷，所有帧载荷均唯一。\n\n");
        } else {
            out.push_str("| Payload Hex 摘要 (前32字节) | 出现频次 | 说明 |\n");
            out.push_str("| :--- | :--- | :--- |\n");
            for (hex, count) in duplicate_payloads {
                let display_hex = if hex.len() > 64 {
                    format!("{}...", &hex[..64])
                } else if hex.is_empty() {
                    "(空载荷)".to_string()
                } else {
                    hex.clone()
                };
                out.push_str(&format!(
                    "| `{}` | {} 次 | 疑似固定握手/ACK应答/心跳重传 |\n",
                    display_hex, count
                ));
            }
            out.push('\n');
        }

        // 5. Protobuf 字段候选
        out.push_str("## 5. Protobuf 字段候选\n\n");
        if protobuf_candidates.is_empty() {
            out.push_str("未在有效载荷中探测到符合 Protobuf WireType 规范的明文字段（载荷可能为 TLV、原始流或密文）。\n\n");
        } else {
            out.push_str("| Tag (Field Number) | 出现频次 | 推测用途与候选分析 |\n");
            out.push_str("| :--- | :--- | :--- |\n");
            for (&tag, &count) in &protobuf_candidates {
                let desc = match tag {
                    1 => "常见基础字段 (type / package_name)",
                    2 => "常见二级字段 (id / fingerprint / hash)",
                    8 => "WearPacket 下行消息 (SEND_PHONE_MESSAGE)",
                    9 => "WearPacket 上行消息 (SEND_WEAR_MESSAGE)",
                    22 => "ThirdpartyApp 业务扩展容器",
                    _ => "协议候选字段",
                };
                out.push_str(&format!("| `{}` | {} 次 | {} |\n", tag, count, desc));
            }
            out.push('\n');
        }

        // 6. Frame 时间线详细记录
        out.push_str("## 6. Frame 时间线详细记录\n\n");
        out.push_str("| 序号 | 时间戳 (ms) | 方向 | Type | Seq | Len | CRC16 | Payload Hex |\n");
        out.push_str("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n");
        for (i, p) in recorder.packets.iter().enumerate() {
            let dir_str = match p.direction {
                PacketDirection::HostToBand => "Host -> Band",
                PacketDirection::BandToHost => "Band -> Host",
            };
            let short_hex = if p.payload_hex.len() > 24 {
                format!("{}...", &p.payload_hex[..24])
            } else {
                p.payload_hex.clone()
            };
            out.push_str(&format!(
                "| {} | {} | {} | `0x{:02x}` | {} | {} | `0x{:04x}` | `{}` |\n",
                i + 1,
                p.timestamp_ms,
                dir_str,
                p.frame_type,
                p.seq,
                p.len,
                p.crc,
                short_hex
            ));
        }
        out.push('\n');

        Ok(out)
    }
}
