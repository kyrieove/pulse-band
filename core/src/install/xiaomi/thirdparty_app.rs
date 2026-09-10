//! 小米快应用 ThirdpartyApp 与 AppInstaller 消息模型
//!
//! 依据源码证据：
//! - `OronBox/protos/xiaomi/wear_thirdparty_app.proto`
//! - `AstroBox-NG-Module-Pb/protos/xiaomi/wear_thirdparty_app.proto`

use super::super::model::Result;
use super::wire::*;

/// AppInstaller.Result 结果状态码
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum InstallResultCode {
    Success = 0,
    Failed = 1,
    VerifyFailed = 2,
}

impl InstallResultCode {
    pub fn from_u32(val: u32) -> Result<Self> {
        match val {
            0 => Ok(Self::Success),
            1 => Ok(Self::Failed),
            2 => Ok(Self::VerifyFailed),
            other => Err(format!("未知的 InstallResultCode: {other}")),
        }
    }

    pub fn as_u32(self) -> u32 {
        self as u32
    }
}

/// AppInstaller.Request
///
/// 字段：
/// - tag 1: required string package_name
/// - tag 2: required uint32 version_code
/// - tag 3: required uint32 package_size
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInstallerRequest {
    pub package_name: String,
    pub version_code: u32,
    pub package_size: u32,
}

impl AppInstallerRequest {
    pub fn new(package_name: impl Into<String>, version_code: u32, package_size: u32) -> Self {
        Self {
            package_name: package_name.into(),
            version_code,
            package_size,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_string_field(&mut buf, 1, &self.package_name);
        write_u32_field(&mut buf, 2, self.version_code);
        write_u32_field(&mut buf, 3, self.package_size);
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut package_name = None;
        let mut version_code = None;
        let mut package_size = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::LengthDelimited(s) = f.value {
                        package_name = Some(
                            String::from_utf8(s.to_vec())
                                .map_err(|e| format!("非法的 package_name UTF-8: {e}"))?,
                        );
                    }
                }
                2 => {
                    if let WireValue::Varint(v) = f.value {
                        version_code = Some(v as u32);
                    }
                }
                3 => {
                    if let WireValue::Varint(v) = f.value {
                        package_size = Some(v as u32);
                    }
                }
                _ => {} // 忽略未识别字段以保证向前兼容
            }
        }

        let package_name =
            package_name.ok_or_else(|| "缺少必填字段 package_name (tag 1)".to_string())?;
        if package_name.is_empty() {
            return Err("package_name 不能为空".to_string());
        }
        let version_code =
            version_code.ok_or_else(|| "缺少必填字段 version_code (tag 2)".to_string())?;
        let package_size =
            package_size.ok_or_else(|| "缺少必填字段 package_size (tag 3)".to_string())?;

        Ok(Self {
            package_name,
            version_code,
            package_size,
        })
    }
}

/// AppInstaller.Response
///
/// 字段：
/// - tag 1: required PrepareStatus prepare_status (0=READY, 1=BUSY, ...)
/// - tag 2: optional uint32 expected_slice_length
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInstallerResponse {
    pub prepare_status: u32,
    pub expected_slice_length: Option<u32>,
}

impl AppInstallerResponse {
    pub fn new(prepare_status: u32, expected_slice_length: Option<u32>) -> Self {
        Self {
            prepare_status,
            expected_slice_length,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.prepare_status == 0
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_u32_field(&mut buf, 1, self.prepare_status);
        if let Some(slice_len) = self.expected_slice_length {
            write_u32_field(&mut buf, 2, slice_len);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut prepare_status = None;
        let mut expected_slice_length = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::Varint(v) = f.value {
                        prepare_status = Some(v as u32);
                    }
                }
                2 => {
                    if let WireValue::Varint(v) = f.value {
                        expected_slice_length = Some(v as u32);
                    }
                }
                _ => {}
            }
        }

        let prepare_status =
            prepare_status.ok_or_else(|| "缺少必填字段 prepare_status (tag 1)".to_string())?;
        Ok(Self {
            prepare_status,
            expected_slice_length,
        })
    }
}

/// AppInstaller.Result
///
/// 字段：
/// - tag 1: required Code code (0=SUCCESS, 1=FAILED, 2=VERIFY_FAILED)
/// - tag 2: optional string package_name
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInstallerResult {
    pub code: InstallResultCode,
    pub package_name: Option<String>,
}

impl AppInstallerResult {
    pub fn new(code: InstallResultCode, package_name: Option<String>) -> Self {
        Self { code, package_name }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        write_u32_field(&mut buf, 1, self.code.as_u32());
        if let Some(name) = &self.package_name {
            write_string_field(&mut buf, 2, name);
        }
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let fields = parse_fields(bytes)?;
        let mut code = None;
        let mut package_name = None;

        for f in fields {
            match f.tag {
                1 => {
                    if let WireValue::Varint(v) = f.value {
                        code = Some(InstallResultCode::from_u32(v as u32)?);
                    }
                }
                2 => {
                    if let WireValue::LengthDelimited(s) = f.value {
                        package_name = Some(
                            String::from_utf8(s.to_vec())
                                .map_err(|e| format!("非法的 package_name UTF-8: {e}"))?,
                        );
                    }
                }
                _ => {}
            }
        }

        let code = code.ok_or_else(|| "缺少必填字段 code (tag 1)".to_string())?;
        Ok(Self { code, package_name })
    }
}

/// ThirdpartyApp 载荷变体
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThirdpartyAppPayload {
    InstallRequest(AppInstallerRequest),   // tag 2
    InstallResponse(AppInstallerResponse), // tag 3
    InstallResult(AppInstallerResult),     // tag 4
    Raw(u32, Vec<u8>),
}

/// ThirdpartyApp 消息顶层结构体
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThirdpartyApp {
    pub payload: Option<ThirdpartyAppPayload>,
}

#[allow(dead_code)]
impl ThirdpartyApp {
    pub fn from_install_request(req: AppInstallerRequest) -> Self {
        Self {
            payload: Some(ThirdpartyAppPayload::InstallRequest(req)),
        }
    }

    pub fn from_install_response(resp: AppInstallerResponse) -> Self {
        Self {
            payload: Some(ThirdpartyAppPayload::InstallResponse(resp)),
        }
    }

    pub fn from_install_result(res: AppInstallerResult) -> Self {
        Self {
            payload: Some(ThirdpartyAppPayload::InstallResult(res)),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(payload) = &self.payload {
            match payload {
                ThirdpartyAppPayload::InstallRequest(req) => {
                    write_bytes_field(&mut buf, 2, &req.encode());
                }
                ThirdpartyAppPayload::InstallResponse(resp) => {
                    write_bytes_field(&mut buf, 3, &resp.encode());
                }
                ThirdpartyAppPayload::InstallResult(res) => {
                    write_bytes_field(&mut buf, 4, &res.encode());
                }
                ThirdpartyAppPayload::Raw(tag, data) => {
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
                2 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let req = AppInstallerRequest::decode(b)?;
                        payload = Some(ThirdpartyAppPayload::InstallRequest(req));
                    }
                }
                3 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let resp = AppInstallerResponse::decode(b)?;
                        payload = Some(ThirdpartyAppPayload::InstallResponse(resp));
                    }
                }
                4 => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        let res = AppInstallerResult::decode(b)?;
                        payload = Some(ThirdpartyAppPayload::InstallResult(res));
                    }
                }
                other => {
                    if let WireValue::LengthDelimited(b) = f.value {
                        payload = Some(ThirdpartyAppPayload::Raw(other, b.to_vec()));
                    }
                }
            }
        }

        Ok(Self { payload })
    }
}
