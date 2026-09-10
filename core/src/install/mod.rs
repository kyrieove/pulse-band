//! 快应用安装协议与分析基础设施模块 (App Install Protocol & Analysis Subsystem)
//!
//! 模块划分：
//! - `model`: 数据模型与返回契约 (InstallMetadata, InstallChunk, ChunkAck, Session, Mode)
//! - `transport`: 安装传输层与设备抽象 (AppInstallTransport, BandDeviceTransport, XiaomiBand10Transport, Dispatcher)
//! - `protocol`: 安装业务协议状态机抽象 (AppInstallProtocol, MockAppInstallProtocol)
//! - `recorder`: 双向数据帧录制与序列化 (InstallProtocolRecorder, RecordedPacket)
//! - `replay`: 数据帧回放传输与预期断言 (MockDeviceReplayTransport, ExpectedFrameAssertion)
//! - `inspector`: 原始数据帧与 Protobuf 深度检测 (ProtocolInspector, FrameInspection)
//! - `report`: 取证报告生成器 (ProtocolReportGenerator)
//! - `pipeline`: 样本导入与端到端取证分析管线 (CaptureLoader, ProtocolAnalysisPipeline)

pub mod model;
pub mod protocol;
pub mod transport;
pub mod recorder;
pub mod inspector;
pub mod replay;
pub mod report;
pub mod pipeline;
pub mod xiaomi;

#[allow(unused_imports)]
pub use model::*;
pub use protocol::*;
pub use transport::*;
pub use recorder::*;
pub use inspector::*;
pub use replay::*;
pub use report::*;
#[allow(unused_imports)]
pub use pipeline::*;
#[allow(unused_imports)]
pub use xiaomi::*;
