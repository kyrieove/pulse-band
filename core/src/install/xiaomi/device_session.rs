//! 小米手环安装设备会话适配层 (Xiaomi Install Device Session Adapter)
//!
//! 职责：
//! 1. 获取并复用已认证设备通信能力，严禁创建第二套蓝牙连接
//! 2. 区分安装业务报文与日常 interconnect 业务报文，实现严格通信隔离
//! 3. send_install_packet() 通过已绑定的实时链路 trait 真实发送安装帧
//! 4. receive_install_packet() 从 live.rs 派发的统一入站队列接收已过滤安装响应
//! 5. filter_install_response() 检测报文是否归属安装协议
//!
//! 纪律：
//! - 严禁新建 RFCOMM/BLE 连接；真实 socket 只在 live.rs 的 Core.bt 中
//! - send_install_packet() 不得只入队；必须经过 business_frame_payload + frame::encode
//!   并交给绑定到 Core.bt 的实时链路发送
//! - 严禁返回 completed 或 installed 假成功状态

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use aes::cipher::{KeyIvInit, StreamCipher};
use aes::Aes128;
use ctr::Ctr128BE;

use crate::frame::Frame;
use super::super::model::Result;
use super::super::transport::BandDeviceTransport;
use super::l2::{L2Channel, L2Packet};
use super::runtime_bridge::{poll_global_install_event, InstallFrameEvent};
use super::wear_packet::{WearPacket, WearPacketType};

type BizCtr = Ctr128BE<Aes128>;

/// 业务帧前缀标志（0x01, 0x02）
pub const BIZ_PREFIX: [u8; 2] = [0x01, 0x02];

/// 普通（非安装）消息隔离队列的保留上限。
///
/// 安装管线激活期间，live.rs 会把每个业务帧都路由到设备会话；日常消息（id=6/7/9 等）
/// 没有安装侧的消费者，只保留最近若干条用于诊断，避免长时间传输时无界增长。
pub const MAX_NORMAL_MESSAGE_QUEUE: usize = 64;

/// 累积 ACK 队列上限（Mass 流控）。ACK 会被及时消费，限长只是防御性兜底。
pub const MAX_PENDING_ACKS: usize = 256;

/// 对业务载荷做 AES-128-CTR (IV=key) 流加解密
pub fn biz_stream(key: &[u8; 16], data: &[u8]) -> Vec<u8> {
    let mut buf = data.to_vec();
    let mut cipher = BizCtr::new_from_slices(key, key).expect("AES-128-CTR key+IV 须为 16 字节");
    cipher.apply_keystream(&mut buf);
    buf
}

/// 解密业务数据帧载荷（01 02 || ct -> plaintext）
pub fn decrypted_business_payload(key: &[u8; 16], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 2 || payload[0..2] != BIZ_PREFIX {
        return None;
    }
    Some(biz_stream(key, &payload[2..]))
}

/// 封装业务明文为带 01 02 前缀与 CTR 密文的 payload
pub fn business_frame_payload(key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + plaintext.len());
    out.extend_from_slice(&BIZ_PREFIX);
    out.extend_from_slice(&biz_stream(key, plaintext));
    out
}

/// 检测指定载荷是否归属于快应用安装业务（过滤与分流规则）
///
/// 判定规则：
/// - L2 Mass 通道 (2) -> true
/// - L2 Pb 通道 (1) 且 WearPacket:
///   - type=20 且 id 属于 {0 已安装列表, 1 安装准备响应, 2 安装结果} -> true
///   - type=22 (Mass) -> true
/// - 其余（id=6/7/8/9 等日常业务）-> false，保证不被安装流程吞掉
pub fn filter_install_response(payload: &[u8]) -> bool {
    let raw = if payload.len() >= 2 && payload[0..2] == [0x01, 0x02] {
        &payload[2..]
    } else {
        payload
    };

    if raw.is_empty() {
        return false;
    }

    // 真机抓包实证：业务明文就是 WearPacket protobuf 本身（无 L2 前缀），优先按此解析。
    if let Ok(wp) = WearPacket::decode(raw) {
        if is_wear_packet_install(&wp) {
            return true;
        }
    }

    // 兼容路径：Mass 分片按上游采用 L2 channel=2 封装
    // （仅源码证据，设备未实测），保留解析以兼容历史样本与 Mock。
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

    false
}

#[allow(dead_code)]
fn is_wear_packet_install(wp: &WearPacket) -> bool {
    match wp.pkt_type {
        WearPacketType::ThirdpartyApp => wp.id == 0 || wp.id == 1 || wp.id == 2,
        WearPacketType::WatchFace => wp.id == 0 || wp.id == 1 || wp.id == 4 || wp.id == 5,
        WearPacketType::Mass => true,
        _ => false,
    }
}

/// 快应用安装帧路由分发层 (Install Frame Router)
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct InstallFrameRouter {
    pub enc_key: Option<[u8; 16]>,
    pub dec_key: Option<[u8; 16]>,
}

#[allow(dead_code)]
impl InstallFrameRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_keys(enc_key: [u8; 16], dec_key: [u8; 16]) -> Self {
        Self {
            enc_key: Some(enc_key),
            dec_key: Some(dec_key),
        }
    }

    /// 编码安装下行帧（支持明文与 AES-128-CTR 加密两种路径）
    pub fn encode_install_frame(&self, plaintext_l2: &[u8], seq: u8) -> Frame {
        let payload = if let Some(key) = &self.enc_key {
            business_frame_payload(key, plaintext_l2)
        } else {
            plaintext_l2.to_vec()
        };
        Frame {
            frame_type: 0x03,
            seq,
            payload,
        }
    }

    /// 解析上行帧明文：若为加密业务帧 (01 02 || ciphertext) 且配置了 dec_key 则解密；否则原样返回
    pub fn resolve_payload(&self, frame: &Frame) -> Vec<u8> {
        if frame.payload.len() >= 2 && frame.payload[0..2] == BIZ_PREFIX {
            if let Some(key) = &self.dec_key {
                if let Some(plain) = decrypted_business_payload(key, &frame.payload) {
                    return plain;
                }
            }
            return frame.payload[2..].to_vec();
        }
        frame.payload.clone()
    }

    pub fn is_install_frame(&self, frame: &Frame) -> bool {
        let plain = self.resolve_payload(frame);
        filter_install_response(&plain)
    }

    pub fn route_frame(
        &self,
        frame: Frame,
        install_queue: &mut VecDeque<Frame>,
        normal_queue: &mut VecDeque<Frame>,
    ) -> bool {
        if self.is_install_frame(&frame) {
            install_queue.push_back(frame);
            true
        } else {
            normal_queue.push_back(frame);
            false
        }
    }
}

/// 实时安装链路发送接口。
///
/// 生产实现位于 live.rs（CoreBtInstallWire），直接持有 Core.bt 的共享句柄，
/// 在唯一的已认证 DownlinkCtx 上完成业务帧加密、序号递增与 socket 写入。
/// 离线测试可注入 MockInstallWireSender，验证发送动作确实发生（而非只入队）。
pub trait InstallWireSender: std::fmt::Debug + Send + Sync {
    /// 将明文 L2 安装载荷封装为业务帧并写入真实已认证链路。
    /// 返回本次实际使用的下行 seq；实现方必须递增共享 DownlinkCtx.seq_out。
    fn send_install_payload(&self, plaintext_l2: &[u8]) -> Result<u8>;

    /// 发送 Mass 通道载荷：**不做** `01 02` 前缀、**不做** AES-128-CTR。
    ///
    /// 上游源码确认 Mass 分支不加密，payload 直接是
    /// `02 01 | total_parts(u16LE) | current_part(u16LE) | fragment`，
    /// 外层仍是同一个 Frame(A5A5) 封装。返回本次使用的下行 seq。
    fn send_mass_payload(&self, payload: &[u8]) -> Result<u8>;

    /// 实时链路当前是否可用（Core.bt 已存在且已认证）。
    fn is_available(&self) -> bool;
}

/// 单条 Mock 发送记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockSentInstall {
    pub seq: u8,
    pub plaintext_l2: Vec<u8>,
}

#[derive(Debug, Default)]
struct MockInstallWireInner {
    sent: Mutex<Vec<MockSentInstall>>,
    sent_mass: Mutex<Vec<MockSentInstall>>,
    next_seq: AtomicU8,
    authenticated: AtomicBool,
}

/// 离线测试用实时链路 Mock：记录每次真实发送动作与序号，不做任何 socket 写入。
#[derive(Debug, Default, Clone)]
pub struct MockInstallWireSender {
    inner: Arc<MockInstallWireInner>,
}

impl MockInstallWireSender {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_authenticated(&self, authenticated: bool) {
        self.inner
            .authenticated
            .store(authenticated, Ordering::SeqCst);
    }

    pub fn sent_count(&self) -> usize {
        self.inner.sent.lock().unwrap().len()
    }

    pub fn sent_records(&self) -> Vec<MockSentInstall> {
        self.inner.sent.lock().unwrap().clone()
    }

    /// Mass 明文通道的发送记录（与 Pb 通道分开，便于断言没有被套 `01 02`）
    pub fn sent_mass_records(&self) -> Vec<MockSentInstall> {
        self.inner.sent_mass.lock().unwrap().clone()
    }
}

impl InstallWireSender for MockInstallWireSender {
    fn send_install_payload(&self, plaintext_l2: &[u8]) -> Result<u8> {
        if !self.inner.authenticated.load(Ordering::SeqCst) {
            return Err("device_unavailable: Mock 实时链路未认证".to_string());
        }
        let seq = self.inner.next_seq.fetch_add(1, Ordering::SeqCst);
        self.inner.sent.lock().unwrap().push(MockSentInstall {
            seq,
            plaintext_l2: plaintext_l2.to_vec(),
        });
        Ok(seq)
    }

    /// Mass 明文通道：记录原始载荷（**不加** `01 02`、**不加密**），供测试断言。
    fn send_mass_payload(&self, payload: &[u8]) -> Result<u8> {
        if !self.inner.authenticated.load(Ordering::SeqCst) {
            return Err("device_unavailable: Mock 实时链路未认证".to_string());
        }
        let seq = self.inner.next_seq.fetch_add(1, Ordering::SeqCst);
        self.inner
            .sent_mass
            .lock()
            .unwrap()
            .push(MockSentInstall {
                seq,
                plaintext_l2: payload.to_vec(),
            });
        Ok(seq)
    }

    fn is_available(&self) -> bool {
        self.inner.authenticated.load(Ordering::SeqCst)
    }
}

/// 生成一段**脱敏**的安装帧描述（L2 通道 + WearPacket type/id + 长度），仅用于日志。
///
/// 只输出结构标识，不输出任何载荷字节。
#[allow(dead_code)]
pub fn describe_install_frame(payload: &[u8]) -> String {
    let raw = if payload.len() >= 2 && payload[0..2] == BIZ_PREFIX {
        &payload[2..]
    } else {
        payload
    };
    if let Ok(l2) = L2Packet::from_bytes(raw) {
        if l2.channel == L2Channel::Mass {
            return format!("L2=mass len={}", l2.payload.len());
        }
        if l2.channel == L2Channel::Pb {
            if let Ok(wp) = WearPacket::decode(&l2.payload) {
                return format!(
                    "L2=pb type={} id={} len={}",
                    wp.pkt_type.as_u32(),
                    wp.id,
                    l2.payload.len()
                );
            }
        }
    }
    if let Ok(wp) = WearPacket::decode(raw) {
        return format!("type={} id={} len={}", wp.pkt_type.as_u32(), wp.id, raw.len());
    }
    format!("unparsed len={}", raw.len())
}

/// 小米快应用安装设备会话适配器。
///
/// 架构定位：
/// XiaomiAppInstallProtocol
///   ↓
/// XiaomiInstallDeviceSession (实现 BandDeviceTransport)
///   ↓ InstallWireSender
/// Core.bt (live::DownlinkCtx / RFCOMM，唯一已认证连接)
#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct XiaomiInstallDeviceSession {
    pub authenticated: bool,
    pub target_addr: Option<String>,
    pub shared_connection: bool,
    pub duplicate_connection_created: bool,
    pub underlying_handle: Option<usize>,
    pub router: InstallFrameRouter,
    pub outgoing_install_frames: VecDeque<Frame>,
    pub incoming_install_queue: VecDeque<Frame>,
    pub normal_message_queue: VecDeque<Frame>,
    pub wire: Option<Box<dyn InstallWireSender>>,
    /// 已到达、尚未消费的 Frame 级累积 ACK 序号（Mass 分片流控）
    pub pending_wire_acks: VecDeque<u8>,
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
            router: InstallFrameRouter::new(),
            outgoing_install_frames: VecDeque::new(),
            incoming_install_queue: VecDeque::new(),
            normal_message_queue: VecDeque::new(),
            wire: None,
            pending_wire_acks: VecDeque::new(),
        }
    }

    /// 绑定实时链路发送句柄（生产：CoreBtInstallWire；测试：MockInstallWireSender）。
    pub fn bind_wire(&mut self, wire: Box<dyn InstallWireSender>) {
        self.authenticated = wire.is_available();
        self.wire = Some(wire);
    }

    pub fn with_wire(wire: Box<dyn InstallWireSender>) -> Self {
        let mut session = Self::new();
        session.bind_wire(wire);
        session
    }

    /// 从真实链路刷新认证状态。生产路径必须在开始安装前调用。
    pub fn refresh_authentication(&mut self) {
        if let Some(wire) = &self.wire {
            self.authenticated = wire.is_available();
        }
    }

    pub fn wire_available(&self) -> bool {
        self.wire.as_ref().map(|w| w.is_available()).unwrap_or(false)
    }

    /// 链路是否可用：绑定了实时链路时以 Core.bt 的真实状态为准，否则回落到离线标记。
    ///
    /// 生产路径下断开连接后 `Core.bt` 变空，这里会立刻变为 false，
    /// 不会因为缓存的 `authenticated` 布尔值而谎报已认证。
    pub fn is_linked(&self) -> bool {
        match &self.wire {
            Some(wire) => wire.is_available(),
            None => self.authenticated,
        }
    }

    /// 从已认证连接句柄复用创建会话（绝不创建第二套连接）。
    pub fn from_authenticated_session(handle: usize, target_addr: &str) -> Self {
        let mut session = Self::new();
        session.authenticated = true;
        session.target_addr = Some(target_addr.to_string());
        session.underlying_handle = Some(handle);
        session
    }

    pub fn set_crypto_keys(&mut self, enc_key: [u8; 16], dec_key: [u8; 16]) {
        self.router = InstallFrameRouter::with_keys(enc_key, dec_key);
    }

    pub fn encode_install_frame(&self, plaintext_l2: &[u8], seq: u8) -> Frame {
        self.router.encode_install_frame(plaintext_l2, seq)
    }

    /// 显式绑定已认证会话（不创建连接，仅标记）。
    pub fn bind_authenticated(&mut self, target_addr: &str) -> Result<()> {
        self.authenticated = true;
        self.target_addr = Some(target_addr.to_string());
        self.shared_connection = true;
        self.duplicate_connection_created = false;
        Ok(())
    }

    /// 真实发送安装帧：明文 L2 -> 业务帧加密 + 真实 seq -> 写入已认证链路。
    ///
    /// 返回真正写入链路的 Frame（seq 来自 DownlinkCtx.seq_out）。
    pub fn send_install_packet(&mut self, frame: &Frame) -> Result<Frame> {
        self.transmit_frame(frame)
    }

    fn transmit_frame(&mut self, frame: &Frame) -> Result<Frame> {
        if !self.is_linked() {
            return Err("device_unavailable: 设备会话未就绪或未认证 (not_implemented)".to_string());
        }
        let wire = self.wire.as_ref().ok_or_else(|| {
            "device_unavailable: 安装链路未绑定真实 Core.bt (not_implemented)".to_string()
        })?;
        let seq = wire.send_install_payload(&frame.payload)?;
        let sent = Frame {
            frame_type: 0x03,
            seq,
            payload: frame.payload.clone(),
        };
        self.outgoing_install_frames.push_back(sent.clone());
        Ok(sent)
    }

    /// 开始一次新安装前清空上一次遗留的入站/出站帧。
    ///
    /// 此时尚未发出任何安装请求，队列里不可能存在"本次"的响应，
    /// 因此丢弃残留帧是安全的，并能避免上一次安装的 Mass ACK 污染本次等待。
    pub fn discard_stale_frames(&mut self) {
        self.drain_live_ingress();
        self.incoming_install_queue.clear();
        self.outgoing_install_frames.clear();
        self.pending_wire_acks.clear();
    }

    /// 从 live.rs 统一入站队列同步事件，并按 InstallFrameRouter 分流。
    pub fn drain_live_ingress(&mut self) {
        while let Some(event) = poll_global_install_event() {
            match event {
                InstallFrameEvent::Incoming(frame) => {
                    self.dispatch_incoming_frame(frame);
                }
                InstallFrameEvent::Ack { seq } => {
                    self.note_frame_ack(seq);
                }
            }
        }
    }

    /// 记录一个 Frame 级累积 ACK。
    pub fn note_frame_ack(&mut self, seq: u8) {
        self.pending_wire_acks.push_back(seq);
        while self.pending_wire_acks.len() > MAX_PENDING_ACKS {
            self.pending_wire_acks.pop_front();
        }
    }

    /// 通过实时链路发送 Mass 明文载荷（不加密），返回使用的 seq。
    pub fn send_plain_payload(&mut self, payload: &[u8]) -> Result<u8> {
        if !self.is_linked() {
            return Err("device_unavailable: 设备会话未就绪或未认证 (not_implemented)".to_string());
        }
        let wire = self
            .wire
            .as_ref()
            .ok_or_else(|| "device_unavailable: 安装链路未绑定真实 Core.bt (not_implemented)".to_string())?;
        wire.send_mass_payload(payload)
    }

    /// 接收安装响应：只从统一入站队列/本地 install_response_queue 读取。
    ///
    /// - 无实时链路（离线测试）时不阻塞并立即返回；
    /// - 有实时链路时最多等待 timeout_ms，期间持续把 live.rs 派发的事件路由进队列。
    /// - 返回的 Frame.payload 已解密为 L2 明文，保证协议层只看到一种口径。
    pub fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.recv_install_frame(timeout_ms)
    }

    fn recv_install_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.is_linked() {
            return Err("device_unavailable: 设备会话未就绪或未认证 (not_implemented)".to_string());
        }
        self.drain_live_ingress();
        if let Some(frame) = self.incoming_install_queue.pop_front() {
            return Ok(Some(self.resolve_for_protocol(frame)));
        }
        if self.wire.is_none() {
            return Ok(None);
        }
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
            self.drain_live_ingress();
            if let Some(frame) = self.incoming_install_queue.pop_front() {
                return Ok(Some(self.resolve_for_protocol(frame)));
            }
        }
        Ok(None)
    }

    fn resolve_for_protocol(&self, frame: Frame) -> Frame {
        let payload = self.router.resolve_payload(&frame);
        Frame {
            frame_type: frame.frame_type,
            seq: frame.seq,
            payload,
        }
    }

    /// 分发传入帧：安装业务进安装响应队列，日常业务进普通消息队列（不被安装流程吞掉）。
    ///
    /// Frame 级 ACK（type=0x01）不进业务队列，而是记入 Mass 流控的累积确认队列。
    /// 普通消息队列只用于隔离诊断，没有业务消费者；限长避免长时间连接时无界增长。
    pub fn dispatch_incoming_frame(&mut self, frame: Frame) -> bool {
        if frame.frame_type == 0x01 {
            self.note_frame_ack(frame.seq);
            return false;
        }
        let routed = self.router.route_frame(
            frame,
            &mut self.incoming_install_queue,
            &mut self.normal_message_queue,
        );
        while self.normal_message_queue.len() > MAX_NORMAL_MESSAGE_QUEUE {
            self.normal_message_queue.pop_front();
        }
        routed
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
        self.is_linked()
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        self.transmit_frame(frame).map(|_| ())
    }

    fn receive_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.recv_install_frame(timeout_ms)
    }

    fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        self.transmit_frame(frame).map(|_| ())
    }

    fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.recv_install_frame(timeout_ms)
    }

    /// Mass 明文通道：交给绑定的实时链路，不套 `01 02`、不做 AES-CTR。
    fn send_plain_payload(&mut self, payload: &[u8]) -> Result<u8> {
        self.send_plain_payload(payload)
    }

    /// 等待 Frame 级累积 ACK：期间持续把 live.rs 派发的入站事件路由进队列
    /// （安装响应帧进 install queue 不丢失），只消费 ACK。
    fn wait_frame_ack(&mut self, wait_ms: u64) -> Option<u8> {
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            self.drain_live_ingress();
            if let Some(seq) = self.pending_wire_acks.pop_front() {
                return Some(seq);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn is_authenticated(&self) -> bool {
        self.is_linked()
    }

    fn has_duplicate_connection(&self) -> bool {
        false
    }
}

/// 用于离线单元测试与协议隔离验证的 Mock 会话（只入队/只记录，不触及任何真实链路）。
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockDeviceSession {
    pub authenticated: bool,
    pub target_addr: Option<String>,
    pub duplicate_connection_created: bool,
    pub router: InstallFrameRouter,
    pub sent_install_frames: Vec<Frame>,
    pub incoming_install_queue: VecDeque<Frame>,
    pub normal_message_queue: VecDeque<Frame>,
}

#[allow(dead_code)]
impl MockDeviceSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_crypto_keys(&mut self, enc_key: [u8; 16], dec_key: [u8; 16]) {
        self.router = InstallFrameRouter::with_keys(enc_key, dec_key);
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
        self.router.route_frame(
            frame,
            &mut self.incoming_install_queue,
            &mut self.normal_message_queue,
        )
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
