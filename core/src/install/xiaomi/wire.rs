//! 内部基础 Protobuf Wire Format 序列化与反序列化工具 (Internal Wire Codec)

use super::super::model::Result;

pub const WIRE_VARINT: u8 = 0;
pub const WIRE_FIXED64: u8 = 1;
pub const WIRE_LENGTH_DELIMITED: u8 = 2;
pub const WIRE_FIXED32: u8 = 5;

pub fn write_varint(buf: &mut Vec<u8>, mut val: u64) {
    while val >= 0x80 {
        buf.push(((val & 0x7F) as u8) | 0x80);
        val >>= 7;
    }
    buf.push((val & 0x7F) as u8);
}

pub fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if i >= 10 {
            return None;
        }
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((result, i + 1));
        }
        shift += 7;
    }
    None
}

pub fn write_tag(buf: &mut Vec<u8>, field_num: u32, wire_type: u8) {
    write_varint(buf, ((field_num as u64) << 3) | (wire_type as u64 & 0x7));
}

pub fn write_bytes_field(buf: &mut Vec<u8>, field_num: u32, data: &[u8]) {
    write_tag(buf, field_num, WIRE_LENGTH_DELIMITED);
    write_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

pub fn write_string_field(buf: &mut Vec<u8>, field_num: u32, s: &str) {
    write_bytes_field(buf, field_num, s.as_bytes());
}

pub fn write_u32_field(buf: &mut Vec<u8>, field_num: u32, val: u32) {
    write_tag(buf, field_num, WIRE_VARINT);
    write_varint(buf, val as u64);
}

#[allow(dead_code)]
pub fn write_u64_field(buf: &mut Vec<u8>, field_num: u32, val: u64) {
    write_tag(buf, field_num, WIRE_VARINT);
    write_varint(buf, val);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireValue<'a> {
    Varint(u64),
    Fixed64(u64),
    LengthDelimited(&'a [u8]),
    Fixed32(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireField<'a> {
    pub tag: u32,
    pub wire_type: u8,
    pub value: WireValue<'a>,
}

pub fn parse_fields(bytes: &[u8]) -> Result<Vec<WireField<'_>>> {
    let mut fields = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let (key, read) = read_varint(&bytes[offset..])
            .ok_or_else(|| "截断或非法的 Protobuf Key Varint".to_string())?;
        offset += read;
        let tag = (key >> 3) as u32;
        let wire_type = (key & 0x7) as u8;
        match wire_type {
            WIRE_VARINT => {
                let (val, read_val) = read_varint(&bytes[offset..])
                    .ok_or_else(|| format!("截断的 Varint 载荷 (tag={tag})"))?;
                offset += read_val;
                fields.push(WireField {
                    tag,
                    wire_type,
                    value: WireValue::Varint(val),
                });
            }
            WIRE_FIXED64 => {
                if offset + 8 > bytes.len() {
                    return Err(format!("截断的 Fixed64 载荷 (tag={tag})"));
                }
                let mut b = [0u8; 8];
                b.copy_from_slice(&bytes[offset..offset + 8]);
                offset += 8;
                fields.push(WireField {
                    tag,
                    wire_type,
                    value: WireValue::Fixed64(u64::from_le_bytes(b)),
                });
            }
            WIRE_LENGTH_DELIMITED => {
                let (len, read_len) = read_varint(&bytes[offset..])
                    .ok_or_else(|| format!("截断的 Length-delimited 长度 (tag={tag})"))?;
                offset += read_len;
                let len = len as usize;
                if offset + len > bytes.len() {
                    return Err(format!(
                        "截断的 Length-delimited 载荷: 声明 {len} 字节，实际剩余 {} 字节 (tag={tag})",
                        bytes.len() - offset
                    ));
                }
                let slice = &bytes[offset..offset + len];
                offset += len;
                fields.push(WireField {
                    tag,
                    wire_type,
                    value: WireValue::LengthDelimited(slice),
                });
            }
            WIRE_FIXED32 => {
                if offset + 4 > bytes.len() {
                    return Err(format!("截断的 Fixed32 载荷 (tag={tag})"));
                }
                let mut b = [0u8; 4];
                b.copy_from_slice(&bytes[offset..offset + 4]);
                offset += 4;
                fields.push(WireField {
                    tag,
                    wire_type,
                    value: WireValue::Fixed32(u32::from_le_bytes(b)),
                });
            }
            other => {
                return Err(format!("不支持或非法的 WireType: {other} (tag={tag})"));
            }
        }
    }
    Ok(fields)
}
