//! 小米表盘整包安装流程 (SET/GET 之外的第三条表盘命令链)
//!
//! 流程逐条对齐上游 install_system.dart `installWatchface`：
//! 1. 决定表盘 ID（显式指定 > 文件 0x28 内嵌 > 随机生成），并把 ID 改写进文件 0x28 处；
//! 2. 发 PREPARE_INSTALL_WATCH_FACE (type=4, id=4, PrepareInfo{id,size,version_code})，
//!    等设备应答 prepare_status == READY(0)；
//! 3. Mass 准备 (type=22, id=0, dataType=16, data_id=MD5(完整文件))，等 READY 与 expected_slice_length；
//! 4. Mass 分片 + 累积 ACK（与 RPK 同一传输格式，仅 dataType 不同）；
//! 5. 等 REPORT_INSTALL_RESULT (type=4, id=5)，成功码 = INSTALL_SUCCESS(2) 或 INSTALL_USED(3)。
//!
//! 纪律：
//! - 成功判定只依据设备上报的 InstallResult.code，收到 ACK / 传完字节不算成功；
//! - 上游把 `1209` 前缀列为商店命名空间并禁止本地安装，Pulse 沿用该策略（防盗装付费表盘）；
//! - 不修改 RPK 安装路径 (protocol.rs)，本模块独立成链。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use rand::Rng;

use crate::frame::Frame;
use super::super::transport::BandDeviceTransport;
use super::codec::{decode_mass_prepare_response, encode_mass_prepare_len_with_type};
use super::l2::L2Packet;
use super::mass::{build_mass_inner_payload, MassChunk};
use super::runtime_bridge::install_log;
use super::watch_face::{
    apply_watchface_id, decode_watchface_install_result, decode_watchface_prepare_response,
    extract_watchface_id, is_valid_watchface_id, build_watchface_prepare_query,
};

/// 与 protocol.rs 相同的 Mass 传输常量（上游同一套传输格式， dataType 除外）
const PREPARE_TIMEOUT_MS: u64 = 10_000;
const MASS_PREPARE_TIMEOUT_MS: u64 = 10_000;
const MASS_TX_WINDOW: usize = 32;
/// 上游 per-ACK 等待为 10s（mass_transfer.dart:290）；
/// 真机实测 884KB 表盘尾部 ACK 需等设备落盘，2s 会误判超时。
const MASS_ACK_WAIT_MS: u64 = 10_000;
const MASS_TRANSFER_TIMEOUT_MS: u64 = 120_000;
/// 上游 `_sendMassAndWaitResult` 表盘结果的等待上限
const RESULT_TIMEOUT_MS: u64 = 60_000;

/// 表盘安装 Mass dataType（上游 mass_packet.dart：watchface = 16）
const MASS_DATA_TYPE_WATCHFACE: u32 = 16;
/// 上游 installWatchface 固定值；属上游策略，未发现协议强制的其它取值
const UPSTREAM_VERSION_CODE: u64 = 65_536;
/// 商店表盘命名空间前缀（上游 restrictedWatchfaceIdPrefix），本地安装一律拒绝
const RESTRICTED_ID_PREFIX: &str = "1209";

/// 设备上报的安装结果码（wear_watch_face.proto InstallResult.Code）
#[allow(dead_code)]
pub const INSTALL_RESULT_VERIFY_FAILED: u32 = 0;
#[allow(dead_code)]
pub const INSTALL_RESULT_INSTALL_FAILED: u32 = 1;
pub const INSTALL_RESULT_INSTALL_SUCCESS: u32 = 2;
pub const INSTALL_RESULT_INSTALL_USED: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchfaceInstallOutcome {
    pub watchface_id: String,
    /// 设备上报的原始结果码（2=SUCCESS 3=USED）
    pub result_code: u32,
}

/// 表盘安装完整流程。成功即设备已确认安装（code 2/3），不含"设为当前表盘"。
pub fn install_watchface(
    transport: &mut dyn BandDeviceTransport,
    file_bytes: &[u8],
    md5_hex: &str,
    explicit_id: Option<&str>,
) -> Result<WatchfaceInstallOutcome, String> {
    let watchface_id = resolve_watchface_id(file_bytes, explicit_id)?;
    install_log(&format!(
        "watchface: 安装开始 id={watchface_id} size={} md5={}B 文件",
        file_bytes.len(),
        md5_hex.len() / 2
    ));

    // 1. 改写文件 0x28 处 ID（上游发送前必然执行）
    let mut file_data = file_bytes.to_vec();
    apply_watchface_id(&mut file_data, &watchface_id)?;
    let md5 = hex16(md5_hex)
        .ok_or_else(|| "md5 参数不是合法的 32 位 hex".to_string())?;

    // 2. PREPARE_INSTALL_WATCH_FACE
    let prepare_payload = build_watchface_prepare_query(
        &watchface_id,
        file_data.len() as u32,
        UPSTREAM_VERSION_CODE,
    );
    let prepare_frame = Frame {
        frame_type: 0x03,
        seq: 0,
        payload: prepare_payload,
    };
    transport
        .send_install_packet(&prepare_frame)
        .map_err(|e| format!("发送表盘安装准备失败: {e}"))?;

    let status = wait_prepare_status(transport, Duration::from_millis(PREPARE_TIMEOUT_MS))?;
    if status != 0 {
        return Err(format!(
            "表盘安装准备被设备拒绝 (prepare_status={status}，0=READY)"
        ));
    }
    install_log("watchface: 设备 READY，开始 Mass 准备");

    // 3. Mass 准备 (dataType=16, data_id=MD5)
    let mass_prepare = encode_mass_prepare_len_with_type(
        MASS_DATA_TYPE_WATCHFACE,
        file_data.len() as u32,
        &md5,
    )?;
    let mass_prepare_frame = Frame {
        frame_type: 0x03,
        seq: 0,
        payload: mass_prepare,
    };
    transport
        .send_frame(&mass_prepare_frame)
        .map_err(|e| format!("发送 Mass 准备失败: {e}"))?;

    let mut expected_slice_length = 0u32;
    let deadline = Instant::now() + Duration::from_millis(MASS_PREPARE_TIMEOUT_MS);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("等待 Mass PrepareResponse 超时 (timeout)".to_string());
        }
        let Some(f) = transport.receive_frame(remaining.as_millis() as u64)? else {
            return Err("等待 Mass PrepareResponse 超时 (timeout)".to_string());
        };
        let Ok(resp) = decode_mass_prepare_response(&f.payload) else {
            continue;
        };
        if !resp.is_ready() {
            return Err(format!(
                "Mass 准备未就绪 (prepare_status={})",
                resp.prepare_status
            ));
        }
        if let Some(slice_len) = resp.expected_slice_length {
            if slice_len > 6 {
                expected_slice_length = slice_len;
            }
        }
        break;
    }

    // 4. Mass 分片传输 + 累积 ACK
    transfer_mass_body(
        transport,
        &file_data,
        &md5,
        expected_slice_length,
        Duration::from_millis(MASS_TRANSFER_TIMEOUT_MS),
    )?;
    install_log("watchface: Mass 传输完成，等待设备安装结果");

    // 5. 等待 REPORT_INSTALL_RESULT
    let deadline = Instant::now() + Duration::from_millis(RESULT_TIMEOUT_MS);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(
                "等待 REPORT_INSTALL_RESULT 超时 (timeout)：设备未在 60s 内上报结果".to_string(),
            );
        }
        let Some(f) = transport.receive_install_packet(
            remaining.min(Duration::from_millis(500)).as_millis() as u64,
        )?
        else {
            continue;
        };
        let Ok(result) = decode_watchface_install_result(&f.payload) else {
            continue;
        };
        if !result.id.is_empty() && result.id != watchface_id {
            return Err(format!(
                "安装结果目标不匹配: 期望 {watchface_id}，设备上报 {}",
                result.id
            ));
        }
        return match result.code {
            INSTALL_RESULT_INSTALL_SUCCESS => Ok(WatchfaceInstallOutcome {
                watchface_id,
                result_code: result.code,
            }),
            INSTALL_RESULT_INSTALL_USED => Ok(WatchfaceInstallOutcome {
                watchface_id,
                result_code: result.code,
            }),
            0 => Err("设备返回 VERIFY_FAILED (code=0)：签名/校验未通过".to_string()),
            1 => Err("设备返回 INSTALL_FAILED (code=1)：安装失败".to_string()),
            other => Err(format!("设备返回未知安装结果码 (code={other})")),
        };
    }
}

/// 决定表盘 ID：显式指定 > 文件内嵌 > 随机生成（对齐上游 `_normalizeWatchfaceId`）。
/// `1209` 商店命名空间一律拒绝（上游 restrictedWatchfaceIdPrefix 策略）。
fn resolve_watchface_id(file_bytes: &[u8], explicit_id: Option<&str>) -> Result<String, String> {
    let candidate = explicit_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| extract_watchface_id(file_bytes))
        .filter(|s| is_valid_watchface_id(s))
        .unwrap_or_else(generate_watchface_id);

    if !is_valid_watchface_id(&candidate) {
        return Err(format!("表盘 ID 非法 (需 [a-zA-Z0-9_-] 且 ≤12 字符): {candidate:?}"));
    }
    if candidate.starts_with(RESTRICTED_ID_PREFIX) {
        return Err(format!(
            "表盘 ID {candidate} 属于 {RESTRICTED_ID_PREFIX} 商店命名空间，禁止本地安装；请改用自定义 ID"
        ));
    }
    Ok(candidate)
}

/// 对齐上游 `_generateWatchfaceId`：9~12 位、首位非零的随机十进制数字串
fn generate_watchface_id() -> String {
    let mut rng = rand::thread_rng();
    let length = 9 + rng.gen_range(0..4);
    let mut id = String::with_capacity(length);
    id.push((b'1' + rng.gen_range(0..9)) as char);
    for _ in 1..length {
        id.push((b'0' + rng.gen_range(0..10)) as char);
    }
    id
}

fn wait_prepare_status(
    transport: &mut dyn BandDeviceTransport,
    timeout: Duration,
) -> Result<u32, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("等待表盘安装准备应答超时 (timeout)".to_string());
        }
        let Some(f) = transport.receive_install_packet(remaining.as_millis() as u64)? else {
            continue;
        };
        let Ok(status) = decode_watchface_prepare_response(&f.payload) else {
            continue;
        };
        return Ok(status);
    }
}

/// Mass 分片 + 累积 ACK（传输格式与 RPK 相同：`00 | dataType | MD5[16] | len[u32LE] | file | CRC32[u32LE]`）
fn transfer_mass_body(
    transport: &mut dyn BandDeviceTransport,
    file_data: &[u8],
    md5: &[u8],
    expected_slice_length: u32,
    transfer_timeout: Duration,
) -> Result<(), String> {
    let body = build_mass_inner_payload(file_data, MASS_DATA_TYPE_WATCHFACE, md5)?;
    let slice_len = expected_slice_length as usize;
    if slice_len <= 6 {
        return Err(format!("非法的 expected_slice_length: {slice_len}"));
    }
    let capacity = slice_len - 6;
    let total_parts = body.len().div_ceil(capacity);
    if total_parts == 0 || total_parts > u16::MAX as usize {
        return Err(format!("Mass 分片数超出 u16 范围: {total_parts}"));
    }

    let mut inflight: VecDeque<u8> = VecDeque::new();
    let deadline = Instant::now() + transfer_timeout;

    for i in 0..total_parts {
        let start = i * capacity;
        let end = (start + capacity).min(body.len());
        let payload = L2Packet::mass_write(
            MassChunk::new(total_parts as u16, (i + 1) as u16, body[start..end].to_vec())
                .encode(),
        )
        .to_bytes();

        while inflight.len() >= MASS_TX_WINDOW {
            wait_one_ack(transport, &mut inflight, deadline)?;
        }
        let seq = transport
            .send_plain_payload(&payload)
            .map_err(|e| format!("发送 Mass 分片失败: {e}"))?;
        inflight.push_back(seq);
    }

    // 发完后**不硬等 ACK 排空**：设备收满 Mass prepare 声明的字节数后即进入安装处理，
    // 可能不再逐片确认尾部（884KB 真机实测两次复现）。改为 best-effort 收集已到的 ACK，
    // 成功判定交给 REPORT_INSTALL_RESULT（与上游 `_enforceFlowControl` "发完即走"语义一致）。
    let mut drained = 0usize;
    while let Some(ack_seq) = transport.wait_frame_ack(500) {
        super::protocol::ack_cumulative(&mut inflight, ack_seq);
        drained += 1;
    }
    if !inflight.is_empty() {
        install_log(&format!(
            "watchface: 字节已全部发出，尾部 {} 片未获 ACK（best-effort），以安装结果为准",
            inflight.len()
        ));
    } else {
        install_log(&format!("watchface: 传输完成，ACK 全部确认 ({drained} 批)"));
    }
    Ok(())
}

fn wait_one_ack(
    transport: &mut dyn BandDeviceTransport,
    inflight: &mut VecDeque<u8>,
    deadline: Instant,
) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err("等待 Mass 分片 ACK 超时 (timeout)".to_string());
    }
    match transport.wait_frame_ack(MASS_ACK_WAIT_MS) {
        Some(ack_seq) => {
            // 累积确认：复用 RPK 路径的模 256 半区间判断（u8 seq 会回绕，
            // 简单的 `<=` 比较在回绕后会永久卡死窗口 —— 已在真机 884KB 文件上实测踩坑）
            super::protocol::ack_cumulative(inflight, ack_seq);
            Ok(())
        }
        None => Err("等待 Mass 分片 ACK 超时 (timeout)".to_string()),
    }
}

fn hex16(s: &str) -> Option<Vec<u8>> {
    if s.len() != 32 {
        return None;
    }
    let mut out = Vec::with_capacity(16);
    let mut chars = s.chars();
    while let (Some(a), Some(b)) = (chars.next(), chars.next()) {
        let hi = a.to_digit(16)?;
        let lo = b.to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}
