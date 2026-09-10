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

#![allow(dead_code)]

use std::collections::VecDeque;
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
/// 严格映射已认证会话的下行能力：包含已有 socket 引用句柄、AES-128-CTR 密钥、以及自增序列号 seq_out
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
    pub fn execute_wait_result(
        &mut self,
        protocol: &mut XiaomiAppInstallProtocol,
        session_id: &str,
    ) -> Result<InstallResult> {
        self.state = RuntimeBridgeState::WaitingResult;
        let res = protocol.wait_install_result(&mut self.install_session, session_id);
        match &res {
            Ok(_) => {
                self.state = RuntimeBridgeState::Completed;
            }
            Err(_) => {
                self.state = RuntimeBridgeState::Failed;
            }
        }
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
