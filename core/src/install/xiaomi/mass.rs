//! 小米 Mass 传输数据模型与报文装配
//!
//! 依据源码证据：
//! - `wear_mass.proto`
//! - `wear_mass_packet (MassPacket)`
//! - `wear_mass_transfer (MassTransferPipeline)`

use super::super::model::Result;
use super::wire::*;

/// Mass 数据类型 (RPK 快应用使用 64)
pub const MASS_DATA_TYPE_THIRDPARTY_APP: u32 = 64;

/// Mass.PrepareRequest
///
/// 字段：
/// - tag 1: required uint32 data_type
/// - tag 2: required bytes data_id (16-byte MD5)
/// - tag 3: required uint32 data_length
/// - tag 4: optional uint32 support_compress_mode
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareRequest {
    pub data_type: u32,
    pub data_id: Vec<u8>,
    pub data_length: u32,
    pub support_compress_mode: Option<u32>,
}

impl PrepareRequest {
    pub fn new(data_type: u32, data_id: Vec<u8>, data_length: u32) -> Self {
        Self {
            data_type,
            data_id,
            data_length,
            support_compress_mode: None,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_u32_field(&mut buf, 1, self.data_type);
        write_bytes_field(&mut buf, 2, &self.data_id);
        write_u32_field(&mut buf, 3, self.data_length);
        if let Some(mode) = self.support_compress_mode {
            write_u32_field(&mut buf, 4, mode);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut data_type = None;
        let mut data_id = None;
        let mut data_length = None;
        let mut support_compress_mode = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::Varint(v) = f.value {
                        data_type = Some(v as u32);
                    }
                }
                2 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        data_id = Some(b.to_vec());
                    }
                }
                3 => {
                    if let WireValue::Varint(v) = f.value {
                        data_length = Some(v as u32);
                    }
                }
                4 => {
                    if let WireValue::Varint(v) = f.value {
                        support_compress_mode = Some(v as u32);
                    }
                }
                _ => {}
            }
        }

        let data_type = data_type.ok_or_else(|| "缺少必填字段 data_type (tag 1)".to_string())?;
        let data_id = data_id.ok_or_else(|| "缺少必填字段 data_id (tag 2)".to_string())?;
        let data_length =
            data_length.ok_or_else(|| "缺少必填字段 data_length (tag 3)".to_string())?;

        Ok(Self {
            data_type,
            data_id,
            data_length,
            support_compress_mode,
        })
    }
}

/// Mass.PrepareResponse
///
/// 字段：
/// - tag 1: required bytes data_id
/// - tag 2: required PrepareStatus prepare_status (0=READY)
/// - tag 3: optional uint32 select_compress_mode
/// - tag 4: optional uint32 remained_data_length
/// - tag 5: optional uint32 expected_slice_length
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareResponse {
    pub data_id: Vec<u8>,
    pub prepare_status: u32,
    pub select_compress_mode: Option<u32>,
    pub remained_data_length: Option<u32>,
    pub expected_slice_length: Option<u32>,
}

impl PrepareResponse {
    pub fn is_ready(&self) -> bool {
        self.prepare_status == 0
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_bytes_field(&mut buf, 1, &self.data_id);
        write_u32_field(&mut buf, 2, self.prepare_status);
        if let Some(cm) = self.select_compress_mode {
            write_u32_field(&mut buf, 3, cm);
        }
        if let Some(rem) = self.remained_data_length {
            write_u32_field(&mut buf, 4, rem);
        }
        if let Some(sl) = self.expected_slice_length {
            write_u32_field(&mut buf, 5, sl);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut data_id = None;
        let mut prepare_status = None;
        let mut select_compress_mode = None;
        let mut remained_data_length = None;
        let mut expected_slice_length = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        data_id = Some(b.to_vec());
                    }
                }
                2 => {
                    if let WireValue::Varint(v) = f.value {
                        prepare_status = Some(v as u32);
                    }
                }
                3 => {
                    if let WireValue::Varint(v) = f.value {
                        select_compress_mode = Some(v as u32);
                    }
                }
                4 => {
                    if let WireValue::Varint(v) = f.value {
                        remained_data_length = Some(v as u32);
                    }
                }
                5 => {
                    if let WireValue::Varint(v) = f.value {
                        expected_slice_length = Some(v as u32);
                    }
                }
                _ => {}
            }
        }

        let data_id = data_id.ok_or_else(|| "缺少必填字段 data_id (tag 1)".to_string())?;
        let prepare_status =
            prepare_status.ok_or_else(|| "缺少必填字段 prepare_status (tag 2)".to_string())?;

        Ok(Self {
            data_id,
            prepare_status,
            select_compress_mode,
            remained_data_length,
            expected_slice_length,
        })
    }
}

/// MassControl 操作码
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum MassControlOp {
    Pause = 1,
    Cancel = 2,
    Error = 3,
}

impl MassControlOp {
    pub fn from_u32(val: u32) -> Result<Self> {
        match val {
            1 => Ok(Self::Pause),
            2 => Ok(Self::Cancel),
            3 => Ok(Self::Error),
            other => Err(format!("未知的 MassControlOp: {other}")),
        }
    }

    pub fn as_u32(self) -> u32 {
        self as u32
    }
}

/// Mass.MassControl
///
/// 字段：
/// - tag 1: required Op op
/// - tag 2: required uint32 data_type
/// - tag 3: required bytes data_id
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MassControl {
    pub op: MassControlOp,
    pub data_type: u32,
    pub data_id: Vec<u8>,
}

impl MassControl {
    pub fn new(op: MassControlOp, data_type: u32, data_id: Vec<u8>) -> Self {
        Self {
            op,
            data_type,
            data_id,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_u32_field(&mut buf, 1, self.op.as_u32());
        write_u32_field(&mut buf, 2, self.data_type);
        write_bytes_field(&mut buf, 3, &self.data_id);
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut op = None;
        let mut data_type = None;
        let mut data_id = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::Varint(v) = f.value {
                        op = Some(MassControlOp::from_u32(v as u32)?);
                    }
                }
                2 => {
                    if let WireValue::Varint(v) = f.value {
                        data_type = Some(v as u32);
                    }
                }
                3 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        data_id = Some(b.to_vec());
                    }
                }
                _ => {}
            }
        }

        let op = op.ok_or_else(|| "缺少必填字段 op (tag 1)".to_string())?;
        let data_type = data_type.ok_or_else(|| "缺少必填字段 data_type (tag 2)".to_string())?;
        let data_id = data_id.ok_or_else(|| "缺少必填字段 data_id (tag 3)".to_string())?;

        Ok(Self {
            op,
            data_type,
            data_id,
        })
    }
}

/// Mass 载荷变体
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MassPayload {
    PrepareRequest(PrepareRequest),   // tag 1
    PrepareResponse(PrepareResponse), // tag 2
    MassControl(MassControl),         // tag 3
    Raw(u32, Vec<u8>),
}

/// Mass 顶层结构体
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mass {
    pub payload: Option<MassPayload>,
}

#[allow(dead_code)]
impl Mass {
    pub fn from_prepare_request(req: PrepareRequest) -> Self {
        Self {
            payload: Some(MassPayload::PrepareRequest(req)),
        }
    }

    pub fn from_prepare_response(resp: PrepareResponse) -> Self {
        Self {
            payload: Some(MassPayload::PrepareResponse(resp)),
        }
    }

    pub fn from_control(ctrl: MassControl) -> Self {
        Self {
            payload: Some(MassPayload::MassControl(ctrl)),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(payload) = &self.payload {
            match payload {
                MassPayload::PrepareRequest(req) => {
                    write_bytes_field(&mut buf, 1, &req.encode());
                }
                MassPayload::PrepareResponse(resp) => {
                    write_bytes_field(&mut buf, 2, &resp.encode());
                }
                MassPayload::MassControl(ctrl) => {
                    write_bytes_field(&mut buf, 3, &ctrl.encode());
                }
                MassPayload::Raw(tag, data) => {
                    write_bytes_field(&mut buf, *tag, data);
                }
            }
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut payload = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let req = PrepareRequest::decode(b)?;
                        payload = Some(MassPayload::PrepareRequest(req));
                    }
                }
                2 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let resp = PrepareResponse::decode(b)?;
                        payload = Some(MassPayload::PrepareResponse(resp));
                    }
                }
                3 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let ctrl = MassControl::decode(b)?;
                        payload = Some(MassPayload::MassControl(ctrl));
                    }
                }
                other => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        payload = Some(MassPayload::Raw(other, b.to_vec()));
                    }
                }
            }
        }

        Ok(Self { payload })
    }
}

/// Mass 分片数据结构 (用于 Mass L2 payload)
///
/// 结构：`total_parts[u16 LE] | current_part[u16 LE] | fragment`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MassChunk {
    pub total_parts: u16,
    pub current_part: u16,
    pub fragment: Vec<u8>,
}

impl MassChunk {
    pub fn new(total_parts: u16, current_part: u16, fragment: Vec<u8>) -> Self {
        Self {
            total_parts,
            current_part,
            fragment,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.fragment.len());
        out.extend_from_slice(&self.total_parts.to_le_bytes());
        out.extend_from_slice(&self.current_part.to_le_bytes());
        out.extend_from_slice(&self.fragment);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 4 {
            return Err(format!("MassChunk 长度不足 4 字节分片头: 实际 {} 字节", bytes.len()));
        }
        let total_parts = u16::from_le_bytes([bytes[0], bytes[1]]);
        let current_part = u16::from_le_bytes([bytes[2], bytes[3]]);
        if total_parts == 0 {
            return Err("total_parts 不能为 0".to_string());
        }
        if current_part == 0 || current_part > total_parts {
            return Err(format!(
                "非法的 current_part: {current_part} (必须在 1..={total_parts} 范围内)"
            ));
        }
        let fragment = bytes[4..].to_vec();
        Ok(Self {
            total_parts,
            current_part,
            fragment,
        })
    }
}

/// Mass ACK 应答结构
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MassAck {
    pub part_num: u16,
    pub success: bool,
}

#[allow(dead_code)]
impl MassAck {
    pub fn new(part_num: u16, success: bool) -> Self {
        Self { part_num, success }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(3);
        out.extend_from_slice(&self.part_num.to_le_bytes());
        out.push(if self.success { 1 } else { 0 });
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 2 {
            return Err(format!("MassAck 载荷长度不足: 实际 {} 字节", bytes.len()));
        }
        // 如果是 L1 ACK 帧格式 (以 0xA5 0xA5 开头且长度 >= 8)
        if bytes.len() >= 8 && bytes[0] == 0xA5 && bytes[1] == 0xA5 {
            let pkt_type = bytes[2] & 0x0F;
            let seq = bytes[3];
            let success = pkt_type == 1; // 1 = ACK, 0 = NAK
            return Ok(Self {
                part_num: seq as u16,
                success,
            });
        }

        let part_num = u16::from_le_bytes([bytes[0], bytes[1]]);
        let success = if bytes.len() >= 3 {
            bytes[2] != 0
        } else {
            true
        };
        Ok(Self { part_num, success })
    }
}

/// 标准 IEEE 802.3 CRC32 计算 (多项式 0xEDB88320)
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFFFFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
    }
    crc ^ 0xFFFFFFFF
}

/// 构建 Mass 传输内层完整载荷 (带 CRC32 校验码)
///
/// 结构：`0x00 | dataType (0x40) | MD5 (16B) | file_length (u32 LE) | file_bytes | CRC32 (u32 LE)`
pub fn build_mass_inner_payload(file_data: &[u8], data_type: u32, md5: &[u8]) -> Result<Vec<u8>> {
    if md5.len() != 16 {
        return Err(format!("MD5 长度必须为 16 字节: 实际 {} 字节", md5.len()));
    }
    let mut crc_payload = Vec::with_capacity(1 + 1 + 16 + 4 + file_data.len() + 4);
    crc_payload.push(0x00);
    crc_payload.push(data_type as u8);
    crc_payload.extend_from_slice(md5);
    crc_payload.extend_from_slice(&(file_data.len() as u32).to_le_bytes());
    crc_payload.extend_from_slice(file_data);

    let crc_val = crc32(&crc_payload);
    crc_payload.extend_from_slice(&crc_val.to_le_bytes());

    Ok(crc_payload)
}

/// 校验 Mass 内层完整载荷的 CRC32 有效性
pub fn verify_mass_inner_payload(payload: &[u8]) -> Result<()> {
    if payload.len() < 26 {
        return Err(format!(
            "Mass 内层载荷长度不足 26 字节最小长度: 实际 {} 字节",
            payload.len()
        ));
    }
    let data_len = payload.len() - 4;
    let expected_crc = u32::from_le_bytes([
        payload[data_len],
        payload[data_len + 1],
        payload[data_len + 2],
        payload[data_len + 3],
    ]);
    let calculated_crc = crc32(&payload[..data_len]);
    if calculated_crc != expected_crc {
        return Err(format!(
            "Mass CRC32 校验失败: 期望 0x{expected_crc:08x}，实际计算 0x{calculated_crc:08x}"
        ));
    }
    Ok(())
}
