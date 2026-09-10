//! 小米手环快应用安装协议编解码基础设施 (Xiaomi Install Protocol Codec Subsystem)
//!
//! 模块划分：
//! - `wire`: 内部通用 Protobuf Wire 格式编解码辅助
//! - `l2`: L2 报文通道与操作码定义
//! - `thirdparty_app`: ThirdpartyApp 与 AppInstaller 消息模型
//! - `mass`: Mass 传输协议报文与 CRC32 计算模型
//! - `wear_packet`: WearPacket 顶层封装与分发
//! - `codec`: 统一协议编解码入口

pub mod wire;
pub mod l2;
pub mod thirdparty_app;
pub mod mass;
pub mod wear_packet;
pub mod codec;
pub mod protocol;
pub mod device_session;
pub mod runtime_bridge;

pub use l2::*;
pub use thirdparty_app::*;
pub use mass::*;
pub use wear_packet::*;
pub use codec::*;
pub use protocol::*;
pub use device_session::*;
pub use runtime_bridge::*;

use serde::{Deserialize, Serialize};

/// 小米安装协议状态机状态枚举
///
/// 纪律要求：
/// - 状态流转只允许：preparing -> transferring -> waiting_device_result -> success/failure
/// - 严禁包含 completed / installed 假成功状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum XiaomiInstallState {
    Preparing,
    Transferring,
    WaitingDeviceResult,
    Success,
    Failure,
}

impl XiaomiInstallState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Transferring => "transferring",
            Self::WaitingDeviceResult => "waiting_device_result",
            Self::Success => "success",
            Self::Failure => "failure",
        }
    }
}
