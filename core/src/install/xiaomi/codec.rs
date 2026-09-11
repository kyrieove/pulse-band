//! 小米安装协议统一编解码入口 (Xiaomi Install Protocol Codec Facade)
//!
//! 统一提供安装请求、安装结果、Mass 准备请求、Mass 分片与应答的编解码支持。

use super::super::model::Result;
use super::l2::{L2Channel, L2OpCode, L2Packet};
use super::mass::{
    Mass, MassAck, MassChunk, PrepareRequest, PrepareResponse, MASS_DATA_TYPE_THIRDPARTY_APP,
};
use super::thirdparty_app::{
    AppInstallerRequest, AppInstallerResponse, AppInstallerResult, InstallResultCode,
    ThirdpartyApp, ThirdpartyAppPayload,
};
use super::wear_packet::{WearPacket, WearPacketPayload};

/// 编码快应用安装准备请求
///
/// 生成 WearPacket(type=THIRDPARTY_APP(20), id=PREPARE_INSTALL_APP(1)) 对应的 Protobuf 二进制报文
pub fn encode_install_request(
    package_name: &str,
    version_code: u32,
    package_size: u32,
) -> Result<Vec<u8>> {
    if package_name.is_empty() {
        return Err("package_name 不能为空".to_string());
    }
    let req = AppInstallerRequest::new(package_name, version_code, package_size);
    let app = ThirdpartyApp::from_install_request(req);
    let packet = WearPacket::new_thirdparty_app(1, app);
    Ok(packet.encode())
}

/// 编码快应用安装结果报文 (常用于设备上报或离线模拟测试)
///
/// 生成 WearPacket(type=THIRDPARTY_APP(20), id=REPORT_INSTALL_RESULT(2))
#[allow(dead_code)]
pub fn encode_install_result(code: InstallResultCode, package_name: &str) -> Vec<u8> {
    let name_opt = if package_name.is_empty() {
        None
    } else {
        Some(package_name.to_string())
    };
    let res = AppInstallerResult::new(code, name_opt);
    let app = ThirdpartyApp::from_install_result(res);
    let packet = WearPacket::new_thirdparty_app(2, app);
    packet.encode()
}

/// 编码 Mass 准备请求（按数据长度，不分配整个文件缓冲区）
///
/// 生成 WearPacket(type=MASS(22), id=PREPARE(0))，内嵌 PrepareRequest(dataType=64, MD5, dataLength)
pub fn encode_mass_prepare_len(data_length: u32, md5: &[u8]) -> Result<Vec<u8>> {
    encode_mass_prepare_len_with_type(MASS_DATA_TYPE_THIRDPARTY_APP, data_length, md5)
}

/// 编码 Mass 准备请求（显式指定 dataType）
///
/// 上游表盘安装使用 dataType=16 (MassDataType.watchface)；
/// data_id 语义与 RPK 相同：MD5(完整文件)。
pub fn encode_mass_prepare_len_with_type(
    data_type: u32,
    data_length: u32,
    md5: &[u8],
) -> Result<Vec<u8>> {
    if md5.len() != 16 {
        return Err(format!("MD5 长度必须为 16 字节: 实际 {} 字节", md5.len()));
    }
    let req = PrepareRequest::new(data_type, md5.to_vec(), data_length);
    let mass = Mass::from_prepare_request(req);
    let packet = WearPacket::new_mass(0, mass);
    Ok(packet.encode())
}

/// 编码 Mass 准备请求
///
/// 生成 WearPacket(type=MASS(22), id=PREPARE(0))，内嵌 PrepareRequest(dataType=64, MD5, dataLength)
pub fn encode_mass_prepare(rpk_bytes: &[u8], md5: &[u8]) -> Result<Vec<u8>> {
    if md5.len() != 16 {
        return Err(format!("MD5 长度必须为 16 字节: 实际 {} 字节", md5.len()));
    }
    let req = PrepareRequest::new(
        MASS_DATA_TYPE_THIRDPARTY_APP,
        md5.to_vec(),
        rpk_bytes.len() as u32,
    );
    let mass = Mass::from_prepare_request(req);
    let packet = WearPacket::new_mass(0, mass);
    Ok(packet.encode())
}

/// 解码 Mass PrepareResponse
///
/// 上游源码确认的响应路径：`WearPacket(type=22, id=0) → field24: Mass → field2: PrepareResponse`。
pub fn decode_mass_prepare_response(bytes: &[u8]) -> Result<PrepareResponse> {
    let pb_bytes = if bytes.len() >= 2
        && bytes[0] == L2Channel::Pb.as_u8()
        && bytes[1] == L2OpCode::Write.as_u8()
    {
        &bytes[2..]
    } else {
        bytes
    };

    let packet = WearPacket::decode(pb_bytes)?;
    if packet.pkt_type != super::wear_packet::WearPacketType::Mass {
        return Err(format!(
            "Mass 准备响应不是 Mass 报文: 实际 type={}",
            packet.pkt_type.as_u32()
        ));
    }
    let mass = match packet.payload {
        Some(WearPacketPayload::Mass(m)) => m,
        _ => return Err("Mass 准备响应缺少 Mass 载荷 (field24)".to_string()),
    };
    match mass.payload {
        Some(super::mass::MassPayload::PrepareResponse(resp)) => Ok(resp),
        _ => Err("Mass 载荷不是 PrepareResponse (field2)".to_string()),
    }
}

/// 编码 Mass 分片数据包 (封装为 L2 channel=2, opcode=1)
pub fn encode_mass_chunk(total_parts: u16, current_part: u16, fragment: &[u8]) -> Result<Vec<u8>> {
    let chunk = MassChunk::new(total_parts, current_part, fragment.to_vec());
    let chunk_bytes = chunk.encode();
    let l2 = L2Packet::mass_write(chunk_bytes);
    Ok(l2.to_bytes())
}

/// 解码设备返回的快应用安装准备响应
pub fn decode_install_response(bytes: &[u8]) -> Result<AppInstallerResponse> {
    // 自动剥离可能包含的 L2 封装头
    let pb_bytes = if bytes.len() >= 2
        && bytes[0] == L2Channel::Pb.as_u8()
        && bytes[1] == L2OpCode::Write.as_u8()
    {
        &bytes[2..]
    } else {
        bytes
    };

    let packet = WearPacket::decode(pb_bytes)?;
    let app = match packet.payload {
        Some(WearPacketPayload::ThirdpartyApp(a)) => a,
        _ => return Err("WearPacket 载荷不是 ThirdpartyApp".to_string()),
    };
    match app.payload {
        Some(ThirdpartyAppPayload::InstallResponse(resp)) => Ok(resp),
        _ => Err("ThirdpartyApp 载荷不是 InstallResponse".to_string()),
    }
}

/// 解码设备返回的快应用安装结果上报
pub fn decode_install_result(bytes: &[u8]) -> Result<AppInstallerResult> {
    // 自动剥离可能包含的 L2 封装头
    let pb_bytes = if bytes.len() >= 2
        && bytes[0] == L2Channel::Pb.as_u8()
        && bytes[1] == L2OpCode::Write.as_u8()
    {
        &bytes[2..]
    } else {
        bytes
    };

    let packet = WearPacket::decode(pb_bytes)?;
    let app = match packet.payload {
        Some(WearPacketPayload::ThirdpartyApp(a)) => a,
        _ => return Err("WearPacket 载荷不是 ThirdpartyApp".to_string()),
    };
    match app.payload {
        Some(ThirdpartyAppPayload::InstallResult(res)) => Ok(res),
        _ => Err("ThirdpartyApp 载荷不是 InstallResult".to_string()),
    }
}

/// 解码 Mass 传输 ACK
pub fn decode_mass_ack(bytes: &[u8]) -> Result<MassAck> {
    MassAck::decode(bytes)
}
