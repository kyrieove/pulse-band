//! 小米手环快应用安装运行时桥接层 (Xiaomi Install Runtime Bridge)
//!
//! 职责：
//! 1. 连接 XiaomiAppInstallProtocol 与 Core.bt (DownlinkCtx)
//! 2. 严禁创建第二个 socket / 第二套连接
//! 3. 严禁持有 socket 字段（严格复用已有已认证 DownlinkCtx）
//! 4. 状态机闭环：RuntimeBridgeState (Disconnected, Authenticated, Preparing, Sending, Transferring, WaitingAck, WaitingResult, Completed, Failed, Cancelled)
//! 5. 严格防伪规则：仅在接收到真实 WearPacket(type=20, id=2) 且 result_code == 0 时才进入 Completed；禁止假成功
//! 6. 设备能力检测：XiaomiInstallCapability (authenticated, supports_install_channel, max_chunk_size)
//! 7. 数据流收发桥接：使用已有 DownlinkCtx 发送，使用已有 live.rs 接收
//!
//! # 当前真实状态（阶段 21 审计结论，禁止夸大）
//!
//! [not implemented] 本模块**尚未接入生产链路**：
//! - `XiaomiInstallRuntimeBridge` 目前只被 `core/tests/app_install_test.rs` 实例化；
//!   `main.rs` / `rpc.rs` / `live.rs` 中没有任何生产代码创建它，因此
//!   “RPK → Core RPC → Protocol → RuntimeBridge → RFCOMM” 这条链路**在运行时不存在**；
//! - 本文件内的 `DownlinkCtx` 是 `live::DownlinkCtx` 的**同名副本**，二者不是同一个类型，
//!   不能直接互相传入；它不持有任何真实 socket，也不会写入 RFCOMM；
//! - `send_install_packet()` 只把帧压入 `outgoing_install_frames` 队列，**不发送**；
//! - 接收侧依赖 `live.rs` 的 `dispatch_install_frame_event()`，该派发默认关闭
//!   （见 `is_install_pipeline_active()`），需要上层在真正开始安装时显式打开。

#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

use crate::frame::Frame;
use super::super::model::{
    ChunkAck, InstallChunk, InstallMetadata, InstallResult, InstallSession, Result,
};
use super::super::protocol::AppInstallProtocol;
use super::super::transport::BandDeviceTransport;
use super::codec::{decode_install_response, decode_install_result};
use super::device_session::{
    business_frame_payload, XiaomiInstallDeviceSession,
};
use super::protocol::XiaomiAppInstallProtocol;
use super::thirdparty_app::{AppInstallerResult, InstallResultCode};

/// 运行时桥接状态机状态枚举
///
/// 纪律要求：
/// - 严格按真实通信阶段流转
/// - 只有在接收到真实 WearPacket(type=20, id=2) 且 result_code == 0 时才允许进入 Completed
/// - result_code != 0 必须进入 Failed
/// - 严禁产生任何模拟或超时伪完成状态
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
    Incoming(Frame),
}

/// 全局安装帧事件队列（供 live.rs 数据泵向 RuntimeBridge 分发入站业务帧）
static GLOBAL_INSTALL_EVENT_QUEUE: Mutex<VecDeque<InstallFrameEvent>> = Mutex::new(VecDeque::new());

/// 安装运行时管线激活开关（默认关闭）
///
/// 为什么需要这个开关：
/// `run_pump_loop` 每收到一个 type=0x03 业务帧都会 clone 一份投递到上方的全局队列；
/// 该队列只有一个消费者（RuntimeBridge），而 RuntimeBridge 当前没有生产实例。
/// 如果不加门禁，`--live` 长期运行时这个队列会**无界增长**（普通业务消息也被复制一遍），
/// 同时制造“安装链路已接通”的假象。
///
/// 纪律：
/// - 默认 `false`：生产环境不派发，日常 interconnect 数据泵零额外开销；
/// - 只有上层真正开始一次安装会话时才显式 `set_install_pipeline_active(true)`，结束即关闭。
static INSTALL_PIPELINE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 打开/关闭安装运行时管线的事件派发
pub fn set_install_pipeline_active(active: bool) {
    INSTALL_PIPELINE_ACTIVE.store(active, Ordering::SeqCst);
}

/// 查询安装运行时管线是否激活（live.rs 数据泵据此决定是否派发入站帧）
pub fn is_install_pipeline_active() -> bool {
    INSTALL_PIPELINE_ACTIVE.load(Ordering::SeqCst)
}

/// 向全局安装帧事件队列派发事件（由 live.rs 调用）
pub fn dispatch_install_frame_event(event: InstallFrameEvent) {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.push_back(event);
    }
}

/// 从全局安装帧事件队列拉取事件
pub fn poll_global_install_event() -> Option<InstallFrameEvent> {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.pop_front()
    } else {
        None
    }
}

/// 清理全局安装帧事件队列
pub fn clear_global_install_events() {
    if let Ok(mut q) = GLOBAL_INSTALL_EVENT_QUEUE.lock() {
        q.clear();
    }
}

/// 设备安装能力检测模型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XiaomiInstallCapability {
    pub authenticated: bool,
    pub supports_install_channel: bool,
    pub max_chunk_size: u32,
}

/// 下行数据传输上下文（DownlinkCtx）
///
/// [not wired] 这是 `live::DownlinkCtx` 的**同名副本**，不是同一个类型。
/// `live.rs` 的真实结构体额外持有 `basic: Option<BasicInfo>`，且其 `Drop` 会真正
/// `closesocket`；本副本不持有任何真实 socket，只用于离线编码测试
/// （`sock` 字段在测试中恒为 0）。两者之间目前没有转换或桥接代码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownlinkCtx {
    pub sock: usize,
    pub enc_key: [u8; 16],
    pub seq_out: u8,
}

impl DownlinkCtx {
    pub fn new(sock: usize, enc_key: [u8; 16], seq_out: u8) -> Self {
        Self {
            sock,
            enc_key,
            seq_out,
        }
    }
}

/// 小米快应用安装运行时桥接器
///
/// 架构定位：
/// Renderer -> Main Service -> Core RPC
///   ↓
/// XiaomiAppInstallProtocol
///   ↓
/// XiaomiInstallRuntimeBridge (本结构体，严禁持有 socket 字段)
///   ↓
/// DownlinkCtx (复用已有连接句柄)
///   ↓
/// Frame encode -> AES CTR -> RFCOMM
///   ↓
/// Band
#[derive(Debug, Default)]
pub struct XiaomiInstallRuntimeBridge {
    pub state: RuntimeBridgeState,
    pub install_session: XiaomiInstallDeviceSession,
}

impl XiaomiInstallRuntimeBridge {
    pub fn new() -> Self {
        Self {
            state: RuntimeBridgeState::Disconnected,
            install_session: XiaomiInstallDeviceSession::new(),
        }
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
        }
    }

    /// 检测会话是否就绪且已认证
    pub fn is_ready(&self) -> bool {
        self.state != RuntimeBridgeState::Disconnected
            && (self.state == RuntimeBridgeState::Authenticated || self.install_session.authenticated)
    }

    /// 查询设备安装能力：如果未完成认证或底层会话不存在，返回结构化错误 (device_unavailable)
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

    /// 查询指定认证状态下的设备安装能力
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

    /// 构建安装业务下行帧（通过 DownlinkCtx 的 enc_key 加密，自增 seq_out）
    pub fn build_install_frame(
        ctx: &mut DownlinkCtx,
        plaintext_l2: &[u8],
    ) -> Frame {
        let payload = business_frame_payload(&ctx.enc_key, plaintext_l2);
        let frame = Frame {
            frame_type: 0x03,
            seq: ctx.seq_out,
            payload,
        };
        ctx.seq_out = ctx.seq_out.wrapping_add(1);
        frame
    }

    /// 通过已有 DownlinkCtx 编码加密并发送安装数据帧（严格复用，零新 socket）
    ///
    /// [placeholder] 当前只完成“编码 + 入队”，**没有任何 socket 写入**。
    /// 真正发到 RFCOMM 需要在下一阶段把 `live::DownlinkCtx`（含真实 sock/seq_out）
    /// 接入这里，调用 `live` 侧既有的 `send_all(sock, &encode(&frame))` 通路。
    pub fn send_install_packet(
        &mut self,
        ctx: &mut DownlinkCtx,
        plaintext_l2: &[u8],
    ) -> Result<Frame> {
        let frame = Self::build_install_frame(ctx, plaintext_l2);
        self.state = RuntimeBridgeState::Sending;
        self.install_session.outgoing_install_frames.push_back(frame.clone());
        Ok(frame)
    }

    /// 处理入站帧：由 InstallFrameRouter 执行协议过滤与队列路由
    pub fn process_incoming_frame(&mut self, frame: Frame) -> bool {
        self.install_session.dispatch_incoming_frame(frame)
    }

    /// 从全局事件队列同步所有入站帧，并尝试获取下一个待处理的安装响应帧
    pub fn receive_frame(&mut self) -> Result<Option<Frame>> {
        // 1. 同步全局入站队列所有事件
        while let Some(event) = poll_global_install_event() {
            match event {
                InstallFrameEvent::Incoming(frame) => {
                    self.process_incoming_frame(frame);
                }
            }
        }
        // 2. 从会话的过滤安装响应队列提取
        Ok(self.install_session.incoming_install_queue.pop_front())
    }

    /// 轮询并解析设备安装结果上报报文（底层 AppInstallerResult）
    pub fn poll_app_installer_result(&mut self) -> Result<Option<AppInstallerResult>> {
        // 先从全局事件拉取
        while let Some(event) = poll_global_install_event() {
            match event {
                InstallFrameEvent::Incoming(frame) => {
                    self.process_incoming_frame(frame);
                }
            }
        }

        let mut idx_to_remove = None;
        let mut resolved_result = None;

        for (i, frame) in self.install_session.incoming_install_queue.iter().enumerate() {
            let plain = self.install_session.router.resolve_payload(frame);
            if let Ok(res) = decode_install_result(&plain) {
                idx_to_remove = Some(i);
                resolved_result = Some(res);
                break;
            } else if let Ok(_resp) = decode_install_response(&plain) {
                self.state = RuntimeBridgeState::Transferring;
            }
        }

        if let Some(i) = idx_to_remove {
            self.install_session.incoming_install_queue.remove(i);
        }

        if let Some(res) = resolved_result {
            if res.code == InstallResultCode::Success {
                self.state = RuntimeBridgeState::Completed;
            } else {
                self.state = RuntimeBridgeState::Failed;
            }
            return Ok(Some(res));
        }

        Ok(None)
    }

    /// 轮询并解析设备安装结果报文（高层 InstallResult 契约）：
    /// 仅在收到 WearPacket(type=20, id=2) 且 result_code == 0 时才进入 Completed 状态；
    /// 若 result_code != 0 则进入 Failed 状态；
    /// 严禁假完成。
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

    /// 执行完整的 prepare_install 协议并驱动桥接状态机
    pub fn execute_prepare(
        &mut self,
        protocol: &mut XiaomiAppInstallProtocol,
        metadata: &InstallMetadata,
    ) -> Result<InstallSession> {
        self.state = RuntimeBridgeState::Preparing;
        let res = protocol.prepare_install(&mut self.install_session, metadata);
        if res.is_ok() {
            self.state = RuntimeBridgeState::Transferring;
        } else {
            self.state = RuntimeBridgeState::Failed;
        }
        res
    }

    /// 执行 send_package_chunk 协议并驱动桥接状态机
    pub fn execute_send_chunk(
        &mut self,
        protocol: &mut XiaomiAppInstallProtocol,
        chunk: &InstallChunk,
    ) -> Result<ChunkAck> {
        self.state = RuntimeBridgeState::Sending;
        let res = protocol.send_package_chunk(&mut self.install_session, chunk);
        if res.is_ok() {
            self.state = RuntimeBridgeState::Transferring;
        } else {
            self.state = RuntimeBridgeState::Failed;
        }
        res
    }

    /// 等待设备安装结果并闭环状态机
    ///
    /// 防伪规则（阶段 21 审计修复）：
    /// `protocol.wait_install_result()` 在**设备未上报**时会返回 `Ok(status = "waiting_device_result")`。
    /// 修复前这里对任何 `Ok(_)` 都置 `Completed`，等于把“设备没回话”当成“安装成功”。
    /// 现在桥接状态只跟随协议状态机的真实落点：
    /// - `Success`  → `Completed`（仅由真实 WearPacket(type=20, id=2, result_code=0) 驱动）
    /// - `Failure`  → `Failed`
    /// - 其余（含超时未上报）→ `WaitingResult`，绝不进入 `Completed`
    pub fn execute_wait_result(
        &mut self,
        protocol: &mut XiaomiAppInstallProtocol,
        session_id: &str,
    ) -> Result<InstallResult> {
        self.state = RuntimeBridgeState::WaitingResult;
        let res = protocol.wait_install_result(&mut self.install_session, session_id);
        self.state = match protocol.state {
            super::XiaomiInstallState::Success => RuntimeBridgeState::Completed,
            super::XiaomiInstallState::Failure => RuntimeBridgeState::Failed,
            _ => RuntimeBridgeState::WaitingResult,
        };
        res
    }
}

impl BandDeviceTransport for XiaomiInstallRuntimeBridge {
    /// [placeholder] 不建立任何连接，只把会话标记为已认证。
    /// 真实连接由 `live::run_live` 的 `connect_and_authenticate()` 独占负责。
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
        self.install_session.send_install_packet(frame)
    }

    fn receive_install_packet(&mut self, timeout_ms: u64) -> Result<Option<Frame>> {
        self.install_session.receive_install_packet(timeout_ms)
    }

    fn is_authenticated(&self) -> bool {
        self.install_session.is_authenticated()
    }

    fn has_duplicate_connection(&self) -> bool {
        false
    }
}
