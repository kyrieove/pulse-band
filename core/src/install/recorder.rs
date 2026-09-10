//! 快应用安装协议录制层 (Install Protocol Recorder)

use serde::{Deserialize, Serialize};
use crate::frame::Frame;
use super::model::Result;

/// 数据包传输方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketDirection {
    HostToBand,
    BandToHost,
}

/// 录制的数据帧项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedPacket {
    pub direction: PacketDirection,
    pub timestamp_ms: u64,
    pub frame_type: u8,
    pub seq: u8,
    pub len: u16,
    pub crc: u16,
    pub payload_hex: String,
}

/// 协议录制调试层：用于捕获双向数据帧并导出日志
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct InstallProtocolRecorder {
    pub packets: Vec<RecordedPacket>,
}

#[allow(dead_code)]
impl InstallProtocolRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_tx(&mut self, frame: &Frame) {
        self.record(PacketDirection::HostToBand, frame);
    }

    pub fn record_rx(&mut self, frame: &Frame) {
        self.record(PacketDirection::BandToHost, frame);
    }

    pub fn record(&mut self, direction: PacketDirection, frame: &Frame) {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let crc = crate::crc::crc16_arc(&frame.payload);
        let payload_hex = frame
            .payload
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join("");
        self.packets.push(RecordedPacket {
            direction,
            timestamp_ms,
            frame_type: frame.frame_type,
            seq: frame.seq,
            len: frame.payload.len() as u16,
            crc,
            payload_hex,
        });
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(&self.packets)
            .map_err(|e| format!("序列化录制记录失败: {e}"))
    }

    pub fn from_json(json: &str) -> Result<Self> {
        let packets: Vec<RecordedPacket> =
            serde_json::from_str(json).map_err(|e| format!("反序列化录制记录失败: {e}"))?;
        Ok(Self { packets })
    }

    pub fn clear(&mut self) {
        self.packets.clear();
    }
}
