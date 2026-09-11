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
    PrepareStatus(u32),                // tag 5 (设备对 PREPARE_INSTALL 的应答)
    PrepareInfo(PrepareInfo),          // tag 6
    InstallResult(WatchfaceInstallResult), // tag 7
    Raw(u32, Vec<u8>),
}

/// PrepareInfo（proto2: wear_watch_face.proto）
///
/// - field 1: required string id
/// - field 2: required uint32 size
/// - field 3: optional uint64 version_code（上游固定 65536，属上游策略非协议要求）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrepareInfo {
    pub id: String,
    pub size: u32,
    pub version_code: u64,
}

impl PrepareInfo {
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_string_field(&mut buf, 1, &self.id);
        write_u32_field(&mut buf, 2, self.size);
        if self.version_code != 0 {
            write_u64_field(&mut buf, 3, self.version_code);
        }
        buf
    }
}

/// InstallResult（proto2: wear_watch_face.proto InstallResult）
///
/// code: 0 VERIFY_FAILED / 1 INSTALL_FAILED / 2 INSTALL_SUCCESS / 3 INSTALL_USED
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatchfaceInstallResult {
    pub id: String,
    pub code: u32,
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
                WatchFacePayload::PrepareStatus(code) => {
                    write_u32_field(&mut buf, 5, *code);
                }
                WatchFacePayload::PrepareInfo(pi) => {
                    write_bytes_field(&mut buf, 6, &pi.encode());
                }
                WatchFacePayload::InstallResult(r) => {
                    let mut sub = Vec::new();
                    write_string_field(&mut sub, 1, &r.id);
                    write_u32_field(&mut sub, 2, r.code);
                    write_bytes_field(&mut buf, 7, &sub);
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
                5 => {
                    if let WireValue::Varint(v) = f.value {
                        payload = Some(WatchFacePayload::PrepareStatus(v as u32));
                    }
                }
                6 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let fields = parse_fields(b)?;
                        let mut id = String::new();
                        let mut size = 0u32;
                        let mut version_code = 0u64;
                        for sf in fields {
                            match sf.tag {
                                1 => {
                                    if let WireValue::LengthDelimited(ib) = sf.value {
                                        id = String::from_utf8(ib.to_vec())
                                            .map_err(|e| format!("PrepareInfo.id 非法 UTF-8: {e}"))?;
                                    }
                                }
                                2 => {
                                    if let WireValue::Varint(v) = sf.value {
                                        size = v as u32;
                                    }
                                }
                                3 => {
                                    if let WireValue::Varint(v) = sf.value {
                                        version_code = v;
                                    }
                                }
                                _ => {}
                            }
                        }
                        payload = Some(WatchFacePayload::PrepareInfo(PrepareInfo {
                            id,
                            size,
                            version_code,
                        }));
                    }
                }
                7 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let fields = parse_fields(b)?;
                        let mut id = String::new();
                        let mut code = 0u32;
                        for sf in fields {
                            match sf.tag {
                                1 => {
                                    if let WireValue::LengthDelimited(ib) = sf.value {
                                        id = String::from_utf8(ib.to_vec()).map_err(|e| {
                                            format!("InstallResult.id 非法 UTF-8: {e}")
                                        })?;
                                    }
                                }
                                2 => {
                                    if let WireValue::Varint(v) = sf.value {
                                        code = v as u32;
                                    }
                                }
                                _ => {}
                            }
                        }
                        payload = Some(WatchFacePayload::InstallResult(WatchfaceInstallResult {
                            id,
                            code,
                        }));
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

/// 构造设置当前表盘 WearPacket 明文（type=4, id=1, watch_face{field2: 表盘id}）。
///
/// 编码证据（上游 watchface_system.dart `_buildWatchfaceSet`）：
/// - tag 1 (type): Varint = 4 (WATCH_FACE)
/// - tag 2 (id): Varint = 1 (SET_WATCH_FACE)
/// - tag 6 (watch_face): WatchFace 仅填 string id（field 2）
/// - 上游发送后不等待应答（fire-and-forget）；是否生效只能由设备侧
///   GET_INSTALLED_LIST 的 is_current 复核，不能把"已发送"当成功。
pub fn build_watchface_set_query(watchface_id: &str) -> Vec<u8> {
    let wf = WatchFace {
        payload: Some(WatchFacePayload::Id(watchface_id.to_string())),
    };
    WearPacket {
        pkt_type: WearPacketType::WatchFace,
        id: WatchFaceId::SetWatchFace.as_u32(),
        payload: Some(WearPacketPayload::WatchFace(wf)),
    }
    .encode()
}

/// 构造表盘安装准备 WearPacket 明文（type=4, id=4, watch_face{field6: PrepareInfo}）。
///
/// 编码证据（上游 install_system.dart `installWatchface`）：
/// - tag 1 (type): Varint = 4 (WATCH_FACE)
/// - tag 2 (id): Varint = 4 (PREPARE_INSTALL_WATCH_FACE)
/// - tag 6 (watch_face): PrepareInfo{field1: id, field2: size, field3: version_code}
/// - 上游 version_code 固定 65536，属上游策略而非协议要求；
///   设备应答 type=4 id=4 携带 prepare_status (field 5)。
pub fn build_watchface_prepare_query(
    watchface_id: &str,
    size: u32,
    version_code: u64,
) -> Vec<u8> {
    let wf = WatchFace {
        payload: Some(WatchFacePayload::PrepareInfo(PrepareInfo {
            id: watchface_id.to_string(),
            size,
            version_code,
        })),
    };
    WearPacket {
        pkt_type: WearPacketType::WatchFace,
        id: WatchFaceId::PrepareInstallWatchFace.as_u32(),
        payload: Some(WearPacketPayload::WatchFace(wf)),
    }
    .encode()
}

/// 解码设备对 PREPARE_INSTALL_WATCH_FACE 的应答，返回 prepare_status。
///
/// 严格校验：WearPacket(type=4, id=4, watch_face field 5 = PrepareStatus varint)。
/// 0=READY；非 0 视为设备拒绝（调用方负责把码翻译成语义）。
pub fn decode_watchface_prepare_response(bytes: &[u8]) -> Result<u32> {
    let pb_bytes = strip_l2(bytes);
    let packet = WearPacket::decode(pb_bytes)?;
    if packet.pkt_type != WearPacketType::WatchFace {
        return Err(format!(
            "表盘安装准备应答不是 WatchFace 报文: 实际 type={}",
            packet.pkt_type.as_u32()
        ));
    }
    if packet.id != WatchFaceId::PrepareInstallWatchFace.as_u32() {
        return Err(format!(
            "表盘安装准备应答 id 不是 4 (PREPARE_INSTALL): 实际 id={}",
            packet.id
        ));
    }
    let wf = match packet.payload {
        Some(WearPacketPayload::WatchFace(wf)) => wf,
        Some(WearPacketPayload::Raw(6, data)) => WatchFace::decode(&data)?,
        _ => return Err("表盘安装准备应答缺少 WatchFace 载荷 (tag 6)".to_string()),
    };
    match wf.payload {
        Some(WatchFacePayload::PrepareStatus(code)) => Ok(code),
        other => Err(format!(
            "表盘安装准备应答缺少 prepare_status (field 5): 实际 {other:?}"
        )),
    }
}

/// 解码设备上报的表盘安装结果 (type=4, id=5, watch_face field 7 = InstallResult)。
pub fn decode_watchface_install_result(bytes: &[u8]) -> Result<WatchfaceInstallResult> {
    let pb_bytes = strip_l2(bytes);
    let packet = WearPacket::decode(pb_bytes)?;
    if packet.pkt_type != WearPacketType::WatchFace {
        return Err(format!(
            "表盘安装结果不是 WatchFace 报文: 实际 type={}",
            packet.pkt_type.as_u32()
        ));
    }
    if packet.id != WatchFaceId::ReportInstallResult.as_u32() {
        return Err(format!(
            "表盘安装结果 id 不是 5 (REPORT_INSTALL_RESULT): 实际 id={}",
            packet.id
        ));
    }
    let wf = match packet.payload {
        Some(WearPacketPayload::WatchFace(wf)) => wf,
        Some(WearPacketPayload::Raw(6, data)) => WatchFace::decode(&data)?,
        _ => return Err("表盘安装结果缺少 WatchFace 载荷 (tag 6)".to_string()),
    };
    match wf.payload {
        Some(WatchFacePayload::InstallResult(r)) => Ok(r),
        other => Err(format!(
            "表盘安装结果缺少 install_result (field 7): 实际 {other:?}"
        )),
    }
}

/// 从 Vela 表盘裸二进制提取 0x28 处的 12 字节 ASCII 表盘 ID（右补零）。
///
/// 证据：上游 watchface_install_policy.dart `extractVelaWatchfaceId`。
/// 返回 None 当文件过短、全零或全空。
pub fn extract_watchface_id(file_bytes: &[u8]) -> Option<String> {
    if file_bytes.len() < 0x28 + 12 {
        return None;
    }
    let raw = &file_bytes[0x28..0x28 + 12];
    let s: String = raw
        .iter()
        .take_while(|b| **b != 0)
        .map(|b| *b as char)
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 表盘 ID 合法性（上游 `_validWatchfaceId`）：`^[a-zA-Z0-9_-]{1,12}$`，
/// 且拒绝全零 —— 0x28 处全零表示"文件未写 ID"，不能当真实 ID 安装
/// （真机实测：BetaUI-黑塔 全零 ID 曾被原样接受安装）。
pub fn is_valid_watchface_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=12).contains(&bytes.len())
        && !bytes.iter().all(|b| *b == b'0')
        && bytes.iter().all(|b| {
            b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-'
        })
}

/// 把 12 字节 ASCII 表盘 ID 写入文件 0x28 处（右补零）。
///
/// 上游在发送前必然执行此改写，使文件内嵌 ID 与 PrepareInfo.id 一致。
pub fn apply_watchface_id(file_bytes: &mut Vec<u8>, watchface_id: &str) -> Result<()> {
    if !is_valid_watchface_id(watchface_id) {
        return Err(format!("非法表盘 ID: {watchface_id:?}"));
    }
    if file_bytes.len() < 0x28 + 12 {
        return Err(format!(
            "表盘文件过短，无法改写 0x28 处 ID: 实际 {} 字节",
            file_bytes.len()
        ));
    }
    let id_bytes = watchface_id.as_bytes();
    for (i, slot) in file_bytes[0x28..0x28 + 12].iter_mut().enumerate() {
        *slot = if i < id_bytes.len() { id_bytes[i] } else { 0 };
    }
    Ok(())
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
