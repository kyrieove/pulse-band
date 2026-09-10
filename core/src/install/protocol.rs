//! 快应用安装业务协议抽象 (App Install Protocol)

use super::model::{ChunkAck, InstallChunk, InstallMetadata, InstallResult, InstallSession, Result};
use super::transport::BandDeviceTransport;

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

    fn wait_install_result(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult>;

    fn cancel_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<()>;

    /// 兼容接口：向后兼容旧的 commit_install 调用
    fn commit_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult> {
        self.wait_install_result(device_transport, session_id)
    }

    /// 兼容接口：向后兼容旧的 verify_package 调用
    fn verify_package(
        &mut self,
        _device_transport: &mut dyn BandDeviceTransport,
        _session_id: &str,
    ) -> Result<()> {
        Ok(())
    }
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

    fn wait_install_result(
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
        // 严格状态限制：只能返回 verifying / waiting_device_result，禁止 completed / installed
        Ok(InstallResult {
            status: "verifying".to_string(),
        })
    }

    fn commit_install(
        &mut self,
        device_transport: &mut dyn BandDeviceTransport,
        session_id: &str,
    ) -> Result<InstallResult> {
        self.wait_install_result(device_transport, session_id)
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
