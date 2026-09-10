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
    decode_install_response, decode_install_result, encode_install_request, encode_mass_chunk,
    encode_mass_prepare,
};
use super::l2::L2Packet;
use super::thirdparty_app::InstallResultCode;
use super::XiaomiInstallState;
use crate::frame::Frame;

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
}

/// 解析 32 字符 hex 格式 MD5，或推导出 16 字节固定摘要
fn parse_or_derive_md5(hash_str: &str) -> Vec<u8> {
    if hash_str.len() >= 32 {
        let mut bytes = Vec::with_capacity(16);
        let hex_slice = &hash_str[..32];
        let mut chars = hex_slice.chars();
        while let (Some(c1), Some(c2)) = (chars.next(), chars.next()) {
            if let Ok(b) = u8::from_str_radix(&format!("{c1}{c2}"), 16) {
                bytes.push(b);
            } else {
                break;
            }
        }
        if bytes.len() == 16 {
            return bytes;
        }
    }

    // 降级兜底：提取字节前 16 字节填充
    let mut fallback = vec![0u8; 16];
    for (i, &b) in hash_str.as_bytes().iter().take(16).enumerate() {
        fallback[i] = b;
    }
    fallback
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

        // 1. 编码安装准备请求: WearPacket(type=20, id=1, ThirdpartyApp.install_request)
        let req_pb = encode_install_request(
            &metadata.package_id,
            metadata.version_code,
            metadata.file_size as u32,
        )?;
        let l2_pkt = L2Packet::pb_write(req_pb);
        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: l2_pkt.to_bytes(),
        };

        // 2. 发送帧
        device_transport.send_frame(&frame)?;

        // 3. 等待设备响应 AppInstallerResponse
        let resp_frame = device_transport
            .receive_frame(5000)?
            .ok_or_else(|| "等待设备 AppInstallerResponse 超时 (timeout)".to_string())?;

        let resp = decode_install_response(&resp_frame.payload)?;
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
        self.md5 = parse_or_derive_md5(&metadata.hash);

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

        // 1. 如果是首个分片且尚未发起 Mass Prepare，先发起 Mass Prepare
        if !self.mass_prepared {
            let metadata = self.metadata.as_ref().ok_or("缺少安装元数据")?;
            let mass_prep_pb =
                encode_mass_prepare(&vec![0u8; metadata.file_size as usize], &self.md5)?;
            let l2_prep = L2Packet::pb_write(mass_prep_pb);
            let frame = Frame {
                frame_type: 0x03,
                seq: self.next_seq(),
                payload: l2_prep.to_bytes(),
            };
            device_transport.send_frame(&frame)?;
            self.mass_prepared = true;
        }

        // 2. 构造 Mass Chunk (total_parts, current_part 1-indexed, fragment)
        let total_parts = self.total_chunks.max(1) as u16;
        let current_part = (chunk.index + 1) as u16;
        let chunk_l2_bytes = encode_mass_chunk(total_parts, current_part, &chunk.data)?;

        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: chunk_l2_bytes,
        };
        device_transport.send_frame(&frame)?;

        self.sent_chunks += 1;
        self.total_sent_bytes += chunk.size as u64;

        // 3. 若所有分片传输完毕，状态流转为 waiting_device_result
        if self.sent_chunks >= self.total_chunks {
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

        // 监听设备响应: 期望 WearPacket(type=20, id=2) AppInstaller.Result
        let resp_frame = match device_transport.receive_frame(5000)? {
            Some(f) => f,
            None => {
                // 超时无设备上报：保持在 waiting_device_result 状态
                self.state = XiaomiInstallState::WaitingDeviceResult;
                return Ok(InstallResult {
                    status: XiaomiInstallState::WaitingDeviceResult.as_str().to_string(),
                });
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
                let l2 = L2Packet::pb_write(wp.encode());
                let frame = Frame {
                    frame_type: 0x03,
                    seq: self.next_seq(),
                    payload: l2.to_bytes(),
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
        Ok(())
    }
}
