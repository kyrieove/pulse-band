//! 基于回放与预期断言的设备通信传输层 (Replay Transport & Assertions)

use std::collections::VecDeque;
use serde::{Deserialize, Serialize};
use crate::frame::Frame;
use super::inspector::hex_to_bytes;
use super::model::Result;
use super::recorder::{InstallProtocolRecorder, PacketDirection};
use super::transport::BandDeviceTransport;

/// 计算载荷的 SHA-256 哈希 Hex 字符串
pub fn compute_payload_sha256(payload: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(payload);
    format!("{:x}", hasher.finalize())
}

/// 预期的下行数据帧断言契约
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedFrameAssertion {
    pub frame_type: u8,
    pub seq: Option<u8>,
    pub payload_hash: Option<String>,
}

/// 基于回放与捕获的设备传输实现
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct MockDeviceReplayTransport {
    pub connected: bool,
    pub target_addr: Option<String>,
    pub rx_replay_queue: VecDeque<Frame>,
    pub tx_sent_frames: Vec<Frame>,
    pub expected_tx_frames: VecDeque<Frame>,
    pub expected_assertions: Vec<ExpectedFrameAssertion>,
    pub recorder: Option<InstallProtocolRecorder>,
}

#[allow(dead_code)]
impl MockDeviceReplayTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_recorder(recorder: InstallProtocolRecorder) -> Self {
        Self {
            connected: false,
            target_addr: None,
            rx_replay_queue: VecDeque::new(),
            tx_sent_frames: Vec::new(),
            expected_tx_frames: VecDeque::new(),
            expected_assertions: Vec::new(),
            recorder: Some(recorder),
        }
    }

    /// 设定预期的发送帧断言（用于验证发送顺序、frame_type 与 payload hash）
    pub fn expect_frame(
        &mut self,
        frame_type: u8,
        seq: Option<u8>,
        payload_hash: Option<&str>,
    ) {
        self.expected_assertions.push(ExpectedFrameAssertion {
            frame_type,
            seq,
            payload_hash: payload_hash.map(|s| s.to_string()),
        });
    }

    /// 验证实际发送的帧是否完全满足预期的顺序、类型与哈希契约
    pub fn verify_expected_frames(&self) -> Result<()> {
        if self.tx_sent_frames.len() != self.expected_assertions.len() {
            return Err(format!(
                "断言失败: 发送帧总数不匹配: 期望 {} 帧，实际发送 {} 帧",
                self.expected_assertions.len(),
                self.tx_sent_frames.len()
            ));
        }

        for (i, (expected, actual)) in self
            .expected_assertions
            .iter()
            .zip(self.tx_sent_frames.iter())
            .enumerate()
        {
            if actual.frame_type != expected.frame_type {
                return Err(format!(
                    "断言失败: 第 {i} 帧 frame_type 不匹配: 期望 0x{:02x}，实际 0x{:02x}",
                    expected.frame_type, actual.frame_type
                ));
            }
            if let Some(exp_seq) = expected.seq {
                if actual.seq != exp_seq {
                    return Err(format!(
                        "断言失败: 第 {i} 帧 seq 不匹配: 期望 {}，实际 {}",
                        exp_seq, actual.seq
                    ));
                }
            }
            if let Some(exp_hash) = &expected.payload_hash {
                let actual_hash = compute_payload_sha256(&actual.payload);
                if &actual_hash != exp_hash {
                    return Err(format!(
                        "断言失败: 第 {i} 帧 payload hash 不匹配: 期望 {}，实际 {}",
                        exp_hash, actual_hash
                    ));
                }
            }
        }
        Ok(())
    }

    /// 从录制器中加载回放流（筛选手环发往主机的数据帧作为 rx 队列）
    pub fn load_from_recorder(&mut self, recorder: &InstallProtocolRecorder) {
        for p in &recorder.packets {
            if p.direction == PacketDirection::BandToHost {
                if let Ok(payload) = hex_to_bytes(&p.payload_hex) {
                    self.rx_replay_queue.push_back(Frame {
                        frame_type: p.frame_type,
                        seq: p.seq,
                        payload,
                    });
                }
            }
        }
    }

    /// 从录制器中加载期望的下发流（筛选主机发往手环的数据帧作为 tx 预期断言队列）
    pub fn load_expected_tx(&mut self, recorder: &InstallProtocolRecorder) {
        for p in &recorder.packets {
            if p.direction == PacketDirection::HostToBand {
                if let Ok(payload) = hex_to_bytes(&p.payload_hex) {
                    self.expected_tx_frames.push_back(Frame {
                        frame_type: p.frame_type,
                        seq: p.seq,
                        payload,
                    });
                }
            }
        }
    }

    pub fn queue_rx_frame(&mut self, frame: Frame) {
        self.rx_replay_queue.push_back(frame);
    }
}

impl BandDeviceTransport for MockDeviceReplayTransport {
    fn connect(&mut self, target_addr: &str) -> Result<()> {
        self.connected = true;
        self.target_addr = Some(target_addr.to_string());
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        self.connected = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn send_frame(&mut self, frame: &Frame) -> Result<()> {
        if !self.connected {
            return Err("device_not_connected: 底层设备未连接".to_string());
        }
        if let Some(recorder) = self.recorder.as_mut() {
            recorder.record_tx(frame);
        }
        self.tx_sent_frames.push(frame.clone());
        Ok(())
    }

    fn receive_frame(&mut self, _timeout_ms: u64) -> Result<Option<Frame>> {
        if !self.connected {
            return Err("device_not_connected: 底层设备未连接".to_string());
        }
        if let Some(frame) = self.rx_replay_queue.pop_front() {
            if let Some(recorder) = self.recorder.as_mut() {
                recorder.record_rx(&frame);
            }
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }
}
