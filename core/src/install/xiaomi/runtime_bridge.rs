//! 小米手环快应用安装运行时桥接层 (Xiaomi Install Runtime Bridge)
//!
//! 职责：
//! 1. 连接 XiaomiAppInstallProtocol 与真实 live.rs 数据泵
//! 2. 严禁创建第二个 socket / 第二套连接
//! 3. 通过 XiaomiInstallDeviceSession -> InstallWireSender 复用唯一已认证链路
//! 4. 安装结果只能由真实 WearPacket(type=20, id=2, result_code=0) 驱动
//! 5. 安装成功后必须再查询 type=20 id=0 已安装列表，核验 package_name 与 version
//!
//! 统一接收路径（本模块与 device_session/live.rs 共同保证）：
//! rfcomm recv -> frame decode -> business decrypt -> InstallFrameRouter
//!   -> install_response_queue -> wait_install_result
//!
//! 本文件不定义任何 DownlinkCtx 副本；真实下行唯一来源是 live::DownlinkCtx，
//! 由 live.rs 的 CoreBtInstallWire 通过共享 Core.bt 句柄完成写入。
//!
//! # 接线状态（2026-09-10）
//!
//! [implemented · 离线验证] 生产接线已建立：
//! - `main.rs` 在启动时构造 `Core.install`（`XiaomiInstallTransport`），
//!   其 `CoreBtInstallWire` 持有与 `Core.bt` **同一个** `Arc`，不复制 sock/enc_key/seq_out；
//! - `rpc.rs` 的 `--live` 分支走 `core.install`，`--fake` 分支走 `GLOBAL_INSTALL_TRANSPORT`(Mock)，
//!   生产路径不存在 Mock 传输；
//! - `live.rs` 在解密业务帧后，仅当安装进行中（门禁开启）才把**明文 L2** 派发给本模块；
//! - 安装结束后由 `on_live_pump_exit()` 关闭门禁并清空残留事件。
//!
//! [missing · 未做真机验证] 以上链路只经过离线测试与 Mock 链路验证，
//! 尚未在真实小米手环 10 上跑通一次完整安装。真机验收前不得声称安装能力已完成。

#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

use crate::frame::Frame;
use super::super::model::{
    ChunkAck, InstallChunk, InstallMetadata, InstallResult, InstallSession, Result,
};
use super::super::protocol::AppInstallProtocol;
use super::super::transport::{AppInstallTransport, BandDeviceTransport};
use super::codec::{decode_install_response, decode_install_result};
use super::device_session::{InstallWireSender, XiaomiInstallDeviceSession};
use super::installed_list;
use super::protocol::XiaomiAppInstallProtocol;
use super::thirdparty_app::{AppInstallerResult, InstallResultCode};

/// 运行时桥接状态机状态枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBridgeState {
    #[default]
    Disconnected,
    Authenticated,
    Preparing,
    Sending,
    Transferring,
    WaitingAck,
    WaitingResult,
    Completed,
    Failed,
    Cancelled,
}

impl RuntimeBridgeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Authenticated => "authenticated",
            Self::Preparing => "preparing",
            Self::Sending => "sending",
            Self::Transferring => "transferring",
            Self::WaitingAck => "waiting_ack",
            Self::WaitingResult => "waiting_result",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// 全局安装帧事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallFrameEvent {
    /// 一条安装业务入站帧（payload 已解密为 WearPacket 明文）
    Incoming(Frame),
    /// 一个 Frame 级累积 ACK 序号（Mass 分片流控用）
    Ack { seq: u8 },
}

/// 安装入站帧统一队列（由 live.rs 数据泵在安装管线激活时派发）。
static GLOBAL_INSTALL_EVENT_QUEUE: Mutex<VecDeque<InstallFrameEvent>> = Mutex::new(VecDeque::new());

/// 统一入站队列上限。安装期间由安装 RPC 线程周期性消费；限长是防御性兜底，
/// 防止调用方异常退出（prepare 成功但既不 commit 也不 cancel）时无界增长。
const MAX_INSTALL_EVENT_QUEUE: usize = 512;

/// 安装运行时管线激活开关（默认关闭，避免日常 --live 无界派发）。
static INSTALL_PIPELINE_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_install_pipeline_active(active: bool) {
    INSTALL_PIPELINE_ACTIVE.store(active, Ordering::SeqCst);
}

pub fn is_install_pipeline_active() -> bool {
    INSTALL_PIPELINE_ACTIVE.load(Ordering::SeqCst)
}

/// 安装路径的脱敏日志出口。
///
/// pulse-core 由客户端以 `stdio: 'ignore'` 启动，所以 `eprintln!` 会被直接丢弃；
/// main.rs 在 `--live` 启动时把它接到 `Core::log`，让真机排查时能在 core.log 看到安装过程。
/// 未接线时（离线测试）为 no-op。
///
/// 日志纪律：只允许记录序号、方向、长度、包名、状态与错误原因；
/// 绝不记录密钥、会话密钥、authkey、MAC 地址或任何载荷字节。
static INSTALL_LOGGER: Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>> = Mutex::new(None);

pub fn set_install_logger(logger: Box<dyn Fn(&str) + Send + Sync>) {
    if let Ok(mut guard) = INSTALL_LOGGER.lock() {
        *guard = Some(logger);
    }
}

/// 写一条脱敏安装日志（未接线时为 no-op）。
pub fn install_log(msg: &str) {
    if let Ok(guard) = INSTALL_LOGGER.lock() {
        if let Some(logger) = guard.as_ref() {
            logger(msg);
        }
    }
}

/// 向全局安装帧事件队列派发事件（由 live.rs 调用）。
pub fn dispatch_install_frame_event(event: InstallFrameEvent) {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.push_back(event);
        while q.len() > MAX_INSTALL_EVENT_QUEUE {
            q.pop_front();
        }
    }
}

/// 数据泵退出后的安装运行时收尾（由 live.rs 调用）。
///
/// 关闭派发门禁并清空残留入站事件，防止下次连接时读到上一次的旧帧。
/// 生产安装传输（`Core.install`）持有的 `Core.bt` 共享句柄会自动看到连接已释放，
/// 无需在此重新注册或回退到 Mock。
pub fn on_live_pump_exit() {
    set_install_pipeline_active(false);
    clear_global_install_events();
}

/// 从全局安装帧事件队列拉取事件。
pub fn poll_global_install_event() -> Option<InstallFrameEvent> {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.pop_front()
    } else {
        None
    }
}

/// 清理全局安装帧事件队列。
pub fn clear_global_install_events() {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.clear();
    }
}

/// 派发一个 Frame 级累积 ACK（由 live.rs 数据泵在收到 type=0x01 帧时调用）。
pub fn dispatch_install_ack(seq: u8) {
    dispatch_install_frame_event(InstallFrameEvent::Ack { seq });
}

/// 设备安装能力检测模型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XiaomiInstallCapability {
    pub authenticated: bool,
    pub supports_install_channel: bool,
    pub max_chunk_size: u32,
}

/// 小米快应用安装运行时桥接器。
///
/// 架构定位：
/// XiaomiAppInstallProtocol
///   ↓
/// XiaomiInstallRuntimeBridge
///   ↓
/// XiaomiInstallDeviceSession -> InstallWireSender
///   ↓
/// Core.bt (live::DownlinkCtx) -> Frame encode -> AES-CTR -> RFCOMM -> Band
#[derive(Debug, Default)]
pub struct XiaomiInstallRuntimeBridge {
    pub state: RuntimeBridgeState,
    pub install_session: XiaomiInstallDeviceSession,
    pub protocol: XiaomiAppInstallProtocol,
}

impl XiaomiInstallRuntimeBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_session(session: XiaomiInstallDeviceSession) -> Self {
        let state = if session.authenticated {
            RuntimeBridgeState::Authenticated
        } else {
            RuntimeBridgeState::Disconnected
        };
        Self {
            state,
            install_session: session,
            protocol: XiaomiAppInstallProtocol::new(),
        }
    }

    /// 绑定真实实时链路（生产：CoreBtInstallWire）。
    pub fn with_wire(wire: Box<dyn InstallWireSender>) -> Self {
        let session = XiaomiInstallDeviceSession::with_wire(wire);
        Self::with_session(session)
    }

    pub fn is_ready(&self) -> bool {
        self.state != RuntimeBridgeState::Disconnected
            && (self.state == RuntimeBridgeState::Authenticated
                || self.install_session.authenticated)
    }

    pub fn detect_capability(&self) -> Result<XiaomiInstallCapability> {
        if self.is_ready() {
            Ok(XiaomiInstallCapability {
                authenticated: true,
                supports_install_channel: true,
                max_chunk_size: 244,
            })
        } else {
            Err("device_unavailable: 设备未连接或未完成底层认证 (not_implemented)".to_string())
        }
    }

    pub fn check_device_capability(&self, authenticated: bool) -> Result<XiaomiInstallCapability> {
        if authenticated {
            Ok(XiaomiInstallCapability {
                authenticated: true,
                supports_install_channel: true,
                max_chunk_size: 244,
            })
        } else {
            Err("device_unavailable: 设备未连接或未完成底层认证 (not_implemented)".to_string())
        }
    }

    /// 真实发送安装明文 L2：走已绑定实时链路（business_frame_payload + seq_out + send_all）。
    ///
    /// 返回值是真正写入链路的 Frame（seq 来自共享 DownlinkCtx.seq_out）。
    pub fn send_install_packet(&mut self, plaintext_l2: &[u8]) -> Result<Frame> {
        self.state = RuntimeBridgeState::Sending;
        let frame = Frame {
            frame_type: 0x03,
            seq: 0,
            payload: plaintext_l2.to_vec(),
        };
        self.install_session.send_install_packet(&frame)
    }

    /// 处理入站帧：由 InstallFrameRouter 执行协议过滤与队列路由。
    pub fn process_incoming_frame(&mut self, frame: Frame) -> bool {
        self.install_session.dispatch_incoming_frame(frame)
    }

    /// 从统一入站队列同步并返回下一个待处理安装帧（payload 已解密为 L2 明文）。
    pub fn receive_frame(&mut self) -> Result<Option<Frame>> {
        self.install_session.receive_install_packet(0)
    }

    /// 轮询并解析设备安装结果上报报文（底层 AppInstallerResult）。
    pub fn poll_app_installer_result(&mut self) -> Result<Option<AppInstallerResult>> {
        loop {
            let Some(frame) = self.install_session.receive_install_packet(0)? else {
                return Ok(None);
            };
            if let Ok(res) = decode_install_result(&frame.payload) {
                if res.code == InstallResultCode::Success {
                    self.state = RuntimeBridgeState::Completed;
                } else {
                    self.state = RuntimeBridgeState::Failed;
                }
                return Ok(Some(res));
            }
            if decode_install_response(&frame.payload).is_ok() {
                self.state = RuntimeBridgeState::Transferring;
            }
            // id=0 已安装列表等其它帧：继续消费，等待真正的 id=2。
        }
    }

    /// 轮询并解析设备安装结果（高层 InstallResult 契约）。
    pub fn poll_install_result(&mut self) -> Result<Option<InstallResult>> {
        let app_res = self.poll_app_installer_result()?;
        if let Some(res) = app_res {
            if res.code == InstallResultCode::Success {
                Ok(Some(InstallResult {
                    status: "completed".to_string(),
                }))
            } else {
                Ok(Some(InstallResult {
                    status: "failed".to_string(),
                }))
            }
        } else {
            Ok(None)
        }
    }

    /// 执行完整的 prepare_install 协议并驱动桥接状态机。
    pub fn execute_prepare(
        &mut self,
        metadata: &InstallMetadata,
    ) -> Result<InstallSession> {
        self.install_session.refresh_authentication();
        self.state = RuntimeBridgeState::Preparing;
        let res = self
            .protocol
            .prepare_install(&mut self.install_session, metadata);
        if res.is_ok() {
            self.state = RuntimeBridgeState::Transferring;
        } else {
            self.state = RuntimeBridgeState::Failed;
        }
        res
    }

    /// 执行 send_package_chunk 协议并驱动桥接状态机。
    pub fn execute_send_chunk(&mut self, chunk: &InstallChunk) -> Result<ChunkAck> {
        self.state = RuntimeBridgeState::Sending;
        let res = self
            .protocol
            .send_package_chunk(&mut self.install_session, chunk);
        if res.is_ok() {
            self.state = RuntimeBridgeState::Transferring;
        } else {
            self.state = RuntimeBridgeState::Failed;
        }
        res
    }

    /// 等待设备安装结果并闭环状态机。
    ///
    /// 防伪规则：只有协议状态机进入 Success 才置 Completed；
    /// 设备未上报（waiting_device_result）保持 WaitingResult，绝不假成功。
    pub fn execute_wait_result(&mut self, session_id: &str) -> Result<InstallResult> {
        self.state = RuntimeBridgeState::WaitingResult;
        let res = self
            .protocol
            .wait_install_result(&mut self.install_session, session_id);
        self.state = match self.protocol.state {
            super::XiaomiInstallState::Success => RuntimeBridgeState::Completed,
            super::XiaomiInstallState::Failure => RuntimeBridgeState::Failed,
            _ => RuntimeBridgeState::WaitingResult,
        };
        res
    }

    /// 生产传输 prepare：真实刷新认证并驱动协议。
    pub fn transport_prepare(&mut self, metadata: &InstallMetadata) -> Result<InstallSession> {
        self.install_session.refresh_authentication();
        // 清空上一次安装遗留的帧，避免旧 Mass ACK 污染本次等待。
        self.install_session.discard_stale_frames();
        let res = self.execute_prepare(metadata);
        if res.is_err() && !self.install_session.authenticated {
            self.state = RuntimeBridgeState::Disconnected;
        }
        res
    }

    pub fn transport_send_chunk(&mut self, chunk: &InstallChunk) -> Result<ChunkAck> {
        self.execute_send_chunk(chunk)
    }

    /// 生产传输 commit：等待 id=2 结果，成功后再查询 id=0 已安装列表核验。
    pub fn transport_commit(&mut self, session_id: &str) -> Result<InstallResult> {
        self.state = RuntimeBridgeState::WaitingResult;
        let wait = self
            .protocol
            .wait_install_result(&mut self.install_session, session_id);
        match wait {
            Ok(res) if res.status == "success" => match self.verify_installed_list() {
                Ok(()) => {
                    self.state = RuntimeBridgeState::Completed;
                    Ok(InstallResult {
                        status: "completed".to_string(),
                    })
                }
                Err(e) => {
                    self.state = RuntimeBridgeState::Failed;
                    Err(e)
                }
            },
            Ok(_) => {
                self.state = RuntimeBridgeState::WaitingResult;
                Ok(InstallResult {
                    status: "unknown".to_string(),
                })
            }
            Err(e) => {
                self.state = RuntimeBridgeState::Failed;
                Err(e)
            }
        }
    }

    /// 设备上报成功后的二次核验：查询 type=20 id=0 已安装列表，
    /// 必须同时满足 package_name 与 version_code 命中，才返回 Ok。
    pub fn verify_installed_list(&mut self) -> Result<()> {
        let metadata = self
            .protocol
            .metadata
            .clone()
            .ok_or_else(|| "缺少安装元数据，无法核验已安装列表".to_string())?;

        let query_payload = installed_list::build_installed_list_query();
        let query_frame = Frame {
            frame_type: 0x03,
            seq: 0,
            payload: query_payload,
        };
        self.install_session.send_install_packet(&query_frame)?;

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err("查询已安装列表超时 (timeout)".to_string());
            }
            let remaining = deadline.saturating_duration_since(now).as_millis() as u64;
            let Some(frame) = self
                .install_session
                .receive_install_packet(remaining.min(500))?
            else {
                continue;
            };
            if let Ok(apps) = installed_list::decode_installed_list(&frame.payload) {
                let found = installed_list::installed_list_contains(
                    &apps,
                    &metadata.package_id,
                    Some(metadata.version_code),
                );
                install_log(&format!(
                    "install: 已安装列表返回 {} 项，目标 package={} version_code={} 命中={found}",
                    apps.len(),
                    metadata.package_id,
                    metadata.version_code
                ));
                if found {
                    return Ok(());
                }
                return Err(format!(
                    "已安装列表未包含目标快应用: package={}, version_code={}",
                    metadata.package_id, metadata.version_code
                ));
            }
        }
    }

    /// 查询已安装表盘列表 (GET_INSTALLED_LIST, type=4, id=0)
    pub fn fetch_installed_watchfaces(&mut self) -> Result<Vec<super::watch_face::WatchFaceItem>> {
        self.install_session.refresh_authentication();
        if !self.install_session.is_linked() {
            return Err("device_unavailable: 设备未连接或链路未认证".to_string());
        }

        let query_payload = super::watch_face::build_watchface_list_query();
        let query_frame = Frame {
            frame_type: 0x03,
            seq: 0,
            payload: query_payload,
        };
        self.install_session.send_install_packet(&query_frame)?;

        self.wait_watchface_list(Duration::from_secs(10))
    }

    /// 等待并解码设备返回的表盘列表；非列表帧一律丢弃继续等。
    fn wait_watchface_list(
        &mut self,
        timeout: Duration,
    ) -> Result<Vec<super::watch_face::WatchFaceItem>> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err("查询已安装表盘列表超时 (timeout)".to_string());
            }
            let remaining = deadline.saturating_duration_since(now).as_millis() as u64;
            let Some(frame) = self
                .install_session
                .receive_install_packet(remaining.min(500))?
            else {
                continue;
            };
            if let Ok(items) = super::watch_face::decode_watchface_list_response(&frame.payload) {
                install_log(&format!(
                    "watchface: 已安装表盘列表返回 {} 项",
                    items.len()
                ));
                return Ok(items);
            }
        }
    }

    /// 设置当前表盘 (SET_WATCH_FACE, type=4, id=1)。
    ///
    /// 上游 watchface_system.dart `setWatchface` 为 fire-and-forget：发送后不等待应答，
    /// 也不存在已知的直接应答报文。因此成功判定只能来自设备侧证据：
    /// 先查列表确认目标存在，发送后轮询 GET_INSTALLED_LIST，直到目标 is_current=true。
    pub fn set_current_watchface(
        &mut self,
        watchface_id: &str,
    ) -> Result<super::watch_face::WatchFaceItem> {
        self.install_session.refresh_authentication();
        if !self.install_session.is_linked() {
            return Err("device_unavailable: 设备未连接或链路未认证".to_string());
        }

        let before = self.fetch_installed_watchfaces()?;
        let Some(target) = before.iter().find(|i| i.id == watchface_id) else {
            return Err(format!("表盘 {watchface_id} 不在已安装列表中，拒绝设置"));
        };
        if target.is_current {
            install_log(&format!("watchface: {watchface_id} 已是当前表盘，无需设置"));
            return Ok(target.clone());
        }

        let set_payload = super::watch_face::build_watchface_set_query(watchface_id);
        let set_frame = Frame {
            frame_type: 0x03,
            seq: 0,
            payload: set_payload,
        };
        self.install_session.send_install_packet(&set_frame)?;
        install_log(&format!(
            "watchface: SET_WATCH_FACE 已发送 id={watchface_id}，等待设备生效 (is_current 轮询)"
        ));

        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "SET_WATCH_FACE 已发送，但 {watchface_id} 的 is_current 在 20s 内未变为 true (timeout)"
                ));
            }
            std::thread::sleep(Duration::from_millis(800));
            // 设备不会自发推送列表，每轮必须主动重新发送 GET_INSTALLED_LIST
            let poll_frame = Frame {
                frame_type: 0x03,
                seq: 0,
                payload: super::watch_face::build_watchface_list_query(),
            };
            self.install_session.send_install_packet(&poll_frame)?;
            match self.wait_watchface_list(Duration::from_secs(3)) {
                Ok(items) => match items.iter().find(|i| i.id == watchface_id) {
                    Some(item) if item.is_current => {
                        install_log(&format!("watchface: 设备已确认 {watchface_id} 为当前表盘"));
                        return Ok(item.clone());
                    }
                    Some(_) => {
                        install_log("watchface: 列表已返回但目标尚未生效，继续轮询");
                    }
                    None => {
                        return Err(format!("SET_WATCH_FACE 后列表中找不到 {watchface_id}"));
                    }
                },
                Err(e) => {
                    install_log(&format!("watchface: 轮询列表失败，继续重试: {e}"));
                }
            }
        }
    }

    /// 表盘整包安装：PREPARE(4) → Mass(16) → REPORT_INSTALL_RESULT(5)。
    /// 成功判定只依据设备上报结果码；本方法不含"设为当前表盘"。
    pub fn install_watchface_file(
        &mut self,
        file_bytes: &[u8],
        md5_hex: &str,
        explicit_id: Option<&str>,
    ) -> Result<super::watchface_install::WatchfaceInstallOutcome> {
        self.install_session.refresh_authentication();
        if !self.install_session.is_linked() {
            return Err("device_unavailable: 设备未连接或链路未认证".to_string());
        }
        // 与 RPK 安装相同的前置清理：避免上次会话的残留帧/ACK 污染本次等待
        self.install_session.discard_stale_frames();
        super::watchface_install::install_watchface(
            &mut self.install_session,
            file_bytes,
            md5_hex,
            explicit_id,
        )
    }

    pub fn transport_cancel(&mut self, session_id: &str) -> Result<()> {
        let res = self
            .protocol
            .cancel_install(&mut self.install_session, session_id);
        self.state = RuntimeBridgeState::Cancelled;
        res
    }
}

impl BandDeviceTransport for XiaomiInstallRuntimeBridge {
    fn connect(&mut self, target_addr: &str) -> Result<()> {
        self.install_session.connect(target_addr)?;
        self.state = RuntimeBridgeState::Authenticated;
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        self.install_session.disconnect()?;
        self.state = RuntimeBridgeState::Disconnected;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.install_session.is_connected()
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        self.install_session.send_frame(frame)
    }

    fn receive_frame(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.install_session.receive_frame(timeout_ms)
    }

    fn send_install_packet(&mut self, frame: &Frame) -> Result<()> {
        self.install_session.send_install_packet(frame).map(|_| ())
    }

    fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.install_session.receive_install_packet(timeout_ms)
    }

    fn send_plain_payload(&mut self, payload: &[u8]) -> Result<u8> {
        self.install_session.send_plain_payload(payload)
    }

    fn wait_frame_ack(&mut self, wait_ms: u64) -> Option<u8> {
        self.install_session.wait_frame_ack(wait_ms)
    }

    fn is_authenticated(&self) -> bool {
        self.install_session.is_authenticated()
    }

    fn has_duplicate_connection(&self) -> bool {
        false
    }
}

/// 生产用小艾安装传输实现：把 AppInstallTransport 的 prepare/send_chunk/commit/cancel
/// 映射到 XiaomiAppInstallProtocol + 已绑定真实 Core.bt 的设备会话。
///
/// 该类是 Core.install 的实例类型（--live 生产路径），绝不使用 MockAppInstallTransport。
#[derive(Debug, Default)]
pub struct XiaomiInstallTransport {
    pub bridge: XiaomiInstallRuntimeBridge,
}

impl XiaomiInstallTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_wire(wire: Box<dyn InstallWireSender>) -> Self {
        Self {
            bridge: XiaomiInstallRuntimeBridge::with_wire(wire),
        }
    }

    pub fn fetch_installed_watchfaces(&mut self) -> Result<Vec<super::watch_face::WatchFaceItem>> {
        set_install_pipeline_active(true);
        install_log("watchface: 开始查询已安装表盘列表 (GET_INSTALLED_LIST type=4 id=0)");
        let res = self.bridge.fetch_installed_watchfaces();
        match &res {
            Ok(items) => install_log(&format!("watchface: 表盘列表查询成功，共 {} 项", items.len())),
            Err(e) => install_log(&format!("watchface: 表盘列表查询失败: {e}")),
        }
        set_install_pipeline_active(false);
        res
    }

    pub fn set_current_watchface(
        &mut self,
        watchface_id: &str,
    ) -> Result<super::watch_face::WatchFaceItem> {
        set_install_pipeline_active(true);
        install_log(&format!(
            "watchface: 开始设置当前表盘 (SET_WATCH_FACE type=4 id=1) target={watchface_id}"
        ));
        let res = self.bridge.set_current_watchface(watchface_id);
        match &res {
            Ok(item) => install_log(&format!(
                "watchface: 设置成功，设备侧已确认 id={} is_current=true",
                item.id
            )),
            Err(e) => install_log(&format!("watchface: 设置失败: {e}")),
        }
        set_install_pipeline_active(false);
        res
    }

    pub fn install_watchface_file(
        &mut self,
        file_bytes: &[u8],
        md5_hex: &str,
        explicit_id: Option<&str>,
    ) -> Result<super::watchface_install::WatchfaceInstallOutcome> {
        set_install_pipeline_active(true);
        install_log(&format!(
            "watchface: 开始整包安装 (PREPARE type=4 id=4 → Mass dataType=16 → RESULT type=4 id=5) 文件 {} 字节",
            file_bytes.len()
        ));
        let res = self
            .bridge
            .install_watchface_file(file_bytes, md5_hex, explicit_id);
        match &res {
            Ok(o) => install_log(&format!(
                "watchface: 安装成功 id={} result_code={} (2=SUCCESS 3=USED)",
                o.watchface_id, o.result_code
            )),
            Err(e) => install_log(&format!("watchface: 安装失败: {e}")),
        }
        set_install_pipeline_active(false);
        res
    }
}

impl AppInstallTransport for XiaomiInstallTransport {
    /// 开始安装才打开 live.rs 的安装帧派发门禁，并在失败/结束时关闭。
    ///
    /// 门禁只在安装进行期间打开，这样空闲连接不会把每个业务帧复制进全局队列。
    fn prepare(&mut self, metadata: InstallMetadata) -> Result<InstallSession> {
        set_install_pipeline_active(true);
        install_log(&format!(
            "install: prepare 开始 package={} version_code={} file_size={}",
            metadata.package_id, metadata.version_code, metadata.file_size
        ));
        let res = self.bridge.transport_prepare(&metadata);
        match &res {
            Ok(s) => install_log(&format!(
                "install: prepare 完成 session={} total_chunks={}",
                s.session_id, s.total_chunks
            )),
            Err(e) => install_log(&format!("install: prepare 失败: {e}")),
        }
        if res.is_err() {
            set_install_pipeline_active(false);
        }
        res
    }

    fn send_chunk(&mut self, chunk: InstallChunk) -> Result<ChunkAck> {
        set_install_pipeline_active(true);
        let res = self.bridge.transport_send_chunk(&chunk);
        match &res {
            Ok(ack) => install_log(&format!(
                "install: chunk #{}/{} 已下发 (累计 {}B)",
                ack.index, self.bridge.protocol.total_chunks, ack.received_bytes
            )),
            Err(e) => install_log(&format!("install: chunk #{} 失败: {e}", chunk.index)),
        }
        if res.is_err() {
            set_install_pipeline_active(false);
        }
        res
    }

    fn commit(&mut self, session_id: String) -> Result<InstallResult> {
        set_install_pipeline_active(true);
        install_log("install: commit 开始，等待设备 id=2 安装结果");
        let res = self.bridge.transport_commit(&session_id);
        match &res {
            Ok(r) => install_log(&format!("install: commit 结束 status={}", r.status)),
            Err(e) => install_log(&format!("install: commit 失败: {e}")),
        }
        set_install_pipeline_active(false);
        res
    }

    fn cancel(&mut self, session_id: String) -> Result<()> {
        install_log("install: cancel 收到，发送 Mass 取消并关闭门禁");
        let res = self.bridge.transport_cancel(&session_id);
        set_install_pipeline_active(false);
        res
    }
}