//! 传输层帧编解码器（阶段 2 实证结果驱动实现）
//!
//! 帧布局（来自 docs/protocol/transport.md §1~§4）：
//! `A5 A5 | frame_type(1) | seq(1) | len(2 LE) | crc(2 LE) | payload(len)`
//!
//! 已实证规则：
//! - magic 固定为 0xA5, 0xA5
//! - frame_type 实测取值：0x01 (ACK), 0x02 (链路协商), 0x03 (业务/握手数据)
//! - seq：单字节序号，按方向和类型独立递增或回显
//! - len：2 字节小端序，表示载荷字节数
//! - crc：2 字节小端序，对 payload 计算的标准 CRC-16/ARC
//!
//! 未实现/仍是假设项（留 TODO 说明）：
//! - TODO: type=0x02 的 TLV 内部字段切分（因两次抓包参数恒定未发生变化，待多设备比对）
//! - TODO: type=0x03 载荷内部具体 Protobuf/加密结构（留待阶段 5/6 上层协议接入）

use crate::crc::crc16_arc;

/// 传输层数据帧抽象
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// 帧类型：0x01 (ACK), 0x02 (协商), 0x03 (数据)
    pub frame_type: u8,
    /// 序号
    pub seq: u8,
    /// 载荷数据
    pub payload: Vec<u8>,
}

/// 解码错误类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// 数据不足一个完整帧（半包），需继续接收
    Incomplete,
    /// 帧首 Magic 字节错误（非 A5 A5）
    InvalidMagic,
    /// 未知帧类型（非 0x01, 0x02, 0x03）
    UnknownType(u8),
    /// CRC-16/ARC 校验失败
    CrcMismatch,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Incomplete => write!(f, "帧数据不完整（需要更多数据）"),
            DecodeError::InvalidMagic => write!(f, "帧起始 Magic 错误（非 0xA5, 0xA5）"),
            DecodeError::UnknownType(t) => write!(f, "未知帧类型: 0x{t:02x}"),
            DecodeError::CrcMismatch => write!(f, "CRC-16/ARC 校验和不匹配"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// 将 Frame 编码为二进制字节序列
///
/// 格式: `A5 A5 | frame_type | seq | len(2B LE) | crc(2B LE) | payload`
pub fn encode(frame: &Frame) -> Vec<u8> {
    let len = frame.payload.len() as u16;
    let crc = crc16_arc(&frame.payload);
    let mut buf = Vec::with_capacity(8 + frame.payload.len());
    buf.push(0xA5);
    buf.push(0xA5);
    buf.push(frame.frame_type);
    buf.push(frame.seq);
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(&crc.to_le_bytes());
    buf.extend_from_slice(&frame.payload);
    buf
}

/// 从字节缓冲区解码出首个完整 Frame，并返回已消耗的字节数
///
/// 支持粘包（返回已消耗字节以便后续帧解析）和半包（返回 Incomplete）
pub fn decode(buf: &[u8]) -> Result<(Frame, usize), DecodeError> {
    if buf.len() < 2 {
        return Err(DecodeError::Incomplete);
    }
    if buf[0] != 0xA5 || buf[1] != 0xA5 {
        return Err(DecodeError::InvalidMagic);
    }
    if buf.len() < 8 {
        return Err(DecodeError::Incomplete);
    }

    let frame_type = buf[2];
    // 只实现实证已确认的帧类型：0x01, 0x02, 0x03
    if frame_type != 0x01 && frame_type != 0x02 && frame_type != 0x03 {
        return Err(DecodeError::UnknownType(frame_type));
    }

    let seq = buf[3];
    let len = u16::from_le_bytes([buf[4], buf[5]]) as usize;
    let chk = u16::from_le_bytes([buf[6], buf[7]]);
    let total_len = 8 + len;

    if buf.len() < total_len {
        return Err(DecodeError::Incomplete);
    }

    let payload = &buf[8..total_len];
    if crc16_arc(payload) != chk {
        return Err(DecodeError::CrcMismatch);
    }

    Ok((
        Frame {
            frame_type,
            seq,
            payload: payload.to_vec(),
        },
        total_len,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1. 真实帧向量测试（必做，用阶段 2 留下的两个真实帧测试向量）
    #[test]
    fn test_decode_real_frame_type02() {
        let raw = include_bytes!("../tests/fixtures/frame-type02-2026-09-08.bin");
        let (frame, consumed) = decode(raw).expect("decode failed");
        assert_eq!(consumed, 30);
        assert_eq!(frame.frame_type, 0x02);
        assert_eq!(frame.seq, 0x00);
        assert_eq!(frame.payload.len(), 22);
        // 预期载荷前 4 字节（从 transport.md §7 抄）：
        assert_eq!(&frame.payload[..4], &[0x01, 0x01, 0x03, 0x00]);
    }

    #[test]
    fn test_decode_real_frame_type03() {
        let raw = include_bytes!("../tests/fixtures/frame-type03-2026-09-08-02.bin");
        let (frame, consumed) = decode(raw).expect("decode failed");
        assert_eq!(consumed, 16);
        assert_eq!(frame.frame_type, 0x03);
        assert_eq!(frame.seq, 0x06);
        assert_eq!(
            frame.payload,
            vec![0x01, 0x02, 0x8d, 0xbd, 0x4d, 0xa7, 0xa0, 0xdf]
        );
    }

    // 2. Round-trip 测试
    #[test]
    fn test_roundtrip() {
        let orig = Frame {
            frame_type: 0x03,
            seq: 0x05,
            payload: vec![0xAA, 0xBB, 0xCC],
        };
        let encoded = encode(&orig);
        let (decoded, consumed) = decode(&encoded).unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded, orig);
    }

    // 3. 校验错误的帧被拒绝
    #[test]
    fn test_crc_mismatch() {
        let mut bad = encode(&Frame {
            frame_type: 0x01,
            seq: 0x00,
            payload: vec![],
        });
        bad[6] ^= 0xFF; // 破坏 CRC 字段
        assert!(matches!(decode(&bad), Err(DecodeError::CrcMismatch)));
    }

    // 4. 半包测试
    #[test]
    fn test_incomplete() {
        let full = encode(&Frame {
            frame_type: 0x03,
            seq: 0x01,
            payload: vec![0x11, 0x22],
        });
        let half = &full[..5]; // 只给头 5 字节
        assert!(matches!(decode(half), Err(DecodeError::Incomplete)));
    }

    // 5. 粘包测试
    #[test]
    fn test_multiple_frames() {
        let f1 = encode(&Frame {
            frame_type: 0x01,
            seq: 0x00,
            payload: vec![],
        });
        let f2 = encode(&Frame {
            frame_type: 0x03,
            seq: 0x01,
            payload: vec![0xAA],
        });
        let mut buf = f1.clone();
        buf.extend_from_slice(&f2);

        let (frame1, consumed1) = decode(&buf).unwrap();
        assert_eq!(consumed1, f1.len());
        assert_eq!(frame1.frame_type, 0x01);

        let (frame2, consumed2) = decode(&buf[consumed1..]).unwrap();
        assert_eq!(consumed2, f2.len());
        assert_eq!(frame2.frame_type, 0x03);
        assert_eq!(frame2.payload, vec![0xAA]);
    }

    #[test]
    fn test_unknown_type() {
        let mut raw = encode(&Frame {
            frame_type: 0x01,
            seq: 0x00,
            payload: vec![],
        });
        raw[2] = 0x99; // 未知类型
        assert_eq!(decode(&raw), Err(DecodeError::UnknownType(0x99)));
    }

    #[test]
    fn test_invalid_magic() {
        let mut raw = encode(&Frame {
            frame_type: 0x01,
            seq: 0x00,
            payload: vec![],
        });
        raw[0] = 0x00; // 破坏 magic
        assert_eq!(decode(&raw), Err(DecodeError::InvalidMagic));
    }
}
