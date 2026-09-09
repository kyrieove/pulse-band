//! 快应用安装协议类型契约（阶段契约：仅定义类型与接口边界）
//!
//! 纪律要求：
//! - 禁止实际读取文件
//! - 禁止实际传输
//! - 禁止蓝牙调用与设备通信

use std::time::Instant;
use serde::{Deserialize, Serialize};

/// 快应用安装会话状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Idle,
    Preparing,
    Transferring,
    Installing,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

/// 快应用安装会话模型（内存抽象，不持有任何硬件或文件句柄）
#[derive(Debug, Clone)]
pub struct InstallSession {
    pub id: String,
    pub status: InstallStatus,
    pub file_size: usize,
    pub received_bytes: usize,
    pub created_at: Instant,
}
