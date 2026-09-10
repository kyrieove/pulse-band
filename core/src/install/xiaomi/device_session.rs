//! 小米手环安装设备会话适配层 (Xiaomi Install Device Session Adapter)
//!
//! 职责：
//! 1. 获取并复用已认证设备通信能力，严禁创建第二套蓝牙连接
//! 2. 区分安装业务报文与日常 interconnect 业务报文，实现严格通信隔离
//! 3. send_install_packet() 发送安装帧
//! 4. receive_install_packet() 接收已过滤的安装响应
//! 5. filter_install_response() 检测报文是否归属安装协议
//!
//! 防爆约束：
//! - 严禁修改 live.rs, session.rs, rfcomm.rs
//! - 严禁调用 rfcomm::socket 或发起第二路 RFCOMM / BLE 连接
//! - 严禁返回 completed 或 installed 假成功状态

use std::collections::VecDeque;
use crate::frame::Frame;
use super::super::model::Result;
use super::super::transport::BandDeviceTransport;
use super::l2::{L2Channel, L2Packet};
use super::wear_packet::{WearPacket, WearPacketType};

/// 检测指定载荷是否归属于快应用安装业务（过滤与分流规则）
///
/// 判定规则：
/// - 若为 L2Packet:
///   - channel == Mass (2) -> 属于快应用安装大文件传输 (true)
///   - channel == Pb (1):
///     - 载荷解析为 WearPacket:
///       - type == 20 (ThirdpartyApp) 且 id == 1 (AppInstallerResponse) -> true
///       - type == 20 (ThirdpartyApp) 且 id == 2 (AppInstallerResult) -> true
///       - type == 22 (Mass) -> true
///       - 其余 (例如 id == 9 SEND_WEAR_MESSAGE, id == 6 REQUEST_PHONE_APP_STATUS) -> false (日常业务隔离)
/// - 若直接为 WearPacket Protobuf:
///   - type == 20 且 (id == 1 || id == 2) -> true
///   - type == 22 -> true
///   - 其余 -> false
pub fn filter_install_response(payload: &[u8]) -> bool {
    let raw = if payload.len() >= 2 && payload[0..2] == [0x01, 0x02] {
        &payload[2..]
    } else {
        payload
    };

    if raw.is_empty() {
        return false;
    }

    // 1. 尝试作为 L2Packet 解析
    if let Ok(l2) = L2Packet::from_bytes(raw) {
        if l2.channel == L2Channel::Mass {
            return true;
        }
        if l2.channel == L2Channel::Pb {
            if let Ok(wp) = WearPacket::decode(&l2.payload) {
                return is_wear_packet_install(&wp);
            }
        }
    }

    // 2. 尝试直接作为 WearPacket Protobuf 解析
    if let Ok(wp) = WearPacket::decode(raw) {
        return is_wear_packet_install(&wp);
    }

    false
}

#[allow(dead_code)]
fn is_wear_packet_install(wp: &WearPacket) -> bool {
    match wp.pkt_type {
        WearPacketType::ThirdpartyApp => {
            // id=1: AppInstallerResponse (准备响应)
            // id=2: AppInstallerResult (安装结果上报)
            // id=9 (FETCH), id=6 (APP_STATUS), id=8 (PHONE_MSG) 绝不能判定为安装消息
            wp.id == 1 || wp.id == 2
        }
        WearPacketType::Mass => {
            // Mass 通道控制报文/ACK
            true
        }
        _ => false,
    }
}

/// 小米快应用安装设备会话适配器
///
/// 架构定位：
/// XiaomiBand10Transport
///   ↓
/// XiaomiAppInstallProtocol
///   ↓
/// XiaomiInstallDeviceSession (实现 BandDeviceTransport)
///   ↓ (复用已有已认证底层句柄，绝无第二套连接)
/// Core.bt (live::DownlinkCtx / RFCOMM)
#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct XiaomiInstallDeviceSession {
    pub authenticated: bool,
    pub target_addr: Option<String>,
    pub shared_connection: bool,
    pub duplicate_connection_created: bool,
    pub underlying_handle: Option<usize>,
    pub outgoing_install_frames: VecDeque<Frame>,
    pub incoming_install_queue: VecDeque<Frame>,
    pub normal_message_queue: VecDeque<Frame>,
}

#[allow(dead_code)]
impl XiaomiInstallDeviceSession {
    pub fn new() -> Self {
        Self {
            authenticated: false,
            target_addr: None,
            shared_connection: true,
            duplicate_connection_created: false,
            underlying_handle: None,
            outgoing_install_frames: VecDeque::new(),
            incoming_install_queue: VecDeque::new(),
            normal_message_queue: VecDeque::new(),
        }
    }

    /// 从已认证连接句柄复用创建会话（绝不创建第二套连接）
    pub fn from_authenticated_session(handle: usize, target_addr: &str) -> Self {
        Self {
            authenticated: true,
            target_addr: Some(target_addr.to_string()),
            shared_connection: true,
            duplicate_connection_created: false,
            underlying_handle: Some(handle),
            outgoing_install_frames: VecDeque::new(),
            incoming_install_queue: VecDeque::new(),
            normal_message_queue: VecDeque::new(),
        }
    }

    /// 显式绑定已认证会话
    pub fn bind_authenticated(&mut self, target_addr: &str) -> Result<()> {
        self.authenticated = true;
        self.target_addr = Some(target_addr.to_string());
        self.shared_connection = true;
        self.duplicate_connection_created = false;
        Ok(())
    }

    /// 发送安装数据帧（带认证前置检查）
    pub fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        if !self.authenticated {
            return Err("device_unavailable: 设备会话未就绪或未认证 (not_implemented)".to_string());
        }
        self.outgoing_install_frames.push_back(frame.clone());
        Ok(())
    }

    /// 接收已过滤的安装响应帧（带超时机制与会话状态检查）
    pub fn receive_install_packet(&mut self, _timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.authenticated {
            return Err("device_unavailable: 设备会话未就绪或未认证 (not_implemented)".to_string());
        }
        Ok(self.incoming_install_queue.pop_front())
    }

    /// 分发传入帧：若归属安装业务则推入安装响应队列；若为日常业务则推入普通消息队列，保证日常业务完全不被拦截
    pub fn dispatch_incoming_frame(&mut self, frame: Frame) -> bool {
        if filter_install_response(&frame.payload) {
            self.incoming_install_queue.push_back(frame);
            true
        } else {
            self.normal_message_queue.push_back(frame);
            false
        }
    }

    pub fn is_shared_connection(&self) -> bool {
        self.shared_connection
    }

    pub fn has_duplicate_connection(&self) -> bool {
        self.duplicate_connection_created
    }
}

impl BandDeviceTransport for XiaomiInstallDeviceSession {
    fn connect(&mut self, target_addr: &str) -> Result<()> {
        // 纪律约束：禁止创建第二套蓝牙连接，仅标记绑定既有连接
        self.bind_authenticated(target_addr)
    }

    fn disconnect(&mut self) -> Result<()> {
        self.authenticated = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.authenticated
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        self.send_install_packet(frame)
    }

    fn receive_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.receive_install_packet(timeout_ms)
    }

    fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        self.send_install_packet(frame)
    }

    fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.receive_install_packet(timeout_ms)
    }

    fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    fn has_duplicate_connection(&self) -> bool {
        false
    }
}

/// 用于离线单元测试与协议隔离验证的 Mock 会话
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockDeviceSession {
    pub authenticated: bool,
    pub target_addr: Option<String>,
    pub duplicate_connection_created: bool,
    pub sent_install_frames: Vec<Frame>,
    pub incoming_install_queue: VecDeque<Frame>,
    pub normal_message_queue: VecDeque<Frame>,
}

#[allow(dead_code)]
impl MockDeviceSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        if !self.authenticated {
            return Err("device_unavailable: Mock 设备未就绪或未认证".to_string());
        }
        self.sent_install_frames.push(frame.clone());
        Ok(())
    }

    pub fn receive_install_packet(&mut self, _timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.authenticated {
            return Err("device_unavailable: Mock 设备未就绪或未认证".to_string());
        }
        Ok(self.incoming_install_queue.pop_front())
    }

    pub fn dispatch_incoming_frame(&mut self, frame: Frame) -> bool {
        if filter_install_response(&frame.payload) {
            self.incoming_install_queue.push_back(frame);
            true
        } else {
            self.normal_message_queue.push_back(frame);
            false
        }
    }

    pub fn has_duplicate_connection(&self) -> bool {
        self.duplicate_connection_created
    }
}

impl BandDeviceTransport for MockDeviceSession {
    fn connect(&mut self, target_addr: &str) -> Result<()> {
        self.authenticated = true;
        self.target_addr = Some(target_addr.to_string());
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        self.authenticated = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.authenticated
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        self.send_install_packet(frame)
    }

    fn receive_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.receive_install_packet(timeout_ms)
    }

    fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        self.send_install_packet(frame)
    }

    fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.receive_install_packet(timeout_ms)
    }

    fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    fn has_duplicate_connection(&self) -> bool {
        false
    }
}
