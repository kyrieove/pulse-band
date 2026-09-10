//! 快应用安装协议报文审计与深度检测 (Protocol Inspector)

use serde::{Deserialize, Serialize};
use crate::frame::Frame;
use super::model::Result;

/// 协议分析输出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameInspection {
    pub magic_valid: bool,
    pub frame_type: u8,
    pub frame_type_desc: String,
    pub seq: u8,
    pub payload_len: usize,
    pub payload_hex: String,
    pub crc_expected: u16,
    pub crc_actual: u16,
    pub crc_valid: bool,
    pub protobuf_attempt: ProtobufInspection,
}

/// Protobuf 解析尝试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtobufInspection {
    pub success: bool,
    pub fields_count: usize,
    pub field_tags: Vec<u32>,
    pub note: String,
}

/// 协议分析工具：用于对捕获的原始字节与数据帧进行结构解析与有效性审计
#[allow(dead_code)]
pub struct ProtocolInspector;

#[allow(dead_code)]
impl ProtocolInspector {
    /// 分析已解析的 Frame 结构体
    pub fn inspect_frame(frame: &Frame) -> FrameInspection {
        let crc_actual = crate::crc::crc16_arc(&frame.payload);
        let payload_hex = frame
            .payload
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join("");
        let frame_type_desc = match frame.frame_type {
            0x01 => "ACK".to_string(),
            0x02 => "Negotiation".to_string(),
            0x03 => "Business/Auth".to_string(),
            other => format!("Unknown(0x{other:02x})"),
        };
        let protobuf_attempt = Self::try_inspect_protobuf(&frame.payload);

        FrameInspection {
            magic_valid: true,
            frame_type: frame.frame_type,
            frame_type_desc,
            seq: frame.seq,
            payload_len: frame.payload.len(),
            payload_hex,
            crc_expected: crc_actual,
            crc_actual,
            crc_valid: true,
            protobuf_attempt,
        }
    }

    /// 分析原始二进制字节流（包含 Magic 字节与 CRC 头部校验）
    pub fn inspect_raw_bytes(bytes: &[u8]) -> Result<FrameInspection> {
        if bytes.len() < 8 {
            return Err("数据长度不足 8 字节最小帧头".to_string());
        }
        let magic_valid = bytes[0] == 0xA5 && bytes[1] == 0xA5;
        if !magic_valid {
            return Err(format!(
                "Magic 无效: 0x{:02x}{:02x} (期望 0xa5a5)",
                bytes[0], bytes[1]
            ));
        }
        let frame_type = bytes[2];
        let seq = bytes[3];
        let len = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        let crc_expected = u16::from_le_bytes([bytes[6], bytes[7]]);

        if bytes.len() < 8 + len {
            return Err(format!("帧载荷截断: 期望 {len} 字节，实际剩余 {} 字节", bytes.len() - 8));
        }

        let payload = &bytes[8..8 + len];
        let crc_actual = crate::crc::crc16_arc(payload);
        let crc_valid = crc_actual == crc_expected;

        let frame = Frame {
            frame_type,
            seq,
            payload: payload.to_vec(),
        };

        let mut inspection = Self::inspect_frame(&frame);
        inspection.crc_expected = crc_expected;
        inspection.crc_actual = crc_actual;
        inspection.crc_valid = crc_valid;
        Ok(inspection)
    }

    /// 尝试按 Protobuf wire format 进行格式探测
    pub fn try_inspect_protobuf(payload: &[u8]) -> ProtobufInspection {
        if payload.is_empty() {
            return ProtobufInspection {
                success: false,
                fields_count: 0,
                field_tags: Vec::new(),
                note: "载荷为空".to_string(),
            };
        }

        let mut offset = 0;
        let mut field_tags = Vec::new();

        while offset < payload.len() {
            // 读取 key varint
            let (key, bytes_read) = match read_varint(&payload[offset..]) {
                Some(res) => res,
                None => {
                    return ProtobufInspection {
                        success: false,
                        fields_count: field_tags.len(),
                        field_tags,
                        note: "读取 Key Varint 失败或截断".to_string(),
                    }
                }
            };
            offset += bytes_read;

            let wire_type = (key & 0x07) as u8;
            let field_number = (key >> 3) as u32;

            if field_number == 0 {
                return ProtobufInspection {
                    success: false,
                    fields_count: field_tags.len(),
                    field_tags,
                    note: "非法 Protobuf 字段序号 0".to_string(),
                };
            }

            field_tags.push(field_number);

            match wire_type {
                0 => {
                    // Varint
                    match read_varint(&payload[offset..]) {
                        Some((_, v_read)) => offset += v_read,
                        None => {
                            return ProtobufInspection {
                                success: false,
                                fields_count: field_tags.len(),
                                field_tags,
                                note: "Varint 字段截断".to_string(),
                            }
                        }
                    }
                }
                1 => {
                    // 64-bit
                    if offset + 8 > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "64-bit 字段数据不足".to_string(),
                        };
                    }
                    offset += 8;
                }
                2 => {
                    // Length-delimited
                    let (len, len_read) = match read_varint(&payload[offset..]) {
                        Some(res) => res,
                        None => {
                            return ProtobufInspection {
                                success: false,
                                fields_count: field_tags.len(),
                                field_tags,
                                note: "读取 Length-delimited 长度失败".to_string(),
                            }
                        }
                    };
                    offset += len_read;
                    let len = len as usize;
                    if offset + len > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "Length-delimited 载荷截断".to_string(),
                        };
                    }
                    offset += len;
                }
                5 => {
                    // 32-bit
                    if offset + 4 > payload.len() {
                        return ProtobufInspection {
                            success: false,
                            fields_count: field_tags.len(),
                            field_tags,
                            note: "32-bit 字段数据不足".to_string(),
                        };
                    }
                    offset += 4;
                }
                other => {
                    return ProtobufInspection {
                        success: false,
                        fields_count: field_tags.len(),
                        field_tags,
                        note: format!("遇到不支持或非法的 Protobuf WireType: {other}"),
                    };
                }
            }
        }

        ProtobufInspection {
            success: true,
            fields_count: field_tags.len(),
            field_tags: field_tags.clone(),
            note: format!("成功解析为有效 Protobuf Wire 格式 ({} 个字段)", field_tags.len()),
        }
    }
}

pub(crate) fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut val = 0u64;
    let mut shift = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if i >= 10 {
            return None; // varint 溢出
        }
        val |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Some((val, i + 1));
        }
        shift += 7;
    }
    None
}

/// 将十六进制字符串解析为原始字节数组
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return Err("Hex 字符串长度必须为偶数".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|e| format!("解析 Hex 字节失败: {e}"))
        })
        .collect()
}
