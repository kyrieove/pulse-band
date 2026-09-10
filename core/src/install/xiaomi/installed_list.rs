//! 快应用已安装列表查询与解析 (QuickApp Installed List Query & Parse)
//!
//! 依据真机抓包证据 docs/protocol/business.md 第 3.1 节：
//! - 查询/响应外层：WearPacket.type=20 (THIRDPARTY_APP)，id=0 (GET_INSTALLED_LIST)
//! - 负载：WearPacket.field22 -> ThirdpartyApp.field1 = AppItem.List（repeated AppItem）
//! - AppItem: field1=package_name(string)，field2=fingerprint(bytes)，
//!   field3=version_code(varint)，field4=can_remove(varint)，field5=app_name(string)
//!
//! 纪律：
//! - 只使用上述已抓包实证的字段，不发明新 opcode。
//! - 本模块只负责编解码，不做任何安装成功判定；安装结果仍由 id=2 决定。
//! - 查询与响应都必须经过真实认证链路收发，本模块不持有也不创建任何连接。

use super::super::model::Result;
use super::l2::{L2Channel, L2OpCode};
use super::thirdparty_app::{ThirdpartyApp, ThirdpartyAppPayload};
use super::wear_packet::{WearPacket, WearPacketPayload, WearPacketType};
use super::wire::{
    parse_fields, write_bytes_field, write_string_field, write_u32_field, WireValue,
};

/// 已安装列表中的单个快应用条目（只保留验收需要的字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledApp {
    pub package_name: String,
    pub version_code: u32,
    pub app_name: Option<String>,
    pub fingerprint: Vec<u8>,
    pub can_remove: bool,
}

impl InstalledApp {
    pub fn new(package_name: impl Into<String>, version_code: u32) -> Self {
        Self {
            package_name: package_name.into(),
            version_code,
            app_name: None,
            fingerprint: Vec::new(),
            can_remove: false,
        }
    }
}

/// 构造已安装列表查询 WearPacket 明文（type=20, id=0, field22=空 ThirdpartyApp）。
///
/// 证据：真机抓包 Pkt #176 为 Host->Band 的 THIRDPARTY_APP (id=0)，payload_field=22。
/// 请求侧没有可解析的 AppItem，因此构造空 ThirdpartyApp；不添加任何猜测字段。
pub fn encode_installed_list_query() -> Vec<u8> {
    let app = ThirdpartyApp { payload: None };
    WearPacket::new_thirdparty_app(0, app).encode()
}

/// 构造已安装列表查询的完整业务明文（WearPacket），可直接交给设备会话下行。
///
/// 注意：**不加** L2 channel/opcode 前缀。真机抓包实证业务明文就是 protobuf 本身
/// （见 `tools/decrypt_business.py` 直接以 WearPacket 解析解密结果），
/// 加了 `01 01` 前缀会让手环把 field1 读成 1 而不是 20。
pub fn build_installed_list_query() -> Vec<u8> {
    encode_installed_list_query()
}

/// 编码已安装列表响应（仅供离线测试与 Mock 使用，字段顺序与真机抓包一致）。
#[allow(dead_code)]
pub fn encode_installed_list_response(apps: &[InstalledApp]) -> Vec<u8> {
    let mut list = Vec::new();
    for app in apps {
        let mut item = Vec::new();
        write_string_field(&mut item, 1, &app.package_name);
        if !app.fingerprint.is_empty() {
            write_bytes_field(&mut item, 2, &app.fingerprint);
        }
        write_u32_field(&mut item, 3, app.version_code);
        write_u32_field(&mut item, 4, app.can_remove as u32);
        if let Some(name) = &app.app_name {
            write_string_field(&mut item, 5, name);
        }
        write_bytes_field(&mut list, 1, &item);
    }
    let app = ThirdpartyApp {
        payload: Some(ThirdpartyAppPayload::Raw(1, list)),
    };
    WearPacket::new_thirdparty_app(0, app).encode()
}

/// 剥离可能存在的 L2 头（channel=Pb, opcode=Write）。
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

/// 解码设备返回的已安装列表报文。
///
/// 只接受 WearPacket(type=20, id=0, field22=ThirdpartyApp.field1=AppItem.List)。
/// 任何结构不符都返回错误，绝不返回空列表冒充没有已安装应用。
pub fn decode_installed_list(bytes: &[u8]) -> Result<Vec<InstalledApp>> {
    let pb_bytes = strip_l2(bytes);
    let packet = WearPacket::decode(pb_bytes)?;
    if packet.pkt_type != WearPacketType::ThirdpartyApp {
        return Err("已安装列表响应不是 ThirdpartyApp 报文".to_string());
    }
    if packet.id != 0 {
        return Err(format!("已安装列表响应 id 不是 0: 实际 {}", packet.id));
    }
    let app = match packet.payload {
        Some(WearPacketPayload::ThirdpartyApp(app)) => app,
        _ => return Err("已安装列表响应缺少 ThirdpartyApp 载荷".to_string()),
    };
    let list_bytes = match app.payload {
        Some(ThirdpartyAppPayload::Raw(1, data)) => data,
        Some(ThirdpartyAppPayload::Raw(_, _)) => {
            return Err("已安装列表响应缺少字段 1 (AppItem.List)".to_string())
        }
        _ => return Err("已安装列表响应载荷不是字段 1 (AppItem.List)".to_string()),
    };

    let fields = parse_fields(&list_bytes)?;
    let mut apps = Vec::new();
    for field in fields {
        if field.tag != 1 {
            continue;
        }
        if let WireValue::LengthDelimited(item) = field.value {
            apps.push(decode_app_item(item)?);
        }
    }
    Ok(apps)
}

fn decode_app_item(bytes: &[u8]) -> Result<InstalledApp> {
    let fields = parse_fields(bytes)?;
    let mut package_name = None;
    let mut version_code = None;
    let mut app_name = None;
    let mut fingerprint = Vec::new();
    let mut can_remove = false;

    for field in fields {
        match field.tag {
            1 => {
                if let WireValue::LengthDelimited(s) = field.value {
                    package_name = Some(
                        String::from_utf8(s.to_vec())
                            .map_err(|e| format!("AppItem.package_name 非法 UTF-8: {e}"))?,
                    );
                }
            }
            2 => {
                if let WireValue::LengthDelimited(s) = field.value {
                    fingerprint = s.to_vec();
                }
            }
            3 => {
                if let WireValue::Varint(v) = field.value {
                    version_code = Some(v as u32);
                }
            }
            4 => {
                if let WireValue::Varint(v) = field.value {
                    can_remove = v != 0;
                }
            }
            5 => {
                if let WireValue::LengthDelimited(s) = field.value {
                    app_name = String::from_utf8(s.to_vec()).ok();
                }
            }
            _ => {}
        }
    }

    let package_name =
        package_name.ok_or_else(|| "AppItem 缺少必填字段 package_name (tag 1)".to_string())?;
    let version_code =
        version_code.ok_or_else(|| "AppItem 缺少必填字段 version_code (tag 3)".to_string())?;
    Ok(InstalledApp {
        package_name,
        version_code,
        app_name,
        fingerprint,
        can_remove,
    })
}

/// 判断已安装列表中是否存在指定 package_name（版本可选核验）。
pub fn installed_list_contains(
    apps: &[InstalledApp],
    package_name: &str,
    version_code: Option<u32>,
) -> bool {
    apps.iter().any(|app| {
        app.package_name == package_name
            && version_code.map(|v| app.version_code == v).unwrap_or(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::l2::L2Packet;

    #[test]
    fn test_query_is_type20_id0() {
        let raw = encode_installed_list_query();
        let wp = WearPacket::decode(&raw).unwrap();
        assert_eq!(wp.pkt_type, WearPacketType::ThirdpartyApp);
        assert_eq!(wp.id, 0);
    }

    #[test]
    fn test_response_roundtrip() {
        let apps = vec![
            InstalledApp {
                package_name: "com.bandbbs.ebook.plus".to_string(),
                version_code: 260529,
                app_name: Some("Ebook".to_string()),
                fingerprint: vec![0xAA; 20],
                can_remove: true,
            },
            InstalledApp {
                package_name: "com.codeisland.band".to_string(),
                version_code: 26,
                app_name: Some("Pulse".to_string()),
                fingerprint: vec![0xBB; 20],
                can_remove: true,
            },
        ];
        let raw = encode_installed_list_response(&apps);
        let l2 = L2Packet::pb_write(raw).to_bytes();
        let decoded = decode_installed_list(&l2).unwrap();
        assert_eq!(decoded, apps);
        assert!(installed_list_contains(&decoded, "com.codeisland.band", Some(26)));
        assert!(!installed_list_contains(&decoded, "com.codeisland.band", Some(27)));
    }
}