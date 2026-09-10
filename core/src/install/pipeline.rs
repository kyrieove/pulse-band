//! 协议样本导入与端到端取证分析管线 (Capture Loader & Analysis Pipeline)

use std::fs;
use std::path::Path;
use super::inspector::hex_to_bytes;
use super::model::{CaptureBundle, CaptureMetadata, Result};
use super::recorder::InstallProtocolRecorder;
use super::report::ProtocolReportGenerator;

/// 样本合法性与安全脱敏校验器
#[allow(dead_code)]
pub struct SampleValidator;

#[allow(dead_code)]
impl SampleValidator {
    /// 校验元数据完整性
    pub fn validate_metadata(metadata: &CaptureMetadata) -> Result<()> {
        if metadata.capture_id.trim().is_empty() {
            return Err("样本校验失败: capture_id 不能为空".to_string());
        }
        if metadata.source.trim().is_empty() {
            return Err("样本校验失败: source 不能为空".to_string());
        }
        if metadata.device_model.trim().is_empty() {
            return Err("样本校验失败: device_model 不能为空".to_string());
        }
        if metadata.app_version.trim().is_empty() {
            return Err("样本校验失败: app_version 不能为空".to_string());
        }
        if metadata.analysis_status.trim().is_empty() {
            return Err("样本校验失败: analysis_status 不能为空".to_string());
        }
        Self::check_sanitization(&metadata.capture_id)?;
        Self::check_sanitization(&metadata.source)?;
        Self::check_sanitization(&metadata.notes)?;
        Ok(())
    }

    /// 校验数据帧格式与完整性
    pub fn validate_frames(recorder: &InstallProtocolRecorder) -> Result<()> {
        if recorder.packets.is_empty() {
            return Err("样本校验失败: 数据帧列表不能为空".to_string());
        }
        for (i, p) in recorder.packets.iter().enumerate() {
            if p.payload_hex.len() % 2 != 0 {
                return Err(format!("样本校验失败: 第 {i} 帧 payload_hex 长度非偶数"));
            }
            if p.payload_hex.len() / 2 != p.len as usize {
                return Err(format!(
                    "样本校验失败: 第 {i} 帧声明长度 {} 与载荷实际字节数 {} 不一致",
                    p.len,
                    p.payload_hex.len() / 2
                ));
            }
            let raw = hex_to_bytes(&p.payload_hex)
                .map_err(|e| format!("样本校验失败: 第 {i} 帧 Hex 解析异常: {e}"))?;
            let calc_crc = crate::crc::crc16_arc(&raw);
            if p.crc != calc_crc {
                return Err(format!(
                    "样本校验失败: 第 {i} 帧 CRC16 校验不匹配: 帧头声明 0x{:04x}, 实际计算 0x{:04x}",
                    p.crc, calc_crc
                ));
            }
        }
        Ok(())
    }

    /// 检查是否存在未脱敏的敏感字段或真实设备凭据
    pub fn check_sanitization(text: &str) -> Result<()> {
        let lower = text.to_ascii_lowercase();
        let sensitive_keywords = [
            "privatekey",
            "private_key",
            "install.local",
        ];
        for pat in &sensitive_keywords {
            if lower.contains(pat) {
                return Err(format!("敏感安全扫描拒绝: 包含未脱敏的敏感字样 '{pat}'"));
            }
        }

        let sensitive_key_values = [
            "token=", "token:", "secret=", "secret:", "credential=", "credential:",
        ];
        for pat in &sensitive_key_values {
            if lower.contains(pat) {
                return Err("敏感安全扫描拒绝: 包含敏感认证凭据键值对".to_string());
            }
        }

        // 蓝牙 MAC 格式检查：17 字符的 XX:XX:XX:XX:XX:XX 或 XX-XX-XX-XX-XX-XX
        for mac in find_mac_like(text) {
            let upper = mac.to_ascii_uppercase();
            if upper != "AA:BB:CC:DD:EE:FF" && upper != "AA-BB-CC-DD-EE-FF" && upper != "00:00:00:00:00:00" {
                return Err(format!(
                    "敏感安全扫描拒绝: 包含未经脱敏的真实蓝牙 MAC 地址 '{mac}'"
                ));
            }
        }

        Ok(())
    }

    /// 全面校验 CaptureBundle（元数据 + 帧 + 附带分析文档）
    pub fn validate_bundle(bundle: &CaptureBundle) -> Result<()> {
        Self::validate_metadata(&bundle.metadata)?;
        Self::validate_frames(&bundle.recorder)?;
        if let Some(analysis) = &bundle.analysis_markdown {
            Self::check_sanitization(analysis)?;
        }
        Ok(())
    }
}

fn find_mac_like(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    if bytes.len() < 17 {
        return found;
    }
    for i in 0..=bytes.len() - 17 {
        let slice = &bytes[i..i + 17];
        let sep1 = slice[2];
        if (sep1 == b':' || sep1 == b'-')
            && slice[5] == sep1
            && slice[8] == sep1
            && slice[11] == sep1
            && slice[14] == sep1
            && slice[0].is_ascii_hexdigit()
            && slice[1].is_ascii_hexdigit()
            && slice[3].is_ascii_hexdigit()
            && slice[4].is_ascii_hexdigit()
            && slice[6].is_ascii_hexdigit()
            && slice[7].is_ascii_hexdigit()
            && slice[9].is_ascii_hexdigit()
            && slice[10].is_ascii_hexdigit()
            && slice[12].is_ascii_hexdigit()
            && slice[13].is_ascii_hexdigit()
            && slice[15].is_ascii_hexdigit()
            && slice[16].is_ascii_hexdigit()
        {
            if let Ok(s) = std::str::from_utf8(slice) {
                found.push(s);
            }
        }
    }
    found
}

/// 协议样本导入器：负责从文件系统或 JSON 流中加载并反序列化样本
#[allow(dead_code)]
pub struct CaptureLoader;

#[allow(dead_code)]
impl CaptureLoader {
    /// 从 JSON 文本解析并构建 InstallProtocolRecorder
    pub fn load_from_json(json_str: &str) -> Result<InstallProtocolRecorder> {
        InstallProtocolRecorder::from_json(json_str)
    }

    /// 从单个捕获文件读取并加载 InstallProtocolRecorder
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<InstallProtocolRecorder> {
        let path_ref = path.as_ref();
        let content = fs::read_to_string(path_ref).map_err(|e| {
            format!(
                "读取捕获文件失败 '{}': {e}",
                path_ref.display()
            )
        })?;
        Self::load_from_json(&content)
    }

    /// 扫描指定目录下的所有 capture json 文件（自动忽略 manifest 清单与非 json 文件）
    pub fn load_from_dir<P: AsRef<Path>>(dir_path: P) -> Result<Vec<(String, InstallProtocolRecorder)>> {
        let dir_ref = dir_path.as_ref();
        let entries = fs::read_dir(dir_ref).map_err(|e| {
            format!("读取捕获目录失败 '{}': {e}", dir_ref.display())
        })?;

        let mut results = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|e| format!("遍历目录项失败: {e}"))?;
            let file_type = entry.file_type().map_err(|e| format!("获取文件类型失败: {e}"))?;
            if !file_type.is_file() {
                continue;
            }

            let path = entry.path();
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();

            // 仅载入 .json 文件，且显式过滤元数据清单文件
            if file_name.ends_with(".json") && !file_name.contains("manifest") {
                match Self::load_from_file(&path) {
                    Ok(recorder) => {
                        results.push((file_name, recorder));
                    }
                    Err(e) => {
                        return Err(format!(
                            "解析样本文件 '{}' 失败: {e}",
                            path.display()
                        ));
                    }
                }
            }
        }

        // 按文件名排序保持可重现确定性
        results.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(results)
    }

    /// 从指定的样本目录（包含 metadata.json 与 frames.json）读取完整的 CaptureBundle
    pub fn load_bundle_from_dir<P: AsRef<Path>>(bundle_dir: P) -> Result<CaptureBundle> {
        let dir_ref = bundle_dir.as_ref();
        let metadata_path = dir_ref.join("metadata.json");
        let frames_path = dir_ref.join("frames.json");
        let analysis_path = dir_ref.join("analysis.md");

        if !metadata_path.exists() {
            return Err(format!("样本目录缺失 metadata.json: '{}'", dir_ref.display()));
        }
        if !frames_path.exists() {
            return Err(format!("样本目录缺失 frames.json: '{}'", dir_ref.display()));
        }

        let meta_content = fs::read_to_string(&metadata_path).map_err(|e| {
            format!("读取 metadata.json 失败: {e}")
        })?;
        let metadata: CaptureMetadata = serde_json::from_str(&meta_content).map_err(|e| {
            format!("反序列化 metadata.json 失败: {e}")
        })?;

        let frames_content = fs::read_to_string(&frames_path).map_err(|e| {
            format!("读取 frames.json 失败: {e}")
        })?;
        let recorder = InstallProtocolRecorder::from_json(&frames_content)?;

        let analysis_markdown = if analysis_path.exists() {
            fs::read_to_string(&analysis_path).ok()
        } else {
            None
        };

        let bundle = CaptureBundle {
            metadata,
            recorder,
            analysis_markdown,
        };

        SampleValidator::validate_bundle(&bundle)?;
        Ok(bundle)
    }

    /// 扫描指定的 captures 根目录下所有的 capture_* 子目录 Bundle
    pub fn load_all_bundles<P: AsRef<Path>>(captures_dir: P) -> Result<Vec<CaptureBundle>> {
        let dir_ref = captures_dir.as_ref();
        let entries = fs::read_dir(dir_ref).map_err(|e| {
            format!("读取捕获目录失败 '{}': {e}", dir_ref.display())
        })?;

        let mut bundles = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("遍历目录项失败: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                if path.join("metadata.json").exists() && path.join("frames.json").exists() {
                    let bundle = Self::load_bundle_from_dir(&path)?;
                    bundles.push(bundle);
                }
            }
        }

        bundles.sort_by(|a, b| a.metadata.capture_id.cmp(&b.metadata.capture_id));
        Ok(bundles)
    }
}

/// 协议取证分析管线：串联 Capture -> Recorder -> Inspector -> ReportGenerator
#[allow(dead_code)]
pub struct ProtocolAnalysisPipeline;

#[allow(dead_code)]
impl ProtocolAnalysisPipeline {
    /// 从录制器直接驱动分析并生成 Markdown 报告
    pub fn run_from_recorder(recorder: &InstallProtocolRecorder) -> Result<String> {
        ProtocolReportGenerator::generate_markdown_report(recorder)
    }

    /// 从捕获 JSON 文本启动分析管线
    pub fn run_from_capture_json(json_str: &str) -> Result<String> {
        let recorder = CaptureLoader::load_from_json(json_str)?;
        Self::run_from_recorder(&recorder)
    }

    /// 从指定的单个捕获样本文件启动分析管线
    pub fn run_from_capture_file<P: AsRef<Path>>(path: P) -> Result<String> {
        let recorder = CaptureLoader::load_from_file(path)?;
        Self::run_from_recorder(&recorder)
    }

    /// 从 CaptureBundle 启动分析管线，生成包含样本元数据的完整报告
    pub fn run_bundle_pipeline(bundle: &CaptureBundle) -> Result<String> {
        ProtocolReportGenerator::generate_bundle_report(bundle)
    }

    /// 从指定的 capture_xxx 目录启动分析管线
    pub fn run_from_bundle_dir<P: AsRef<Path>>(bundle_dir: P) -> Result<String> {
        let bundle = CaptureLoader::load_bundle_from_dir(bundle_dir)?;
        Self::run_bundle_pipeline(&bundle)
    }

    /// 批量处理目录下的所有单文件样本并生成对应报告集合
    pub fn run_from_captures_dir<P: AsRef<Path>>(dir_path: P) -> Result<Vec<(String, String)>> {
        let loaded_samples = CaptureLoader::load_from_dir(dir_path)?;
        let mut reports = Vec::with_capacity(loaded_samples.len());

        for (name, recorder) in loaded_samples {
            let report = Self::run_from_recorder(&recorder)?;
            reports.push((name, report));
        }

        Ok(reports)
    }

    /// 批量处理目录下的所有 Bundle 样本并生成包含元数据的报告集合
    pub fn run_all_bundles_pipeline<P: AsRef<Path>>(captures_dir: P) -> Result<Vec<(String, String)>> {
        let bundles = CaptureLoader::load_all_bundles(captures_dir)?;
        let mut reports = Vec::with_capacity(bundles.len());

        for bundle in bundles {
            let id = bundle.metadata.capture_id.clone();
            let report = Self::run_bundle_pipeline(&bundle)?;
            reports.push((id, report));
        }

        Ok(reports)
    }
}
