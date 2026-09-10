//! 协议分析报告生成器 (Protocol Report Generator)

use super::inspector::{hex_to_bytes, ProtocolInspector};
use super::model::{CaptureBundle, CaptureMetadata, Result};
use super::recorder::{InstallProtocolRecorder, PacketDirection};

/// 协议分析报告生成器：解析录制记录并生成结构化 Markdown 报告
#[allow(dead_code)]
pub struct ProtocolReportGenerator;

#[allow(dead_code)]
impl ProtocolReportGenerator {
    /// 从录制器 JSON 文本生成 Markdown 格式的完整协议分析报告
    pub fn generate_markdown_from_json(json_str: &str) -> Result<String> {
        let recorder = InstallProtocolRecorder::from_json(json_str)?;
        Self::generate_markdown_report(&recorder)
    }

    /// 从已有的录制器实例生成通用 Markdown 报告
    pub fn generate_markdown_report(recorder: &InstallProtocolRecorder) -> Result<String> {
        let mut out = String::new();
        out.push_str("# 协议取证与流量分析报告 (Protocol Capture Analysis Report)\n\n");
        Self::append_report_body(&mut out, recorder)?;
        Ok(out)
    }

    /// 从 CaptureBundle 生成完整报告（包含 capture_id、source 与元数据信息）
    pub fn generate_bundle_report(bundle: &CaptureBundle) -> Result<String> {
        Self::generate_markdown_report_with_metadata(&bundle.recorder, &bundle.metadata)
    }

    /// 包含 Capture 元数据的结构化 Markdown 报告生成
    pub fn generate_markdown_report_with_metadata(
        recorder: &InstallProtocolRecorder,
        metadata: &CaptureMetadata,
    ) -> Result<String> {
        let mut out = String::new();
        out.push_str("# 协议取证与流量分析报告 (Protocol Capture Analysis Report)\n\n");

        // 0. 样本捕获元数据关联
        out.push_str("## 0. 捕获样本元数据 (Capture Metadata)\n\n");
        out.push_str(&format!("- **Capture ID**: `{}`\n", metadata.capture_id));
        out.push_str(&format!("- **捕获来源 (Source)**: `{}`\n", metadata.source));
        out.push_str(&format!("- **目标设备 (Device Model)**: `{}`\n", metadata.device_model));
        out.push_str(&format!("- **App 版本 (App Version)**: `{}`\n", metadata.app_version));
        out.push_str(&format!("- **捕获时间戳 (Timestamp)**: {}\n", metadata.timestamp));
        out.push_str(&format!("- **分析状态 (Analysis Status)**: `{}`\n", metadata.analysis_status));
        if !metadata.notes.trim().is_empty() {
            out.push_str(&format!("- **说明备注 (Notes)**: {}\n", metadata.notes));
        }
        out.push('\n');

        Self::append_report_body(&mut out, recorder)?;
        Ok(out)
    }

    fn append_report_body(out: &mut String, recorder: &InstallProtocolRecorder) -> Result<()> {

        let total_frames = recorder.packets.len();
        let mut host_to_band_count = 0usize;
        let mut band_to_host_count = 0usize;
        let mut type_counts: std::collections::BTreeMap<u8, usize> = std::collections::BTreeMap::new();
        let mut payload_counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        let mut total_payload_bytes = 0usize;
        let mut min_len = usize::MAX;
        let mut max_len = 0usize;
        let mut protobuf_candidates: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();

        for p in &recorder.packets {
            match p.direction {
                PacketDirection::HostToBand => host_to_band_count += 1,
                PacketDirection::BandToHost => band_to_host_count += 1,
            }
            *type_counts.entry(p.frame_type).or_insert(0) += 1;
            *payload_counts.entry(p.payload_hex.clone()).or_insert(0) += 1;

            let p_len = p.len as usize;
            total_payload_bytes += p_len;
            if p_len < min_len {
                min_len = p_len;
            }
            if p_len > max_len {
                max_len = p_len;
            }

            if let Ok(raw) = hex_to_bytes(&p.payload_hex) {
                let insp = ProtocolInspector::try_inspect_protobuf(&raw);
                if insp.success {
                    for tag in insp.field_tags {
                        *protobuf_candidates.entry(tag).or_insert(0) += 1;
                    }
                }
            }
        }

        if total_frames == 0 {
            min_len = 0;
        }
        let avg_len = if total_frames > 0 {
            total_payload_bytes as f64 / total_frames as f64
        } else {
            0.0
        };

        // 1. 方向与总量统计
        out.push_str("## 1. 流量概要与方向统计\n\n");
        out.push_str(&format!("- **总捕获帧数**: {}\n", total_frames));
        out.push_str(&format!("- **Host -> Band (下发)**: {} 帧\n", host_to_band_count));
        out.push_str(&format!("- **Band -> Host (上报)**: {} 帧\n\n", band_to_host_count));

        // 2. Frame Type 分布统计
        out.push_str("## 2. Frame Type 分布统计\n\n");
        out.push_str("| Frame Type | 含义说明 | 出现次数 | 占比 |\n");
        out.push_str("| :--- | :--- | :--- | :--- |\n");
        for (&ftype, &count) in &type_counts {
            let desc = match ftype {
                0x01 => "ACK 确认帧",
                0x02 => "Negotiation 链路协商帧",
                0x03 => "Business/Auth 业务或握手数据帧",
                _ => "未知或保留帧类型",
            };
            let pct = if total_frames > 0 {
                (count as f64 / total_frames as f64) * 100.0
            } else {
                0.0
            };
            out.push_str(&format!(
                "| `0x{:02x}` | {} | {} | {:.1}% |\n",
                ftype, desc, count, pct
            ));
        }
        out.push('\n');

        // 3. Payload 长度统计
        out.push_str("## 3. Payload 长度统计\n\n");
        out.push_str(&format!("- **总载荷字节数**: {} 字节\n", total_payload_bytes));
        out.push_str(&format!("- **最小 Payload 长度**: {} 字节\n", min_len));
        out.push_str(&format!("- **最大 Payload 长度**: {} 字节\n", max_len));
        out.push_str(&format!("- **平均 Payload 长度**: {:.2} 字节\n\n", avg_len));

        // 4. 重复 Payload 检测
        out.push_str("## 4. 重复 Payload 检测\n\n");
        let duplicate_payloads: Vec<_> = payload_counts
            .iter()
            .filter(|(_, &count)| count > 1)
            .collect();
        if duplicate_payloads.is_empty() {
            out.push_str("未检测到重复载荷，所有帧载荷均唯一。\n\n");
        } else {
            out.push_str("| Payload Hex 摘要 (前32字节) | 出现频次 | 说明 |\n");
            out.push_str("| :--- | :--- | :--- |\n");
            for (hex, count) in duplicate_payloads {
                let display_hex = if hex.len() > 64 {
                    format!("{}...", &hex[..64])
                } else if hex.is_empty() {
                    "(空载荷)".to_string()
                } else {
                    hex.clone()
                };
                out.push_str(&format!(
                    "| `{}` | {} 次 | 疑似固定握手/ACK应答/心跳重传 |\n",
                    display_hex, count
                ));
            }
            out.push('\n');
        }

        // 5. Protobuf 字段候选
        out.push_str("## 5. Protobuf 字段候选\n\n");
        if protobuf_candidates.is_empty() {
            out.push_str("未在有效载荷中探测到符合 Protobuf WireType 规范的明文字段（载荷可能为 TLV、原始流或密文）。\n\n");
        } else {
            out.push_str("| Tag (Field Number) | 出现频次 | 推测用途与候选分析 |\n");
            out.push_str("| :--- | :--- | :--- |\n");
            for (&tag, &count) in &protobuf_candidates {
                let desc = match tag {
                    1 => "常见基础字段 (type / package_name)",
                    2 => "常见二级字段 (id / fingerprint / hash)",
                    8 => "WearPacket 下行消息 (SEND_PHONE_MESSAGE)",
                    9 => "WearPacket 上行消息 (SEND_WEAR_MESSAGE)",
                    22 => "ThirdpartyApp 业务扩展容器",
                    _ => "协议候选字段",
                };
                out.push_str(&format!("| `{}` | {} 次 | {} |\n", tag, count, desc));
            }
            out.push('\n');
        }

        // 6. Frame 时间线详细记录
        out.push_str("## 6. Frame 时间线详细记录\n\n");
        out.push_str("| 序号 | 时间戳 (ms) | 方向 | Type | Seq | Len | CRC16 | Payload Hex |\n");
        out.push_str("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n");
        for (i, p) in recorder.packets.iter().enumerate() {
            let dir_str = match p.direction {
                PacketDirection::HostToBand => "Host -> Band",
                PacketDirection::BandToHost => "Band -> Host",
            };
            let short_hex = if p.payload_hex.len() > 24 {
                format!("{}...", &p.payload_hex[..24])
            } else {
                p.payload_hex.clone()
            };
            out.push_str(&format!(
                "| {} | {} | {} | `0x{:02x}` | {} | {} | `0x{:04x}` | `{}` |\n",
                i + 1,
                p.timestamp_ms,
                dir_str,
                p.frame_type,
                p.seq,
                p.len,
                p.crc,
                short_hex
            ));
        }
        out.push('\n');

        Ok(())
    }
}
