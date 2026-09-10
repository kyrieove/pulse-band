//! 协议样本导入与端到端取证分析管线 (Capture Loader & Analysis Pipeline)

use std::fs;
use std::path::Path;
use super::model::Result;
use super::recorder::InstallProtocolRecorder;
use super::report::ProtocolReportGenerator;

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

    /// 批量处理目录下的所有样本文件并生成对应报告集合
    pub fn run_from_captures_dir<P: AsRef<Path>>(dir_path: P) -> Result<Vec<(String, String)>> {
        let loaded_samples = CaptureLoader::load_from_dir(dir_path)?;
        let mut reports = Vec::with_capacity(loaded_samples.len());

        for (name, recorder) in loaded_samples {
            let report = Self::run_from_recorder(&recorder)?;
            reports.push((name, report));
        }

        Ok(reports)
    }
}
