//! 小米手环快应用安装业务协议实现 (Xiaomi App Install Protocol Implementation)
//!
//! 依据源码证据：
//! - `wear_install_system (XiaomiInstallSystem.installApp)`
//! - `wear_mass_transfer (MassTransferPipeline)`
//! - `wear_thirdparty_app.proto`
//! - `wear_mass.proto`
//!
//! 状态流转纪律：
//! `preparing -> transferring -> waiting_device_result -> success/failure`
//! 严禁产生任何 `completed` 或 `installed` 假成功状态。

use super::super::model::{
    ChunkAck, InstallChunk, InstallMetadata, InstallResult, InstallSession, Result,
};
use super::super::protocol::AppInstallProtocol;
use super::super::transport::BandDeviceTransport;
use super::codec::{
    decode_install_response, decode_install_result, decode_mass_prepare_response,
    encode_install_request, encode_mass_prepare_len,
};
use super::l2::L2Packet;
use super::mass::{build_mass_inner_payload, MassChunk, MASS_DATA_TYPE_THIRDPARTY_APP};
use super::thirdparty_app::InstallResultCode;
use super::XiaomiInstallState;
use crate::frame::Frame;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 等待设备上报的单次超时预算（毫秒）。
const DEVICE_REPLY_TIMEOUT_MS: u64 = 5000;

/// 等待 Mass PrepareResponse 的时长（上游源码为 10 秒）。
const MASS_PREPARE_TIMEOUT_MS: u64 = 10_000;

/// 等待设备上报安装结果 id=2 的时长（上游源码为 60 秒）。
const INSTALL_RESULT_TIMEOUT_MS: u64 = 60_000;

/// Mass 分片发送窗口。
///
/// 这是**客户端策略**（上游该版本本地 `_localTxWin=32`），不是 Band 10 的设备协商结果。
const MASS_TX_WINDOW: usize = 32;

/// 单次等待 Mass 分片 ACK 的时长。
const MASS_ACK_WAIT_MS: u64 = 2_000;

/// 整个 Mass 传输的截止预算。
const MASS_TRANSFER_TIMEOUT_MS: u64 = 120_000;

/// 累积确认：把序号不晚于 `ack_seq` 的在途项移出（模 256 半区间判断）。
///
/// 与上游 `_handleAck` 的"从队首开始标记序号不晚于 ACK.seq 的待发送项"一致；
/// ACK 对应的是 Frame 的 8 位 seq，不是 Mass 的 16 位 current_part。
fn ack_cumulative(inflight: &mut VecDeque<u8>, ack_seq: u8) {
    while let Some(&front) = inflight.front() {
        if ack_seq.wrapping_sub(front) < 128 {
            inflight.pop_front();
        } else {
            break;
        }
    }
}

/// 小米快应用原生安装业务协议状态机实现
#[derive(Debug, Clone)]
pub struct XiaomiAppInstallProtocol {
    pub state: XiaomiInstallState,
    pub active_session: Option<InstallSession>,
    pub metadata: Option<InstallMetadata>,
    pub mass_prepared: bool,
    pub total_chunks: u32,
    pub sent_chunks: u32,
    pub total_sent_bytes: u64,
    pub expected_slice_length: u32,
    pub md5: Vec<u8>,
    pub seq: u8,
    /// 累积的原始 RPK 字节：Mass 必须先组装完整 body 再整体切片
    pub transfer_buffer: Vec<u8>,
    /// 已发出但尚未被累积 ACK 覆盖的 Frame 序号（流控）
    pub inflight: VecDeque<u8>,
}

impl Default for XiaomiAppInstallProtocol {
    fn default() -> Self {
        Self {
            state: XiaomiInstallState::Preparing,
            active_session: None,
            metadata: None,
            mass_prepared: false,
            total_chunks: 0,
            sent_chunks: 0,
            total_sent_bytes: 0,
            expected_slice_length: 244,
            md5: vec![0u8; 16],
            seq: 0,
            transfer_buffer: Vec::new(),
            inflight: VecDeque::new(),
        }
    }
}

impl XiaomiAppInstallProtocol {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_seq(&mut self) -> u8 {
        let s = self.seq;
        self.seq = self.seq.wrapping_add(1);
        s
    }

    /// 发起 Mass Prepare 并**等待设备 READY**。
    ///
    /// 上游源码确认：Mass 准备后必须校验响应（READY / 分片长度 / 续传），确认后才发分片；
    /// 未收到响应或非 READY 时终止，不自动重发。
    fn send_mass_prepare_and_wait_ready(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
    ) -> Result<()> {
        let data_length = self
            .metadata
            .as_ref()
            .map(|m| m.file_size as u32)
            .ok_or("缺少安装元数据")?;
        let prep_pb = encode_mass_prepare_len(data_length, &self.md5)?;
        // Mass Prepare 本身是 WearPacket(type=22, id=0)，不加 L2 前缀。
        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: prep_pb,
        };
        device_transport.send_frame(&frame)?;

        let deadline = Instant::now() + Duration::from_millis(MASS_PREPARE_TIMEOUT_MS);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.state = XiaomiInstallState::Failure;
                return Err("等待 Mass PrepareResponse 超时 (timeout)".to_string());
            }
            let Some(f) = device_transport.receive_frame(remaining.as_millis() as u64)? else {
                self.state = XiaomiInstallState::Failure;
                return Err("等待 Mass PrepareResponse 超时 (timeout)".to_string());
            };
            let Ok(resp) = decode_mass_prepare_response(&f.payload) else {
                continue;
            };
            if !resp.is_ready() {
                self.state = XiaomiInstallState::Failure;
                return Err(format!(
                    "Mass 准备未就绪 (prepare_status={})",
                    resp.prepare_status
                ));
            }
            if let Some(slice_len) = resp.expected_slice_length {
                if slice_len > 6 {
                    self.expected_slice_length = slice_len;
                }
            }
            self.mass_prepared = true;
            return Ok(());
        }
    }

    /// 组装完整 Mass body、整体切片，并按发送窗口做累积 ACK 流控。
    ///
    /// body 结构（上游源码确认）：`00 | 40 | MD5[16] | file_length(u32LE) | RPK | CRC32(u32LE)`；
    /// 切片格式：`02 01 | total_parts(u16LE) | current_part(u16LE) | fragment`，
    /// 其中 fragment 上限 = `expected_slice_length - 6`（2 字节 L2 + 4 字节片头）。
    fn transfer_mass_body(&mut self, device_transport: &mut dyn BandDeviceTransport) -> Result<()> {
        let expected_size = self
            .metadata
            .as_ref()
            .map(|m| m.file_size as usize)
            .unwrap_or(0);
        if self.transfer_buffer.len() != expected_size {
            return Err(format!(
                "已接收字节数与声明 file_size 不一致: {} != {}",
                self.transfer_buffer.len(),
                expected_size
            ));
        }

        let body = build_mass_inner_payload(
            &self.transfer_buffer,
            MASS_DATA_TYPE_THIRDPARTY_APP,
            &self.md5,
        )?;

        let slice_len = self.expected_slice_length as usize;
        if slice_len <= 6 {
            return Err(format!("非法的 expected_slice_length: {slice_len}"));
        }
        let capacity = slice_len - 6;
        let total_parts = body.len().div_ceil(capacity);
        if total_parts == 0 || total_parts > u16::MAX as usize {
            return Err(format!("Mass 分片数超出 u16 范围: {total_parts}"));
        }

        let deadline = Instant::now() + Duration::from_millis(MASS_TRANSFER_TIMEOUT_MS);
        self.inflight.clear();

        for i in 0..total_parts {
            let start = i * capacity;
            let end = (start + capacity).min(body.len());
            let payload = L2Packet::mass_write(
                MassChunk::new(total_parts as u16, (i + 1) as u16, body[start..end].to_vec())
                    .encode(),
            )
            .to_bytes();

            while self.inflight.len() >= MASS_TX_WINDOW {
                self.wait_one_ack(device_transport, deadline)?;
            }
            let seq = device_transport.send_plain_payload(&payload)?;
            self.inflight.push_back(seq);
        }

        while !self.inflight.is_empty() {
            self.wait_one_ack(device_transport, deadline)?;
        }

        super::runtime_bridge::install_log(&format!(
            "install: Mass 传输完成 body={}B 分片={} slice={} cap={}",
            body.len(),
            total_parts,
            slice_len,
            capacity
        ));
        Ok(())
    }

    /// 等待一个累积 ACK 并推进在途窗口。
    fn wait_one_ack(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        deadline: Instant,
    ) -> Result<()> {
        if Instant::now() >= deadline {
            return Err("等待 Mass 分片 ACK 超时 (timeout)".to_string());
        }
        match device_transport.wait_frame_ack(MASS_ACK_WAIT_MS) {
            Some(seq) => {
                ack_cumulative(&mut self.inflight, seq);
                Ok(())
            }
            None => Err("等待 Mass 分片 ACK 超时 (timeout)".to_string()),
        }
    }
}

/// 解析 32 位 hex 为 16 字节；非 32 位 hex 返回 None。
fn hex16(s: &str) -> Option<Vec<u8>> {
    if s.len() != 32 {
        return None;
    }
    let mut out = Vec::with_capacity(16);
    let mut chars = s.chars();
    while let (Some(a), Some(b)) = (chars.next(), chars.next()) {
        let hi = a.to_digit(16)?;
        let lo = b.to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// 解析 Mass 传输要用的 MD5。
///
/// 上游源码确认是 `MD5(完整RPK)`：
/// - 优先取元数据里显式的 `md5`；
/// - 缺失时，仅当 `hash` 恰好是 32 位 hex（调用方直接传了 MD5）才接受；
/// - 其余情况一律报错。
///
/// 这里**不允许**再从更长的摘要里截断取前 16 字节 —— 客户端 `hash` 是 SHA-256，
/// 之前那样做会把错误的 data_id 与包体 MD5 发给设备，是本轮真机失败的根因之一。
fn resolve_md5(metadata: &InstallMetadata) -> Result<Vec<u8>> {
    if let Some(md5_hex) = metadata.md5.as_deref() {
        return hex16(md5_hex).ok_or_else(|| {
            format!(
                "metadata.md5 不是合法的 32 位 hex (长度 {})",
                md5_hex.len()
            )
        });
    }
    hex16(&metadata.hash).ok_or_else(|| {
        "缺少 RPK 的 MD5: metadata.md5 未提供，且 hash 不是 32 位 hex".to_string()
    })
}

impl AppInstallProtocol for XiaomiAppInstallProtocol {
    fn prepare_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        metadata: &InstallMetadata,
    ) -> Result<InstallSession> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 小米手环底层设备未连接 (not_implemented)".to_string());
        }
        if metadata.package_id.is_empty() {
            return Err("package_id 不能为空".to_string());
        }
        if metadata.file_size == 0 {
            return Err("file_size 必须大于 0".to_string());
        }

        self.state = XiaomiInstallState::Preparing;
        self.metadata = Some(metadata.clone());
        // Mass 传输要用的 MD5 必须在发出任何流量之前确定，缺失即失败。
        let md5 = resolve_md5(metadata)?;

        // 1. 编码安装准备请求: WearPacket(type=20, id=1, ThirdpartyApp.install_request)
        //
        // 外层**不加** L2 channel/opcode 前缀。
        // 实证依据：tools/decrypt_business.py 直接把解密后的字节当作 WearPacket 解析
        // （产出 docs/protocol/business.md 的结构树），说明真机业务明文就是 protobuf 本身；
        // M1 真机跑通的 live.rs::build_downlink_payload 同样是「type + id + field22」无前缀。
        // 带 `01 01` 前缀会让手环把 field1 读成 1（Account）而不是 20，请求被直接丢弃。
        let req_pb = encode_install_request(
            &metadata.package_id,
            metadata.version_code,
            metadata.file_size as u32,
        )?;
        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: req_pb,
        };

        // 2. 发送帧
        device_transport.send_frame(&frame)?;

        // 3. 等待设备响应 AppInstallerResponse。
        //
        // 安装队列里可能混有 Mass 通道 ACK 等非准备响应帧，因此按截止时间循环，
        // 跳过无法解码为准备响应的帧，直到拿到真正的 id=1 或超时。
        let deadline = Instant::now() + Duration::from_millis(DEVICE_REPLY_TIMEOUT_MS);
        let resp = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("等待设备 AppInstallerResponse 超时 (timeout)".to_string());
            }
            let Some(frame) = device_transport.receive_frame(remaining.as_millis() as u64)? else {
                return Err("等待设备 AppInstallerResponse 超时 (timeout)".to_string());
            };
            if let Ok(resp) = decode_install_response(&frame.payload) {
                break resp;
            }
        };
        if !resp.is_ready() {
            self.state = XiaomiInstallState::Failure;
            return Err(format!("设备安装准备未就绪 (prepare_status={})", resp.prepare_status));
        }

        let slice_len = resp.expected_slice_length.unwrap_or(244);
        self.expected_slice_length = slice_len;

        let chunk_size = 512u32;
        let total_chunks =
            ((metadata.file_size + chunk_size as u64 - 1) / chunk_size as u64) as u32;
        let session_id = format!("xiaomi_inst_{}_{}", metadata.package_id, metadata.version_code);

        let session = InstallSession {
            session_id,
            status: self.state.as_str().to_string(),
            file_size: metadata.file_size,
            chunk_size,
            total_chunks,
        };

        // 准备就绪，状态流转为 transferring
        self.state = XiaomiInstallState::Transferring;
        self.active_session = Some(session.clone());
        self.total_chunks = total_chunks;
        self.sent_chunks = 0;
        self.total_sent_bytes = 0;
        self.mass_prepared = false;
        self.md5 = md5;

        Ok(session)
    }

    fn send_package_chunk(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        chunk: &InstallChunk,
    ) -> Result<ChunkAck> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 小米手环底层设备未连接 (not_implemented)".to_string());
        }
        let session = self.active_session.as_ref().ok_or("未找到活跃安装会话")?;
        if session.session_id != chunk.session_id {
            return Err("session_id 不匹配".to_string());
        }

        // 1. 累积客户端分块。
        //
        // 上游源码确认：Mass 必须先组装出**完整 body** 再整体切片，不能按文件偏移逐片发。
        // body = 00 | 40 | MD5[16] | file_length(u32LE) | 完整RPK | CRC32(u32LE)
        self.transfer_buffer.extend_from_slice(&chunk.data);
        self.sent_chunks += 1;
        self.total_sent_bytes += chunk.size as u64;

        // 2. 首个分块时发起 Mass Prepare，并**等待设备 READY** 才继续。
        //    上游要求：Mass 准备后检查 READY、分片长度与续传响应，确认后才发分片。
        if !self.mass_prepared {
            self.send_mass_prepare_and_wait_ready(device_transport)?;
        }

        // 3. 收齐全部分块后才做真正的 Mass 传输（组装 -> 切片 -> 流控发送）。
        if self.sent_chunks >= self.total_chunks {
            self.transfer_mass_body(device_transport)?;
            self.state = XiaomiInstallState::WaitingDeviceResult;
        }

        Ok(ChunkAck {
            session_id: chunk.session_id.clone(),
            index: chunk.index,
            received_bytes: self.total_sent_bytes,
        })
    }

    fn wait_install_result(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult> {
        if !device_transport.is_connected() {
            return Err("device_unavailable: 小米手环底层设备未连接 (not_implemented)".to_string());
        }
        let session = self.active_session.as_ref().ok_or("未找到活跃安装会话")?;
        if session.session_id != session_id {
            return Err("session_id 不匹配".to_string());
        }

        // 监听设备响应: 期望 WearPacket(type=20, id=2) AppInstaller.Result。
        //
        // 队列里会混有其它已过滤安装帧，因此按截止时间循环跳过无法解码为安装结果的帧，
        // 直到拿到真正的 id=2 或超时。超时预算取上游源码的 60 秒。
        let deadline = Instant::now() + Duration::from_millis(INSTALL_RESULT_TIMEOUT_MS);
        let resp_frame = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.state = XiaomiInstallState::WaitingDeviceResult;
                return Ok(InstallResult {
                    status: XiaomiInstallState::WaitingDeviceResult.as_str().to_string(),
                });
            }
            let Some(frame) = device_transport.receive_frame(remaining.as_millis() as u64)? else {
                // 超时无设备上报：保持在 waiting_device_result 状态
                self.state = XiaomiInstallState::WaitingDeviceResult;
                return Ok(InstallResult {
                    status: XiaomiInstallState::WaitingDeviceResult.as_str().to_string(),
                });
            };
            if decode_install_result(&frame.payload).is_ok() {
                break frame;
            }
        };

        // 解码设备返回的安装结果
        let result = decode_install_result(&resp_frame.payload)?;

        // 目标包名核验。
        // 证据依据：`docs/protocol/antigravity-install-handoff-20260910.md`
        // “最终必须核验响应目标及结果，不能只收到 id=2 就成功”。
        // package_name 是可选字段：设备未携带时无法确认目标，不得据此判成功。
        if let Some(got) = result.package_name.as_deref() {
            if let Some(meta) = &self.metadata {
                if !meta.package_id.is_empty() && got != meta.package_id {
                    self.state = XiaomiInstallState::Failure;
                    return Err(format!(
                        "设备安装结果目标包名不匹配: expected={}, got={got}",
                        meta.package_id
                    ));
                }
            }
        }

        match result.code {
            InstallResultCode::Success => {
                self.state = XiaomiInstallState::Success;
                Ok(InstallResult {
                    status: XiaomiInstallState::Success.as_str().to_string(),
                })
            }
            InstallResultCode::Failed => {
                self.state = XiaomiInstallState::Failure;
                Err("设备上报安装失败: INSTALL_FAILED (code 1)".to_string())
            }
            InstallResultCode::VerifyFailed => {
                self.state = XiaomiInstallState::Failure;
                Err("设备上报安装包校验失败: VERIFY_FAILED (code 2)".to_string())
            }
        }
    }

    fn cancel_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<()> {
        if let Some(session) = &self.active_session {
            if session.session_id == session_id && device_transport.is_connected() {
                use super::mass::{Mass, MassControl, MassControlOp, MASS_DATA_TYPE_THIRDPARTY_APP};
                use super::wear_packet::WearPacket;
                let ctrl = MassControl::new(
                    MassControlOp::Cancel,
                    MASS_DATA_TYPE_THIRDPARTY_APP,
                    self.md5.clone(),
                );
                let mass = Mass::from_control(ctrl);
                let wp = WearPacket::new_mass(1, mass);
                // 同上：WearPacket 明文不加 L2 前缀。
                let frame = Frame {
                    frame_type: 0x03,
                    seq: self.next_seq(),
                    payload: wp.encode(),
                };
                let _ = device_transport.send_frame(&frame);
            }
        }
        self.state = XiaomiInstallState::Failure;
        self.active_session = None;
        self.metadata = None;
        self.mass_prepared = false;
        self.sent_chunks = 0;
        self.total_sent_bytes = 0;
        self.transfer_buffer.clear();
        self.inflight.clear();
        Ok(())
    }
}
