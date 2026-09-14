//! L2 数据包通道与操作码模型 (L2 Packet & Channel Framing)
//!
//! 依据源码证据：
//! - `wear_l2_packet (L2Packet Framing)`

use super::super::model::Result;

/// L2 通道标识
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum L2Channel {
    Pb = 1,
    Mass = 2,
    MassVoice = 3,
    FileSensor = 4,
    FileFitness = 5,
    Ota = 6,
    Network = 7,
    Lyra = 8,
    Research = 9,
    MultiModal = 10,
}

impl L2Channel {
    pub fn from_u8(val: u8) -> Result<Self> {
        match val {
            1 => Ok(Self::Pb),
            2 => Ok(Self::Mass),
            3 => Ok(Self::MassVoice),
            4 => Ok(Self::FileSensor),
            5 => Ok(Self::FileFitness),
            6 => Ok(Self::Ota),
            7 => Ok(Self::Network),
            8 => Ok(Self::Lyra),
            9 => Ok(Self::Research),
            10 => Ok(Self::MultiModal),
            other => Err(format!("无效的 L2 Channel: {other}")),
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// L2 操作码
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum L2OpCode {
    Write = 1,
    WriteEnc = 2,
    Read = 3,
}

impl L2OpCode {
    pub fn from_u8(val: u8) -> Result<Self> {
        match val {
            1 => Ok(Self::Write),
            2 => Ok(Self::WriteEnc),
            3 => Ok(Self::Read),
            other => Err(format!("无效的 L2 OpCode: {other}")),
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// L2 数据包结构
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct L2Packet {
    pub channel: L2Channel,
    pub opcode: L2OpCode,
    pub payload: Vec<u8>,
}

#[allow(dead_code)]
impl L2Packet {
    pub fn new(channel: L2Channel, opcode: L2OpCode, payload: Vec<u8>) -> Self {
        Self {
            channel,
            opcode,
            payload,
        }
    }

    pub fn pb_write(payload: Vec<u8>) -> Self {
        Self {
            channel: L2Channel::Pb,
            opcode: L2OpCode::Write,
            payload,
        }
    }

    pub fn mass_write(payload: Vec<u8>) -> Self {
        Self {
            channel: L2Channel::Mass,
            opcode: L2OpCode::Write,
            payload,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(2 + self.payload.len());
        out.push(self.channel.as_u8());
        out.push(self.opcode.as_u8());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 2 {
            return Err(format!("L2 数据包长度不足 2 字节: 实际 {} 字节", bytes.len()));
        }
        let channel = L2Channel::from_u8(bytes[0])?;
        let opcode = L2OpCode::from_u8(bytes[1])?;
        let payload = bytes[2..].to_vec();
        Ok(Self {
            channel,
            opcode,
            payload,
        })
    }
}
