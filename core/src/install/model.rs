//! 快应用安装数据模型契约 (App Install Models)

use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

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

/// 快应用传输层运行模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    Mock,
    Device,
}
