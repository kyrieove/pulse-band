//! 小米 WearPacket 基础报文封装与编解码
//!
//! 依据源码证据：
//! - `OronBox/protos/xiaomi/wear.proto`
//! - `AstroBox-NG-Module-Pb/protos/xiaomi/wear.proto`

use super::super::model::Result;
use super::mass::Mass;
use super::thirdparty_app::ThirdpartyApp;
use super::wire::*;

/// WearPacket 顶层类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WearPacketType {
    Other = 0,
    Account = 1,
    System = 2,
    WatchFace = 4,
    Nfc = 5,
    Notification = 7,
    Fitness = 8,
    Lpa = 9,
    Weather = 10,
    Stock = 11,
    Calendar = 12,
    Factory = 13,
    Aivs = 14,
    Market = 15,
    Gnss = 16,
    Clock = 17,
    Media = 18,
    Alexa = 19,
    ThirdpartyApp = 20,
    Contact = 21,
    Mass = 22,
    Interconnection = 23,
    Unknown(u32),
}

impl WearPacketType {
    pub fn from_u32(val: u32) -> Self {
        match val {
            0 => Self::Other,
            1 => Self::Account,
            2 => Self::System,
            4 => Self::WatchFace,
            5 => Self::Nfc,
            7 => Self::Notification,
            8 => Self::Fitness,
            9 => Self::Lpa,
            10 => Self::Weather,
            11 => Self::Stock,
            12 => Self::Calendar,
            13 => Self::Factory,
            14 => Self::Aivs,
            15 => Self::Market,
            16 => Self::Gnss,
            17 => Self::Clock,
            18 => Self::Media,
            19 => Self::Alexa,
            20 => Self::ThirdpartyApp,
            21 => Self::Contact,
            22 => Self::Mass,
            23 => Self::Interconnection,
            other => Self::Unknown(other),
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            Self::Other => 0,
            Self::Account => 1,
            Self::System => 2,
            Self::WatchFace => 4,
            Self::Nfc => 5,
            Self::Notification => 7,
            Self::Fitness => 8,
            Self::Lpa => 9,
            Self::Weather => 10,
            Self::Stock => 11,
            Self::Calendar => 12,
            Self::Factory => 13,
            Self::Aivs => 14,
            Self::Market => 15,
            Self::Gnss => 16,
            Self::Clock => 17,
            Self::Media => 18,
            Self::Alexa => 19,
            Self::ThirdpartyApp => 20,
            Self::Contact => 21,
            Self::Mass => 22,
            Self::Interconnection => 23,
            Self::Unknown(v) => v,
        }
    }
}

/// WearPacket 载荷变体
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WearPacketPayload {
    ThirdpartyApp(ThirdpartyApp), // tag 22
    Mass(Mass),                   // tag 24
    Raw(u32, Vec<u8>),
}

/// WearPacket 基础报文结构
///
/// 结构：
/// - tag 1: required Type type
/// - tag 2: required uint32 id
/// - tag 22: ThirdpartyApp thirdparty_app
/// - tag 24: Mass mass
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WearPacket {
    pub pkt_type: WearPacketType,
    pub id: u32,
    pub payload: Option<WearPacketPayload>,
}

impl WearPacket {
    pub fn new(pkt_type: WearPacketType, id: u32) -> Self {
        Self {
            pkt_type,
            id,
            payload: None,
        }
    }

    pub fn new_thirdparty_app(id: u32, app: ThirdpartyApp) -> Self {
        Self {
            pkt_type: WearPacketType::ThirdpartyApp,
            id,
            payload: Some(WearPacketPayload::ThirdpartyApp(app)),
        }
    }

    pub fn new_mass(id: u32, mass: Mass) -> Self {
        Self {
            pkt_type: WearPacketType::Mass,
            id,
            payload: Some(WearPacketPayload::Mass(mass)),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_u32_field(&mut buf, 1, self.pkt_type.as_u32());
        write_u32_field(&mut buf, 2, self.id);

        if let Some(payload) = &self.payload {
            match payload {
                WearPacketPayload::ThirdpartyApp(app) => {
                    write_bytes_field(&mut buf, 22, &app.encode());
                }
                WearPacketPayload::Mass(mass) => {
                    write_bytes_field(&mut buf, 24, &mass.encode());
                }
                WearPacketPayload::Raw(tag, data) => {
                    write_bytes_field(&mut buf, *tag, data);
                }
            }
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut pkt_type = None;
        let mut id = None;
        let mut payload = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::Varint(v) = f.value {
                        pkt_type = Some(WearPacketType::from_u32(v as u32));
                    }
                }
                2 => {
                    if let WireValue::Varint(v) = f.value {
                        id = Some(v as u32);
                    }
                }
                22 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let app = ThirdpartyApp::decode(b)?;
                        payload = Some(WearPacketPayload::ThirdpartyApp(app));
                    }
                }
                24 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let mass = Mass::decode(b)?;
                        payload = Some(WearPacketPayload::Mass(mass));
                    }
                }
                other => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        payload = Some(WearPacketPayload::Raw(other, b.to_vec()));
                    }
                }
            }
        }

        let pkt_type = pkt_type.ok_or_else(|| "缺少必填字段 type (tag 1)".to_string())?;
        let id = id.ok_or_else(|| "缺少必填字段 id (tag 2)".to_string())?;

        Ok(Self {
            pkt_type,
            id,
            payload,
        })
    }
}
