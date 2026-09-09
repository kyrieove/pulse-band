//! 会话认证状态机（阶段 5C 纯离线实现）
//!
//! 协议与算法依据：
//! - docs/protocol/auth.md §2（确定公式与握手四步）
//! - docs/protocol/transport.md §1~§4（帧结构：A5A5 | type | seq | len | chk | payload）
//! - tools/verify_auth.py（离线密码学基准）
//!
//! 硬性纪律：
//! - 不包含任何真实 authkey / 会话密钥 / challenge / response。
//! - 日志与 Debug 格式化只使用占位符（如 `<authkey:16B>`, `<session-key:16B>`）。
//! - 密码学使用成熟 crate（hmac, sha2, aes, ccm, hkdf），禁止手写原语。
//! - 状态必须显式：Disconnected / TransportConnected / Authenticating / Authenticated / Failed。
//! - 任何校验失败、错误 HMAC、损坏 tag、confirm=false、字段缺失、乱序、超时、断链均转入 Failed 终态。

use std::collections::BTreeMap;
use std::fmt;

use aes::Aes128;
use ccm::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    consts::{U12, U4},
    Ccm,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{thread_rng, RngCore};
use sha2::Sha256;

use crate::frame::Frame;

pub type Aes128Ccm = Ccm<Aes128, U4, U12>;
pub type HmacSha256 = Hmac<Sha256>;

/// 会话认证错误枚举
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// 帧结构或格式错误
    InvalidFrameFormat(&'static str),
    /// 非预期的帧类型或状态乱序
    UnexpectedFrame(&'static str),
    /// Protobuf 字段缺失或类型错误
    ProtobufFieldMissing(&'static str),
    /// Protobuf wire 解码失败
    ProtobufDecodeFailed(&'static str),
    /// Step 2 HMAC 签名不匹配（设备应答校验失败）
    HmacMismatch,
    /// Step 3 CCM 加密/解密或 tag 校验失败
    CcmError,
    /// Step 4 手环明确拒绝认证（confirm_result == false）
    ConfirmRejected,
    /// 在当前状态下不可执行该操作
    InvalidStateTransition(&'static str),
    /// 会话超时
    Timeout,
    /// 传输链路断开
    LinkBroken,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFrameFormat(msg) => write!(f, "帧格式错误: {msg}"),
            Self::UnexpectedFrame(msg) => write!(f, "非预期/乱序帧: {msg}"),
            Self::ProtobufFieldMissing(msg) => write!(f, "缺少必需字段: {msg}"),
            Self::ProtobufDecodeFailed(msg) => write!(f, "Protobuf解码失败: {msg}"),
            Self::HmacMismatch => write!(f, "HMAC-SHA256 签名校验不匹配"),
            Self::CcmError => write!(f, "AES-128-CCM 认证加密/解密失败"),
            Self::ConfirmRejected => write!(f, "手环拒绝认证 (confirm_result=false)"),
            Self::InvalidStateTransition(msg) => write!(f, "非法状态转移: {msg}"),
            Self::Timeout => write!(f, "会话认证超时"),
            Self::LinkBroken => write!(f, "底层链路断开"),
        }
    }
}

impl std::error::Error for SessionError {}

/// 认证进行中子状态
#[derive(Clone, PartialEq, Eq)]
pub enum AuthSubstate {
    /// 已发送 Step 1 (AppVerify)，等待接收 Step 2 (DeviceVerify)
    AwaitingDeviceVerify {
        /// Phone Nonce (P, 16B)
        app_random: [u8; 16],
    },
    /// 已发送 Step 3 (AppConfirm)，等待接收 Step 4 (DeviceConfirm)
    AwaitingDeviceConfirm {
        /// Band -> Host 密钥 (16B)
        dec_key: [u8; 16],
        /// Host -> Band 密钥 (16B)
        enc_key: [u8; 16],
        /// 接收方向计数器基准 (4B)
        dec_nonce_cm: [u8; 4],
        /// 发送方向计数器基准 (4B)
        enc_nonce_cm: [u8; 4],
    },
}

impl fmt::Debug for AuthSubstate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AwaitingDeviceVerify { .. } => {
                write!(f, "AwaitingDeviceVerify {{ app_random: <nonce:16B> }}")
            }
            Self::AwaitingDeviceConfirm { .. } => write!(
                f,
                "AwaitingDeviceConfirm {{ dec_key: <key:16B>, enc_key: <key:16B> }}"
            ),
        }
    }
}

/// 显式会话状态枚举（按 docs/protocol/auth.md §4 定义）
#[derive(Clone, PartialEq, Eq)]
pub enum SessionState {
    /// 未连接（初始断开或已完全终止）
    Disconnected,
    /// 传输层已建立连接（RFCOMM 就绪），尚未发起认证握手
    TransportConnected,
    /// 认证流程进行中（Step 1 ~ Step 3）
    Authenticating(AuthSubstate),
    /// 认证通过（已完成 Step 4 且 confirm_result == true）
    Authenticated {
        /// 协商完成的解密密钥 (Band -> Host, 16B)
        dec_key: [u8; 16],
        /// 协商完成的加密密钥 (Host -> Band, 16B)
        enc_key: [u8; 16],
    },
    /// 认证或会话已失败（终态，停止任何后续交互，不可逆）
    Failed(SessionError),
}

impl fmt::Debug for SessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disconnected => write!(f, "Disconnected"),
            Self::TransportConnected => write!(f, "TransportConnected"),
            Self::Authenticating(sub) => write!(f, "Authenticating({sub:?})"),
            Self::Authenticated { .. } => write!(
                f,
                "Authenticated {{ dec_key: <key:16B>, enc_key: <key:16B> }}"
            ),
            Self::Failed(err) => write!(f, "Failed({err})"),
        }
    }
}

/// 会话认证状态机
pub struct Session {
    state: SessionState,
    /// 16 字节认证凭据
    authkey: [u8; 16],
    /// 伴随设备类型枚举（用于 Step 3 CompanionDevice，抓包实测取值为 1）
    device_type: u64,
    /// 伴随设备名称（用于 Step 3 CompanionDevice，长度与抓包中 7B 一致）
    device_name: String,
    /// 伴随设备能力标识（用于 Step 3 CompanionDevice，抓包实测为 0xFFFFFFFF）
    app_capability: u32,
    /// 本地发送序号计数器
    seq_out: u8,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("state", &self.state)
            .field("authkey", &"<authkey:16B>")
            .field("device_type", &self.device_type)
            .field("device_name", &self.device_name)
            .field("app_capability", &self.app_capability)
            .field("seq_out", &self.seq_out)
            .finish()
    }
}

impl Session {
    /// 使用指定的 authkey 创建处于 TransportConnected 状态的会话实例
    pub fn new(authkey: [u8; 16]) -> Self {
        Self::with_companion(authkey, 1, "OronBox", 0xFFFFFFFF)
    }

    /// 创建自定义伴随设备参数的会话实例（测试专用或参数化配置）
    pub fn with_companion(
        authkey: [u8; 16],
        device_type: u64,
        device_name: &str,
        app_capability: u32,
    ) -> Self {
        Self {
            state: SessionState::TransportConnected,
            authkey,
            device_type,
            device_name: device_name.to_string(),
            app_capability,
            seq_out: 0,
        }
    }

    /// 获取当前会话状态
    pub fn state(&self) -> &SessionState {
        &self.state
    }

    /// 发起认证握手（生成 Step 1 AppVerify 帧）
    ///
    /// 若未提供 app_random，则使用系统 CSPRNG 随机生成 16 字节
    pub fn start_auth(&mut self, app_random: Option<[u8; 16]>) -> Result<Frame, SessionError> {
        if self.state != SessionState::TransportConnected {
            let err = SessionError::InvalidStateTransition(
                "只有处于 TransportConnected 状态才能发起 start_auth",
            );
            self.state = SessionState::Failed(err.clone());
            return Err(err);
        }

        let p_nonce = match app_random {
            Some(r) => r,
            None => {
                let mut buf = [0u8; 16];
                thread_rng().fill_bytes(&mut buf);
                buf
            }
        };

        // 构造 Step 1:
        // command: type=1, id=26
        // account: field 30 (AppVerify) -> field 1: app_random (16B)
        let step1_payload = build_step1_payload(&p_nonce);
        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: step1_payload,
        };

        self.state = SessionState::Authenticating(AuthSubstate::AwaitingDeviceVerify {
            app_random: p_nonce,
        });

        Ok(frame)
    }

    /// 处理从对端接收到的数据帧
    ///
    /// 返回 Ok(Some(frame)) 表示状态机产出了应向对端回复的帧；
    /// 返回 Ok(None) 表示处理成功且无需回包（例如已最终完成认证）；
    /// 返回 Err(err) 表示遇到错误，状态机已不可逆转移至 Failed 状态并停止连接。
    pub fn process_frame(&mut self, frame: &Frame) -> Result<Option<Frame>, SessionError> {
        // 如果已经是失败或断开终态，拒绝处理新帧
        if let SessionState::Failed(ref err) = self.state {
            return Err(err.clone());
        }
        if self.state == SessionState::Disconnected {
            return Err(SessionError::InvalidStateTransition("会话已处于 Disconnected"));
        }

        // 会话握手帧要求 type=0x03 且 payload 前缀为 01 01
        if frame.frame_type != 0x03 {
            // type=0x01 ACK 帧在传输层处理，若透传进会话层则在此忽略，不破坏会话
            if frame.frame_type == 0x01 {
                return Ok(None);
            }
            let err = SessionError::UnexpectedFrame("收到非 0x03 握手帧");
            self.state = SessionState::Failed(err.clone());
            return Err(err);
        }

        if frame.payload.len() < 2 || &frame.payload[0..2] != [0x01, 0x01] {
            let err = SessionError::InvalidFrameFormat("payload 前缀非 01 01 认证指令");
            self.state = SessionState::Failed(err.clone());
            return Err(err);
        }

        let protobuf_data = &frame.payload[2..];

        match self.state {
            SessionState::Authenticating(AuthSubstate::AwaitingDeviceVerify { app_random }) => {
                // 处理 Step 2 (DeviceVerify) 并产出 Step 3 (AppConfirm)
                let step3_frame = match self.handle_step2(app_random, protobuf_data) {
                    Ok(frame) => frame,
                    Err(err) => {
                        self.state = SessionState::Failed(err.clone());
                        return Err(err);
                    }
                };
                Ok(Some(step3_frame))
            }
            SessionState::Authenticating(AuthSubstate::AwaitingDeviceConfirm {
                dec_key,
                enc_key,
                ..
            }) => {
                // 处理 Step 4 (DeviceConfirm)
                match self.handle_step4(dec_key, enc_key, protobuf_data) {
                    Ok(()) => Ok(None),
                    Err(err) => {
                        self.state = SessionState::Failed(err.clone());
                        return Err(err);
                    }
                }
            }
            _ => {
                // 在非等待状态收到认证握手帧属于乱序或重复包，严格转入 Failed
                let err = SessionError::UnexpectedFrame("当前状态非等待认证帧状态（乱序或重复包）");
                self.state = SessionState::Failed(err.clone());
                return Err(err);
            }
        }
    }

    /// 链路超时处理：立即转入 Failed 终态
    pub fn handle_timeout(&mut self) {
        self.state = SessionState::Failed(SessionError::Timeout);
    }

    /// 链路断开处理：立即转入 Failed 终态
    pub fn handle_disconnect(&mut self) {
        self.state = SessionState::Failed(SessionError::LinkBroken);
    }

    /// 获取已认证成功的业务密钥（Band->Host dec_key, Host->Band enc_key）
    ///
    /// TODO: 业务 01 02 CTR 加解密接口（仍是假设，留待后续阶段）
    pub fn business_keys(&self) -> Result<([u8; 16], [u8; 16]), SessionError> {
        match self.state {
            SessionState::Authenticated { dec_key, enc_key } => Ok((dec_key, enc_key)),
            _ => Err(SessionError::InvalidStateTransition("会话尚未完成认证")),
        }
    }

    fn next_seq(&mut self) -> u8 {
        let seq = self.seq_out;
        self.seq_out = self.seq_out.wrapping_add(1);
        seq
    }

    /// 内部解析与校验 Step 2，并生成 Step 3 帧
    fn handle_step2(
        &mut self,
        p_nonce: [u8; 16],
        data: &[u8],
    ) -> Result<Frame, SessionError> {
        let cmd = parse_protobuf(data)?;
        let msg_type = extract_one_varint(&cmd, 1)?;
        let msg_id = extract_one_varint(&cmd, 2)?;
        if msg_type != 1 || msg_id != 26 {
            return Err(SessionError::UnexpectedFrame(
                "Step 2 的 type/id 不匹配（预期 type=1, id=26）",
            ));
        }

        let account_bytes = extract_one_bytes(&cmd, 3)?;
        let account = parse_protobuf(account_bytes)?;
        let device_verify_bytes = extract_one_bytes(&account, 31)?;
        let device_verify = parse_protobuf(device_verify_bytes)?;

        let w_nonce_bytes = extract_one_bytes(&device_verify, 1)?;
        if w_nonce_bytes.len() != 16 {
            return Err(SessionError::ProtobufFieldMissing("device_random 长度必须为 16B"));
        }
        let mut w_nonce = [0u8; 16];
        w_nonce.copy_from_slice(w_nonce_bytes);

        let received_device_sign = extract_one_bytes(&device_verify, 2)?;
        if received_device_sign.len() != 32 {
            return Err(SessionError::ProtobufFieldMissing("device_sign 长度必须为 32B"));
        }

        // 密钥派生：
        // PRK = HMAC(key = P || W, msg = A)
        // OKM = HKDF-Expand(PRK, info = "miwear-auth", 64B)
        let (dec_key, enc_key, dec_nonce_cm, enc_nonce_cm) =
            derive_session_keys(&self.authkey, &p_nonce, &w_nonce)?;

        // 校验 device_sign = HMAC(key = dec_key, msg = W || P)
        let expected_device_sign = compute_hmac_sign(&dec_key, &w_nonce, &p_nonce);
        if received_device_sign != expected_device_sign.as_slice() {
            return Err(SessionError::HmacMismatch);
        }

        // 校验通过，构造 Step 3 (AppConfirm):
        // app_sign = HMAC(key = enc_key, msg = P || W)
        let app_sign = compute_hmac_sign(&enc_key, &p_nonce, &w_nonce);

        // CompanionDevice plaintext 序列化
        let plaintext_companion = build_companion_device_plaintext(
            self.device_type,
            &self.device_name,
            self.app_capability,
        );

        // AES-128-CCM 加密 CompanionDevice:
        // nonce = enc_nonce_cm || 8 个零字节 (12B)
        // AAD = 空
        let mut nonce12 = [0u8; 12];
        nonce12[0..4].copy_from_slice(&enc_nonce_cm);
        let encrypt_companion_device = ccm_encrypt_4b_tag(&enc_key, &nonce12, &plaintext_companion)?;

        let step3_payload = build_step3_payload(&app_sign, &encrypt_companion_device);
        let frame = Frame {
            frame_type: 0x03,
            seq: self.next_seq(),
            payload: step3_payload,
        };

        // 转移至等待 Step 4
        self.state = SessionState::Authenticating(AuthSubstate::AwaitingDeviceConfirm {
            dec_key,
            enc_key,
            dec_nonce_cm,
            enc_nonce_cm,
        });

        Ok(frame)
    }

    /// 内部解析与校验 Step 4
    fn handle_step4(
        &mut self,
        dec_key: [u8; 16],
        enc_key: [u8; 16],
        data: &[u8],
    ) -> Result<(), SessionError> {
        let cmd = parse_protobuf(data)?;
        let msg_type = extract_one_varint(&cmd, 1)?;
        let msg_id = extract_one_varint(&cmd, 2)?;
        if msg_type != 1 || msg_id != 27 {
            return Err(SessionError::UnexpectedFrame(
                "Step 4 的 type/id 不匹配（预期 type=1, id=27）",
            ));
        }

        let account_bytes = extract_one_bytes(&cmd, 3)?;
        let account = parse_protobuf(account_bytes)?;
        let device_confirm_bytes = extract_one_bytes(&account, 33)?;
        let device_confirm = parse_protobuf(device_confirm_bytes)?;

        let confirm_result_varint = extract_one_varint(&device_confirm, 1)?;
        if confirm_result_varint != 1 {
            // confirm_result == false 或非 1
            return Err(SessionError::ConfirmRejected);
        }

        // 成功升级为 Authenticated 终态
        self.state = SessionState::Authenticated { dec_key, enc_key };
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// 密码学原语绑定（全部走 mature crates）
// -----------------------------------------------------------------------------

/// HKDF-SHA256 派生会话密钥材料
///
/// 公式依据（docs/protocol/auth.md §2）：
/// PRK = HMAC(key = P || W, msg = A)
/// T1  = HMAC(key = PRK, msg = ASCII("miwear-auth") || 0x01)
/// T2  = HMAC(key = PRK, msg = T1 || ASCII("miwear-auth") || 0x02)
/// OKM = T1 || T2 (共 64B)
/// dec_key = OKM[0:16]
/// enc_key = OKM[16:32]
/// dec_nonce_cm = OKM[32:36]
/// enc_nonce_cm = OKM[36:40]
pub fn derive_session_keys(
    authkey: &[u8; 16],
    p_nonce: &[u8; 16],
    w_nonce: &[u8; 16],
) -> Result<([u8; 16], [u8; 16], [u8; 4], [u8; 4]), SessionError> {
    let mut salt = [0u8; 32];
    salt[0..16].copy_from_slice(p_nonce);
    salt[16..32].copy_from_slice(w_nonce);

    let hk = Hkdf::<Sha256>::new(Some(&salt), authkey);
    let mut okm = [0u8; 64];
    hk.expand(b"miwear-auth", &mut okm)
        .map_err(|_| SessionError::CcmError)?;

    let mut dec_key = [0u8; 16];
    let mut enc_key = [0u8; 16];
    let mut dec_nonce_cm = [0u8; 4];
    let mut enc_nonce_cm = [0u8; 4];

    dec_key.copy_from_slice(&okm[0..16]);
    enc_key.copy_from_slice(&okm[16..32]);
    dec_nonce_cm.copy_from_slice(&okm[32..36]);
    enc_nonce_cm.copy_from_slice(&okm[36..40]);

    Ok((dec_key, enc_key, dec_nonce_cm, enc_nonce_cm))
}

/// 计算 HMAC-SHA256 签名（32 字节）
pub fn compute_hmac_sign(key: &[u8; 16], nonce_a: &[u8; 16], nonce_b: &[u8; 16]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("16B key is valid for HMAC");
    mac.update(nonce_a);
    mac.update(nonce_b);
    let result = mac.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result.into_bytes());
    out
}

/// 使用 AES-128-CCM 加密，4 字节 tag（密文末尾附加 4 字节 tag）
pub fn ccm_encrypt_4b_tag(
    key: &[u8; 16],
    nonce12: &[u8; 12],
    plaintext: &[u8],
) -> Result<Vec<u8>, SessionError> {
    let cipher = Aes128Ccm::new_from_slice(key).map_err(|_| SessionError::CcmError)?;
    let nonce = GenericArray::from_slice(nonce12);
    cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| SessionError::CcmError)
}

/// 使用 AES-128-CCM 解密，校验 4 字节 tag
pub fn ccm_decrypt_4b_tag(
    key: &[u8; 16],
    nonce12: &[u8; 12],
    ciphertext_with_tag: &[u8],
) -> Result<Vec<u8>, SessionError> {
    let cipher = Aes128Ccm::new_from_slice(key).map_err(|_| SessionError::CcmError)?;
    let nonce = GenericArray::from_slice(nonce12);
    cipher
        .decrypt(nonce, ciphertext_with_tag)
        .map_err(|_| SessionError::CcmError)
}

// -----------------------------------------------------------------------------
// 协议载荷序列化与极简 Protobuf 辅助函数
// -----------------------------------------------------------------------------

/// 构造 Step 1 完整 payload (前缀 01 01 + protobuf)
pub fn build_step1_payload(app_random: &[u8; 16]) -> Vec<u8> {
    // AppVerify: field 1 (app_random, wire 2)
    let app_verify = encode_field(1, 2, app_random);
    // Account: field 30 (AppVerify, wire 2)
    let account = encode_field(30, 2, &app_verify);
    // WearPacket: field 1 (type=1, wire 0), field 2 (id=26, wire 0), field 3 (Account, wire 2)
    let mut cmd = Vec::new();
    cmd.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(1)));
    cmd.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(26)));
    cmd.extend_from_slice(&encode_field(3, 2, &account));

    let mut payload = Vec::with_capacity(2 + cmd.len());
    payload.extend_from_slice(&[0x01, 0x01]);
    payload.extend_from_slice(&cmd);
    payload
}

/// 构造 Step 3 完整 payload (前缀 01 01 + protobuf)
pub fn build_step3_payload(app_sign: &[u8; 32], encrypt_companion: &[u8]) -> Vec<u8> {
    // AppConfirm: field 1 (app_sign, wire 2), field 2 (encrypt_companion, wire 2)
    let mut app_confirm = Vec::new();
    app_confirm.extend_from_slice(&encode_field(1, 2, app_sign));
    app_confirm.extend_from_slice(&encode_field(2, 2, encrypt_companion));

    // Account: field 32 (AppConfirm, wire 2)
    let account = encode_field(32, 2, &app_confirm);

    // WearPacket: field 1 (type=1, wire 0), field 2 (id=27, wire 0), field 3 (Account, wire 2)
    let mut cmd = Vec::new();
    cmd.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(1)));
    cmd.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(27)));
    cmd.extend_from_slice(&encode_field(3, 2, &account));

    let mut payload = Vec::with_capacity(2 + cmd.len());
    payload.extend_from_slice(&[0x01, 0x01]);
    payload.extend_from_slice(&cmd);
    payload
}

/// 构造 CompanionDevice 明文（形状与抓包中 17B 一致：1:varint, 3:string, 4:uint32）
pub fn build_companion_device_plaintext(
    device_type: u64,
    device_name: &str,
    app_capability: u32,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(device_type)));
    out.extend_from_slice(&encode_field(3, 2, device_name.as_bytes()));
    out.extend_from_slice(&encode_field(4, 0, &encode_varint_bytes(app_capability as u64)));
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireValue {
    Varint(u64),
    LengthDelimited(Vec<u8>),
}

pub fn encode_varint(mut val: u64, out: &mut Vec<u8>) {
    while val > 127 {
        out.push(((val & 127) as u8) | 128);
        val >>= 7;
    }
    out.push(val as u8);
}

pub fn encode_varint_bytes(val: u64) -> Vec<u8> {
    let mut out = Vec::new();
    encode_varint(val, &mut out);
    out
}

pub fn encode_field(number: u32, wire: u8, value: &[u8]) -> Vec<u8> {
    let tag = (number << 3) | (wire as u32);
    let mut out = Vec::new();
    encode_varint(tag as u64, &mut out);
    if wire == 0 {
        out.extend_from_slice(value);
    } else if wire == 2 {
        encode_varint(value.len() as u64, &mut out);
        out.extend_from_slice(value);
    } else {
        panic!("wire type {wire} not supported in minimal encoder");
    }
    out
}

pub fn parse_protobuf(data: &[u8]) -> Result<BTreeMap<u32, Vec<WireValue>>, SessionError> {
    let mut map = BTreeMap::new();
    let mut pos = 0;
    while pos < data.len() {
        let tag = read_varint(data, &mut pos)?;
        let number = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        if number == 0 {
            return Err(SessionError::ProtobufDecodeFailed("无效字段号 0"));
        }
        match wire {
            0 => {
                let val = read_varint(data, &mut pos)?;
                map.entry(number)
                    .or_insert_with(Vec::new)
                    .push(WireValue::Varint(val));
            }
            2 => {
                let len = read_varint(data, &mut pos)? as usize;
                if pos + len > data.len() {
                    return Err(SessionError::ProtobufDecodeFailed("变长字段越界"));
                }
                let bytes = data[pos..pos + len].to_vec();
                pos += len;
                map.entry(number)
                    .or_insert_with(Vec::new)
                    .push(WireValue::LengthDelimited(bytes));
            }
            1 => {
                // 64-bit fixed
                if pos + 8 > data.len() {
                    return Err(SessionError::ProtobufDecodeFailed("64位定长字段越界"));
                }
                pos += 8;
            }
            5 => {
                // 32-bit fixed
                if pos + 4 > data.len() {
                    return Err(SessionError::ProtobufDecodeFailed("32位定长字段越界"));
                }
                pos += 4;
            }
            _ => {
                return Err(SessionError::ProtobufDecodeFailed("不支持的 wire type"));
            }
        }
    }
    Ok(map)
}

fn read_varint(data: &[u8], pos: &mut usize) -> Result<u64, SessionError> {
    let mut result: u64 = 0;
    let mut shift = 0;
    while *pos < data.len() {
        let b = data[*pos];
        *pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err(SessionError::ProtobufDecodeFailed("varint 溢出"));
        }
    }
    Err(SessionError::ProtobufDecodeFailed("varint 数据不完整"))
}

pub fn extract_one_varint(
    map: &BTreeMap<u32, Vec<WireValue>>,
    field: u32,
) -> Result<u64, SessionError> {
    match map.get(&field) {
        Some(list) if list.len() == 1 => match &list[0] {
            WireValue::Varint(v) => Ok(*v),
            _ => Err(SessionError::ProtobufFieldMissing("字段类型非 Varint")),
        },
        _ => Err(SessionError::ProtobufFieldMissing("未找到唯一的 Varint 字段")),
    }
}

pub fn extract_one_bytes<'a>(
    map: &'a BTreeMap<u32, Vec<WireValue>>,
    field: u32,
) -> Result<&'a [u8], SessionError> {
    match map.get(&field) {
        Some(list) if list.len() == 1 => match &list[0] {
            WireValue::LengthDelimited(v) => Ok(v.as_slice()),
            _ => Err(SessionError::ProtobufFieldMissing("字段类型非 LengthDelimited")),
        },
        _ => Err(SessionError::ProtobufFieldMissing("未找到唯一的 LengthDelimited 字段")),
    }
}

// -----------------------------------------------------------------------------
// 单元测试模块（纯内存，不触网，不连设备，不读真实凭据）
// -----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    // 辅助函数：构造测试用的 Step 2 帧（合成数据）
    fn make_test_step2_frame(
        authkey: &[u8; 16],
        p_nonce: &[u8; 16],
        w_nonce: &[u8; 16],
        seq: u8,
        corrupt_hmac: bool,
    ) -> Frame {
        let (dec_key, _, _, _) = derive_session_keys(authkey, p_nonce, w_nonce).unwrap();
        let mut dev_sign = compute_hmac_sign(&dec_key, w_nonce, p_nonce);
        if corrupt_hmac {
            dev_sign[0] ^= 0xFF; // 篡改 HMAC
        }

        let mut dev_verify = Vec::new();
        dev_verify.extend_from_slice(&encode_field(1, 2, w_nonce));
        dev_verify.extend_from_slice(&encode_field(2, 2, &dev_sign));

        let account = encode_field(31, 2, &dev_verify);

        let mut cmd = Vec::new();
        cmd.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(1)));
        cmd.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(26)));
        cmd.extend_from_slice(&encode_field(3, 2, &account));

        let mut payload = vec![0x01, 0x01];
        payload.extend_from_slice(&cmd);

        Frame {
            frame_type: 0x03,
            seq,
            payload,
        }
    }

    // 辅助函数：构造测试用的 Step 4 帧（合成数据）
    fn make_test_step4_frame(confirm_result: bool, seq: u8, omit_field: bool) -> Frame {
        let mut dev_confirm = Vec::new();
        if !omit_field {
            let res_val = if confirm_result { 1 } else { 0 };
            dev_confirm.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(res_val)));
        }
        // capability 常量
        dev_confirm.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(0x100)));
        dev_confirm.extend_from_slice(&encode_field(3, 0, &encode_varint_bytes(0x200)));

        let account = encode_field(33, 2, &dev_confirm);

        let mut cmd = Vec::new();
        cmd.extend_from_slice(&encode_field(1, 0, &encode_varint_bytes(1)));
        cmd.extend_from_slice(&encode_field(2, 0, &encode_varint_bytes(27)));
        cmd.extend_from_slice(&encode_field(3, 2, &account));

        let mut payload = vec![0x01, 0x01];
        payload.extend_from_slice(&cmd);

        Frame {
            frame_type: 0x03,
            seq,
            payload,
        }
    }

    fn to_hex(data: &[u8]) -> String {
        data.iter().map(|b| format!("{b:02x}")).collect()
    }

    // 测试 0：跨语言密码学基准对账（与 verify_auth.py 相同的纯合成常数比对）
    #[test]
    fn test_crypto_cross_verification_with_python() {
        let a = [0x11u8; 16];
        let p = [0x22u8; 16];
        let w = [0x33u8; 16];

        let (dec_key, enc_key, _dec_nonce_cm, enc_nonce_cm) =
            derive_session_keys(&a, &p, &w).unwrap();

        // 对应 Python 输出：
        // dec_key: 17ec07aff31e1fb42eb0a8930a64494b
        // enc_key: 2d4e8798e486733127812cc83da9da58
        assert_eq!(
            to_hex(&dec_key),
            "17ec07aff31e1fb42eb0a8930a64494b"
        );
        assert_eq!(
            to_hex(&enc_key),
            "2d4e8798e486733127812cc83da9da58"
        );

        let device_sign = compute_hmac_sign(&dec_key, &w, &p);
        let app_sign = compute_hmac_sign(&enc_key, &p, &w);

        // 对应 Python 输出：
        // device_sign: 90d174030e1276fbe398bf8dc923f764a28ae600937a79fe99a9f7b764e9c625
        // app_sign:    2d44aec64517a4cf1e4a03a463455311172264941bcd0d5e5ae4bbfa13b3e7a5
        assert_eq!(
            to_hex(&device_sign),
            "90d174030e1276fbe398bf8dc923f764a28ae600937a79fe99a9f7b764e9c625"
        );
        assert_eq!(
            to_hex(&app_sign),
            "2d44aec64517a4cf1e4a03a463455311172264941bcd0d5e5ae4bbfa13b3e7a5"
        );

        // 对照 CCM 加密 17B plaintext ("OronBox", type=1, cap=0xFFFFFFFF)
        let companion_pt = build_companion_device_plaintext(1, "OronBox", 0xFFFFFFFF);
        assert_eq!(companion_pt.len(), 17);

        let mut nonce12 = [0u8; 12];
        nonce12[0..4].copy_from_slice(&enc_nonce_cm);

        let encrypted = ccm_encrypt_4b_tag(&enc_key, &nonce12, &companion_pt).unwrap();
        assert_eq!(encrypted.len(), 21); // 17B ciphertext + 4B tag

        let decrypted = ccm_decrypt_4b_tag(&enc_key, &nonce12, &encrypted).unwrap();
        assert_eq!(decrypted, companion_pt);
    }

    // 测试 1：合法全链路握手测试
    #[test]
    fn test_auth_full_handshake_success() {
        let authkey = [0x55u8; 16];
        let p_nonce = [0xAAu8; 16];
        let w_nonce = [0xBBu8; 16];

        let mut session = Session::new(authkey);
        assert_eq!(session.state(), &SessionState::TransportConnected);

        // 发起认证 (Step 1)
        let step1_frame = session.start_auth(Some(p_nonce)).expect("Step 1 构造成功");
        assert_eq!(step1_frame.frame_type, 0x03);
        assert_eq!(step1_frame.seq, 0x00);
        assert_eq!(&step1_frame.payload[0..2], &[0x01, 0x01]);
        assert_eq!(step1_frame.payload.len(), 29);

        // 状态转为 AwaitingDeviceVerify
        assert!(matches!(
            session.state(),
            SessionState::Authenticating(AuthSubstate::AwaitingDeviceVerify { .. })
        ));

        // 喂入合法的 Step 2 帧
        let step2_frame = make_test_step2_frame(&authkey, &p_nonce, &w_nonce, 0x00, false);
        let maybe_step3 = session.process_frame(&step2_frame).expect("Step 2 处理成功");
        let step3_frame = maybe_step3.expect("必须产出 Step 3 帧");

        // 校验产出的 Step 3 帧
        assert_eq!(step3_frame.frame_type, 0x03);
        assert_eq!(step3_frame.seq, 0x01);
        assert_eq!(&step3_frame.payload[0..2], &[0x01, 0x01]);
        assert_eq!(step3_frame.payload.len(), 68);

        // 状态转为 AwaitingDeviceConfirm
        assert!(matches!(
            session.state(),
            SessionState::Authenticating(AuthSubstate::AwaitingDeviceConfirm { .. })
        ));

        // 喂入 confirm_result == true 的 Step 4 帧
        let step4_frame = make_test_step4_frame(true, 0x01, false);
        let resp = session.process_frame(&step4_frame).expect("Step 4 处理成功");
        assert!(resp.is_none(), "Step 4 后无需再回发握手包");

        // 断言最终状态为 Authenticated
        assert!(matches!(session.state(), SessionState::Authenticated { .. }));
        assert!(session.business_keys().is_ok());
    }

    // 测试 2：错误 HMAC 签名被拒绝
    #[test]
    fn test_auth_wrong_hmac_fails() {
        let authkey = [0x55u8; 16];
        let p_nonce = [0xAAu8; 16];
        let w_nonce = [0xBBu8; 16];

        let mut session = Session::new(authkey);
        let _ = session.start_auth(Some(p_nonce)).unwrap();

        // 喂入错误的 Step 2 帧 (corrupt_hmac = true)
        let bad_step2 = make_test_step2_frame(&authkey, &p_nonce, &w_nonce, 0x00, true);
        let res = session.process_frame(&bad_step2);

        assert_eq!(res, Err(SessionError::HmacMismatch));
        assert!(matches!(
            session.state(),
            SessionState::Failed(SessionError::HmacMismatch)
        ));
    }

    // 测试 3：CCM 标签损坏负对照
    #[test]
    fn test_auth_ccm_tag_corrupted_negative_control() {
        let key = [0x42u8; 16];
        let nonce = [0x07u8; 12];
        let plaintext = b"test payload 123";

        let mut encrypted = ccm_encrypt_4b_tag(&key, &nonce, plaintext).unwrap();
        // 篡改最后 1 字节的 tag
        let last_idx = encrypted.len() - 1;
        encrypted[last_idx] ^= 0xFF;

        let res = ccm_decrypt_4b_tag(&key, &nonce, &encrypted);
        assert_eq!(res, Err(SessionError::CcmError));
    }

    // 测试 4：Step 4 confirm_result=false 拒绝
    #[test]
    fn test_auth_confirm_false_fails() {
        let authkey = [0x55u8; 16];
        let p_nonce = [0xAAu8; 16];
        let w_nonce = [0xBBu8; 16];

        let mut session = Session::new(authkey);
        let _ = session.start_auth(Some(p_nonce)).unwrap();

        let step2 = make_test_step2_frame(&authkey, &p_nonce, &w_nonce, 0x00, false);
        let _ = session.process_frame(&step2).unwrap();

        // 喂入 confirm_result == false 的 Step 4 帧
        let reject_step4 = make_test_step4_frame(false, 0x01, false);
        let res = session.process_frame(&reject_step4);

        assert_eq!(res, Err(SessionError::ConfirmRejected));
        assert!(matches!(
            session.state(),
            SessionState::Failed(SessionError::ConfirmRejected)
        ));
    }

    // 测试 5：字段缺失拒绝
    #[test]
    fn test_auth_missing_fields_fails() {
        let authkey = [0x55u8; 16];
        let p_nonce = [0xAAu8; 16];
        let w_nonce = [0xBBu8; 16];

        let mut session = Session::new(authkey);
        let _ = session.start_auth(Some(p_nonce)).unwrap();

        let step2 = make_test_step2_frame(&authkey, &p_nonce, &w_nonce, 0x00, false);
        let _ = session.process_frame(&step2).unwrap();

        // Step 4 缺少 confirm_result 字段
        let missing_step4 = make_test_step4_frame(true, 0x01, true);
        let res = session.process_frame(&missing_step4);

        assert!(matches!(res, Err(SessionError::ProtobufFieldMissing(_))));
        assert!(matches!(session.state(), SessionState::Failed(_)));
    }

    // 测试 6：乱序与重复帧拒绝
    #[test]
    fn test_auth_unexpected_or_duplicate_frame() {
        let authkey = [0x55u8; 16];
        let p_nonce = [0xAAu8; 16];
        let w_nonce = [0xBBu8; 16];

        // 场景 A：在等待 Step 2 时收到 Step 4
        let mut session_a = Session::new(authkey);
        let _ = session_a.start_auth(Some(p_nonce)).unwrap();
        let step4 = make_test_step4_frame(true, 0x00, false);
        let res_a = session_a.process_frame(&step4);
        assert!(matches!(res_a, Err(SessionError::UnexpectedFrame(_))));
        assert!(matches!(session_a.state(), SessionState::Failed(_)));

        // 场景 B：在等待 Step 4 时重复收到 Step 2
        let mut session_b = Session::new(authkey);
        let _ = session_b.start_auth(Some(p_nonce)).unwrap();
        let step2 = make_test_step2_frame(&authkey, &p_nonce, &w_nonce, 0x00, false);
        let _ = session_b.process_frame(&step2).unwrap();
        let res_b = session_b.process_frame(&step2);
        assert!(matches!(res_b, Err(SessionError::UnexpectedFrame(_))));
        assert!(matches!(session_b.state(), SessionState::Failed(_)));
    }

    // 测试 7：超时与断链终结
    #[test]
    fn test_auth_timeout_and_disconnect() {
        let authkey = [0x55u8; 16];
        let mut session1 = Session::new(authkey);
        session1.handle_timeout();
        assert_eq!(session1.state(), &SessionState::Failed(SessionError::Timeout));

        let mut session2 = Session::new(authkey);
        session2.handle_disconnect();
        assert_eq!(
            session2.state(),
            &SessionState::Failed(SessionError::LinkBroken)
        );
    }
}
