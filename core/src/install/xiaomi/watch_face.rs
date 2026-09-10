//! 小米表盘协议模型与编解码 (Xiaomi WatchFace Protocol Model & Codec)
//!
//! 依据源码证据：
//! - `protos/xiaomi/wear.proto`（WearPacket.type = 4: WATCH_FACE, payload field 6: watch_face）
//! - `protos/xiaomi/wear_watch_face.proto`
//!
//! 纪律要求：
//! - source-backed，设备未验证状态标注明确。
//! - 只实现当前阶段经审计确认的字段与命令，不做过度推测。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::super::model::Result;
use super::l2::{L2Channel, L2OpCode};
use super::wear_packet::{WearPacket, WearPacketPayload, WearPacketType};
use super::wire::{
    parse_fields, write_bytes_field, write_string_field, write_u32_field, write_u64_field,
    WireValue,
};

/// WatchFace 命令 ID 枚举（对应 wear_watch_face.proto 内 WatchFaceID）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WatchFaceId {
    GetInstalledList = 0,
    SetWatchFace = 1,
    RemoveWatchFace = 2,
    RemoveWatchFacePhoto = 3,
    PrepareInstallWatchFace = 4,
    ReportInstallResult = 5,
    RemoveMultiWatchFace = 6,
    GetSupportData = 10,
    EditWatchFace = 11,
    BgImageResult = 12,
    FontResult = 13,
    Unknown(u32),
}

impl WatchFaceId {
    pub fn from_u32(val: u32) -> Self {
        match val {
            0 => Self::GetInstalledList,
            1 => Self::SetWatchFace,
            2 => Self::RemoveWatchFace,
            3 => Self::RemoveWatchFacePhoto,
            4 => Self::PrepareInstallWatchFace,
            5 => Self::ReportInstallResult,
            6 => Self::RemoveMultiWatchFace,
            10 => Self::GetSupportData,
            11 => Self::EditWatchFace,
            12 => Self::BgImageResult,
            13 => Self::FontResult,
            other => Self::Unknown(other),
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            Self::GetInstalledList => 0,
            Self::SetWatchFace => 1,
            Self::RemoveWatchFace => 2,
            Self::RemoveWatchFacePhoto => 3,
            Self::PrepareInstallWatchFace => 4,
            Self::ReportInstallResult => 5,
            Self::RemoveMultiWatchFace => 6,
            Self::GetSupportData => 10,
            Self::EditWatchFace => 11,
            Self::BgImageResult => 12,
            Self::FontResult => 13,
            Self::Unknown(v) => v,
        }
    }
}

/// 已安装表盘条目信息（WatchFaceItem）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchFaceItem {
    pub id: String,
    pub name: String,
    pub is_current: bool,
    pub can_remove: bool,
    pub version_code: u64,
    pub can_edit: bool,
    pub background_color: String,
    pub background_image: String,
    pub style: String,
}

impl WatchFaceItem {
    pub fn new(id: impl Into<String>, name: impl Into<String>, is_current: bool) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            is_current,
            can_remove: false,
            version_code: 0,
            can_edit: false,
            background_color: String::new(),
            background_image: String::new(),
            style: String::new(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_string_field(&mut buf, 1, &self.id);
        write_string_field(&mut buf, 2, &self.name);
        write_u32_field(&mut buf, 3, self.is_current as u32);
        write_u32_field(&mut buf, 4, self.can_remove as u32);
        if self.version_code != 0 {
            write_u64_field(&mut buf, 5, self.version_code);
        }
        write_u32_field(&mut buf, 6, self.can_edit as u32);
        if !self.background_color.is_empty() {
            write_string_field(&mut buf, 7, &self.background_color);
        }
        if !self.background_image.is_empty() {
            write_string_field(&mut buf, 8, &self.background_image);
        }
        if !self.style.is_empty() {
            write_string_field(&mut buf, 9, &self.style);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut id = None;
        let mut name = None;
        let mut is_current = false;
        let mut can_remove = false;
        let mut version_code = 0;
        let mut can_edit = false;
        let mut background_color = String::new();
        let mut background_image = String::new();
        let mut style = String::new();

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        id = Some(
                            String::from_utf8(b.to_vec())
                                .map_err(|e| format!("WatchFaceItem.id 非法 UTF-8: {e}"))?,
                        );
                    }
                }
                2 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        name = Some(
                            String::from_utf8(b.to_vec())
                                .map_err(|e| format!("WatchFaceItem.name 非法 UTF-8: {e}"))?,
                        );
                    }
                }
                3 => {
                    if let WireValue::Varint(v) = f.value {
                        is_current = v != 0;
                    }
                }
                4 => {
                    if let WireValue::Varint(v) = f.value {
                        can_remove = v != 0;
                    }
                }
                5 => {
                    if let WireValue::Varint(v) = f.value {
                        version_code = v;
                    }
                }
                6 => {
                    if let WireValue::Varint(v) = f.value {
                        can_edit = v != 0;
                    }
                }
                7 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        background_color = String::from_utf8(b.to_vec()).unwrap_or_default();
                    }
                }
                8 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        background_image = String::from_utf8(b.to_vec()).unwrap_or_default();
                    }
                }
                9 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        style = String::from_utf8(b.to_vec()).unwrap_or_default();
                    }
                }
                _ => {}
            }
        }

        let id = id.ok_or_else(|| "WatchFaceItem 缺少必填字段 id (tag 1)".to_string())?;
        let name = name.unwrap_or_else(|| id.clone());

        Ok(Self {
            id,
            name,
            is_current,
            can_remove,
            version_code,
            can_edit,
            background_color,
            background_image,
            style,
        })
    }
}

/// WatchFace 载荷变体
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchFacePayload {
    WatchFaceList(Vec<WatchFaceItem>), // tag 1
    Id(String),                        // tag 2
    Path(String),                      // tag 3
    Success(bool),                     // tag 4
    Raw(u32, Vec<u8>),
}

/// WatchFace 消息结构体
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatchFace {
    pub payload: Option<WatchFacePayload>,
}

impl WatchFace {
    pub fn new_list(items: Vec<WatchFaceItem>) -> Self {
        Self {
            payload: Some(WatchFacePayload::WatchFaceList(items)),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(payload) = &self.payload {
            match payload {
                WatchFacePayload::WatchFaceList(items) => {
                    let mut list_buf = Vec::new();
                    for item in items {
                        write_bytes_field(&mut list_buf, 1, &item.encode());
                    }
                    write_bytes_field(&mut buf, 1, &list_buf);
                }
                WatchFacePayload::Id(id) => {
                    write_string_field(&mut buf, 2, id);
                }
                WatchFacePayload::Path(p) => {
                    write_string_field(&mut buf, 3, p);
                }
                WatchFacePayload::Success(s) => {
                    write_u32_field(&mut buf, 4, *s as u32);
                }
                WatchFacePayload::Raw(tag, data) => {
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
                        let sub_fields = parse_fields(b)?;
                        let mut items = Vec::new();
                        for sf in sub_fields {
                            if sf.tag == 1 {
                                if let WireValue::LengthDelimited(ib) = sf.value {
                                    items.push(WatchFaceItem::decode(ib)?);
                                }
                            }
                        }
                        payload = Some(WatchFacePayload::WatchFaceList(items));
                    }
                }
                2 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let id = String::from_utf8(b.to_vec())
                            .map_err(|e| format!("WatchFace.id 非法 UTF-8: {e}"))?;
                        payload = Some(WatchFacePayload::Id(id));
                    }
                }
                3 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let p = String::from_utf8(b.to_vec())
                            .map_err(|e| format!("WatchFace.path 非法 UTF-8: {e}"))?;
                        payload = Some(WatchFacePayload::Path(p));
                    }
                }
                4 => {
                    if let WireValue::Varint(v) = f.value {
                        payload = Some(WatchFacePayload::Success(v != 0));
                    }
                }
                other => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        payload = Some(WatchFacePayload::Raw(other, b.to_vec()));
                    }
                }
            }
        }

        Ok(Self { payload })
    }
}

/// 构造已安装表盘列表查询 WearPacket 明文（type=4, id=0, watch_face=空）。
///
/// 编码证据：
/// - tag 1 (type): Varint = 4 (0x08, 0x04)
/// - tag 2 (id): Varint = 0 (0x10, 0x00)
/// - tag 6 (watch_face): LengthDelimited = 0 字节 (0x32, 0x00)
/// 总共 6 字节。与快应用查询逻辑一致，不带多余 L2 前缀。
pub fn build_watchface_list_query() -> Vec<u8> {
    let wf = WatchFace { payload: None };
    WearPacket {
        pkt_type: WearPacketType::WatchFace,
        id: WatchFaceId::GetInstalledList.as_u32(),
        payload: Some(WearPacketPayload::WatchFace(wf)),
    }
    .encode()
}

/// 剥离可能存在的 L2 头（channel=Pb, opcode=Write）
fn strip_l2(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 2
        && bytes[0] == L2Channel::Pb.as_u8()
        && bytes[1] == L2OpCode::Write.as_u8()
    {
        &bytes[2..]
    } else {
        bytes
    }
}

/// 解码设备返回的已安装表盘列表报文。
///
/// 严格校验：
/// - WearPacket(type=4, id=0, watch_face(tag 6) -> watch_face_list(tag 1) -> list(tag 1))
pub fn decode_watchface_list_response(bytes: &[u8]) -> Result<Vec<WatchFaceItem>> {
    let pb_bytes = strip_l2(bytes);
    let packet = WearPacket::decode(pb_bytes)?;
    if packet.pkt_type != WearPacketType::WatchFace {
        return Err(format!(
            "表盘列表响应不是 WatchFace 报文: 实际 type={}",
            packet.pkt_type.as_u32()
        ));
    }
    if packet.id != WatchFaceId::GetInstalledList.as_u32() {
        return Err(format!(
            "表盘列表响应 id 不是 0 (GET_INSTALLED_LIST): 实际 id={}",
            packet.id
        ));
    }

    let wf = match packet.payload {
        Some(WearPacketPayload::WatchFace(wf)) => wf,
        Some(WearPacketPayload::Raw(6, data)) => WatchFace::decode(&data)?,
        _ => return Err("表盘列表响应缺少 WatchFace 载荷 (tag 6)".to_string()),
    };

    match wf.payload {
        Some(WatchFacePayload::WatchFaceList(items)) => Ok(items),
        Some(WatchFacePayload::Raw(1, data)) => {
            let sub_fields = parse_fields(&data)?;
            let mut items = Vec::new();
            for sf in sub_fields {
                if sf.tag == 1 {
                    if let WireValue::LengthDelimited(ib) = sf.value {
                        items.push(WatchFaceItem::decode(ib)?);
                    }
                }
            }
            Ok(items)
        }
        _ => Err("表盘列表响应缺少字段 1 (watch_face_list)".to_string()),
    }
}
