//! 快应用安装协议契约与传输抽象层 (App Install Transport Abstraction)
//!
//! 纪律要求：
//! - trait 只定义抽象接口
//! - 禁止蓝牙通信实现
//! - 禁止真实手环连接或修改设备协议
//! - 阶段状态仅允许 preparing / transferring / verifying / cancelled，禁止 completed 伪状态

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

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

/// 全局 Mock 传输实例（受互斥锁保护）
#[allow(dead_code)]
pub static GLOBAL_INSTALL_TRANSPORT: Mutex<MockAppInstallTransport> =
    Mutex::new(MockAppInstallTransport::new());
