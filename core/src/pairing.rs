//! Windows 蓝牙配对自动应答（仅限已配置的手环 MAC）
//!
//! # 为什么需要这个
//!
//! 小米手环 10 不持久保存 BR/EDR 链路密钥：每次 `connect_rfcomm()` 打开 SPP 通道，
//! 手环都会**主动向 PC 发起一次配对**，于是 Windows 弹出
//! 「要为设备配对吗？"Xiaomi Smart Band 10 XXXX" 想要与此 Windows 设备配对」。
//! 手环屏幕上同时也有一个确认框。用户要点两次。
//!
//! Windows 的既定机制是：**一旦有应用通过 `BluetoothRegisterForAuthenticationEx`
//! 注册了认证回调，系统就不再显示自己的配对 UI**，而把请求转交给该应用。
//! 本模块就注册这样一个回调，对手环自动回「同意」，让用户只需要在手环上点一次。
//!
//! # 安全边界（这两条是有意收窄的，不要放宽）
//!
//! 1. **只对 device.json 里那一个 MAC 注册**。绝不传 `NULL`（那会接管所有设备的配对请求，
//!    等于给任何设备开静默配对的后门）。其他设备照常走系统 UI。
//! 2. **只在一次 connect 期间存活**。`AutoAcceptGuard` 是 RAII，
//!    `connect_rfcomm()` 无论从哪条路径返回都会立刻注销。守护进程常驻期间不保留注册。
//!
//! 另外只自动确认 `NUMERIC_COMPARISON`（Just Works 归在这一类）。
//! PIN / passkey 这些需要用户读数字的方式一律不接管，让系统弹原来的框。
//!
//! # 验证状态
//!
//! [implemented · 真机验证通过 2026-09-11] 设备 Xiaomi Smart Band 10 9A06 实测：
//! 点「连接手环」后 PC 端不再弹出配对框，只在手环屏幕确认一次即完成连接。
//!
//! 日后若失效，回调里打印了实际收到的 authentication method——
//! 先看日志里那个值是不是 3（NUMERIC_COMPARISON）。换了手环型号或
//! Windows 大版本更新后，这条是第一个要重新验证的假设。

#![allow(non_snake_case)]

use std::ffi::c_void;

const BLUETOOTH_MAX_NAME_SIZE: usize = 248;

/// 只自动确认这一种：数字比较（Just Works 也走这条）
const AUTH_METHOD_NUMERIC_COMPARISON: u32 = 3;

#[repr(C)]
#[derive(Copy, Clone)]
struct SystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

/// BLUETOOTH_DEVICE_INFO（x64 下 sizeof == 560，测试里钉死）
#[repr(C)]
#[derive(Copy, Clone)]
pub(crate) struct BluetoothDeviceInfo {
    pub(crate) dw_size: u32,
    pub(crate) address: u64,
    ul_class_of_device: u32,
    f_connected: i32,
    f_remembered: i32,
    f_authenticated: i32,
    st_last_seen: SystemTime,
    st_last_used: SystemTime,
    pub(crate) sz_name: [u16; BLUETOOTH_MAX_NAME_SIZE],
}

impl BluetoothDeviceInfo {
    pub(crate) fn for_address(mac_u64: u64) -> Self {
        let mut info: Self = unsafe { std::mem::zeroed() };
        info.dw_size = std::mem::size_of::<Self>() as u32;
        info.address = mac_u64;
        info
    }
}

/// BLUETOOTH_AUTHENTICATION_CALLBACK_PARAMS
#[repr(C)]
struct AuthCallbackParams {
    device_info: BluetoothDeviceInfo,
    authentication_method: u32,
    io_capability: u32,
    authentication_requirements: u32,
    /// union { ULONG Numeric_Value; ULONG Passkey; }
    numeric_value_or_passkey: u32,
}

/// BLUETOOTH_AUTHENTICATE_RESPONSE
///
/// union 里最大的成员是 BLUETOOTH_OOB_DATA_INFO（UCHAR C[16] + UCHAR R[16] = 32 字节），
/// 这里用定长字节数组表示；数字比较只需要把 NumericValue 写进前 4 字节。
#[repr(C)]
struct AuthenticateResponse {
    bth_address_remote: u64,
    auth_method: u32,
    union_blob: [u8; 32],
    negative_response: u8,
}

#[repr(C)]
struct FindRadioParams {
    dw_size: u32,
}

type AuthCallbackEx =
    unsafe extern "system" fn(param: *mut c_void, params: *const AuthCallbackParams) -> i32;

type FnFindFirstRadio = unsafe extern "system" fn(*const FindRadioParams, *mut usize) -> usize;
type FnFindRadioClose = unsafe extern "system" fn(usize) -> i32;
type FnRegister = unsafe extern "system" fn(
    *const BluetoothDeviceInfo,
    *mut usize,
    Option<AuthCallbackEx>,
    *mut c_void,
) -> u32;
type FnSendResponse = unsafe extern "system" fn(usize, *const AuthenticateResponse) -> u32;
type FnUnregister = unsafe extern "system" fn(usize) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryA(name: *const u8) -> usize;
    fn GetProcAddress(module: usize, name: *const u8) -> usize;
}

/// 蓝牙认证 API 全部在 bthprops.cpl 里。
///
/// 走运行时动态加载而不是 `#[link]`：本项目用的是 MinGW 工具链，
/// 它不提供 bthprops 的导入库（只有 MSVC 才有 Bthprops.lib）。
/// 动态加载顺带白送一个好处——任何一个符号解析不到就整体退化成「不接管配对」，
/// 而不是让整个 core 链接失败。
struct Api {
    find_first_radio: FnFindFirstRadio,
    find_radio_close: FnFindRadioClose,
    register: FnRegister,
    send_response: FnSendResponse,
    unregister: FnUnregister,
}

// 函数指针本身是不可变的只读数据，跨线程共享安全（回调在 Windows 线程上跑）
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: std::sync::OnceLock<Option<Api>> = std::sync::OnceLock::new();

fn api() -> Option<&'static Api> {
    API.get_or_init(|| unsafe {
        let module = LoadLibraryA(b"bthprops.cpl\0".as_ptr());
        if module == 0 {
            eprintln!("[pairing] 加载 bthprops.cpl 失败，配对自动应答不可用");
            return None;
        }
        let find_first_radio = GetProcAddress(module, b"BluetoothFindFirstRadio\0".as_ptr());
        let find_radio_close = GetProcAddress(module, b"BluetoothFindRadioClose\0".as_ptr());
        let register = GetProcAddress(module, b"BluetoothRegisterForAuthenticationEx\0".as_ptr());
        let send_response =
            GetProcAddress(module, b"BluetoothSendAuthenticationResponseEx\0".as_ptr());
        let unregister = GetProcAddress(module, b"BluetoothUnregisterAuthentication\0".as_ptr());
        if find_first_radio == 0
            || find_radio_close == 0
            || register == 0
            || send_response == 0
            || unregister == 0
        {
            eprintln!("[pairing] bthprops.cpl 缺少所需导出，配对自动应答不可用");
            return None;
        }
        Some(Api {
            find_first_radio: std::mem::transmute::<usize, FnFindFirstRadio>(find_first_radio),
            find_radio_close: std::mem::transmute::<usize, FnFindRadioClose>(find_radio_close),
            register: std::mem::transmute::<usize, FnRegister>(register),
            send_response: std::mem::transmute::<usize, FnSendResponse>(send_response),
            unregister: std::mem::transmute::<usize, FnUnregister>(unregister),
        })
    })
    .as_ref()
}

/// 打开第一个本机蓝牙适配器，把 radio 句柄交给 `f`，结束后关闭 find 句柄。
fn with_first_radio<T>(f: impl FnOnce(usize) -> T) -> Option<T> {
    let api = api()?;
    let params = FindRadioParams {
        dw_size: std::mem::size_of::<FindRadioParams>() as u32,
    };
    let mut radio: usize = 0;
    let find = unsafe { (api.find_first_radio)(&params, &mut radio) };
    if find == 0 || radio == 0 {
        return None;
    }
    let out = f(radio);
    unsafe { (api.find_radio_close)(find) };
    Some(out)
}

/// Windows 在独立线程上调用它。注册时已按设备收窄，只对目标手环触发。
unsafe extern "system" fn auth_callback(
    param: *mut c_void,
    params: *const AuthCallbackParams,
) -> i32 {
    if params.is_null() {
        return 0;
    }
    let p = &*params;
    let expected_mac = param as u64;
    let remote = p.device_info.address;
    let method = p.authentication_method;

    // 再核一次地址，杜绝任何意外的跨设备应答
    if expected_mac != 0 && remote != expected_mac {
        eprintln!("[pairing] 忽略非目标设备的配对请求: {remote:012X}");
        return 0;
    }

    if method != AUTH_METHOD_NUMERIC_COMPARISON {
        // 需要用户读数字的方式不接管，让系统按原流程处理
        eprintln!("[pairing] 配对方式 {method} 不自动应答，交回系统 UI");
        return 0;
    }

    let mut resp = AuthenticateResponse {
        bth_address_remote: remote,
        auth_method: method,
        union_blob: [0u8; 32],
        negative_response: 0, // 0 = 同意
    };
    // union 的前 4 字节是 numericCompInfo.NumericValue
    resp.union_blob[..4].copy_from_slice(&p.numeric_value_or_passkey.to_le_bytes());

    let sent = with_first_radio(|radio| match api() {
        Some(api) => (api.send_response)(radio, &resp),
        None => u32::MAX,
    });
    match sent {
        Some(0) => {
            eprintln!("[pairing] 已自动同意 {remote:012X} 的配对请求");
            1
        }
        Some(code) => {
            eprintln!("[pairing] 自动应答失败，Win32 错误 {code}");
            0
        }
        None => {
            eprintln!("[pairing] 找不到本机蓝牙适配器，无法自动应答");
            0
        }
    }
}

/// 注册期间有效；drop 即注销。
pub struct AutoAcceptGuard {
    reg_handle: usize,
}

impl Drop for AutoAcceptGuard {
    fn drop(&mut self) {
        if self.reg_handle != 0 {
            if let Some(api) = api() {
                unsafe { (api.unregister)(self.reg_handle) };
            }
            eprintln!("[pairing] 已注销配对自动应答");
        }
    }
}

/// 为指定 MAC 注册配对自动应答。
///
/// 返回 `None` 表示没注册上（适配器缺失、API 报错等）——此时行为退回原样：
/// Windows 弹自己的配对框。**不要因为注册失败就中止连接。**
pub fn auto_accept_for(mac_u64: u64) -> Option<AutoAcceptGuard> {
    let api = api()?;
    let info = BluetoothDeviceInfo::for_address(mac_u64);
    let mut reg_handle: usize = 0;
    let rc = unsafe {
        (api.register)(
            &info,
            &mut reg_handle,
            Some(auth_callback),
            mac_u64 as *mut c_void,
        )
    };
    if rc != 0 || reg_handle == 0 {
        eprintln!("[pairing] 注册配对自动应答失败，Win32 错误 {rc}（退回系统配对框）");
        return None;
    }
    eprintln!("[pairing] 已为 {mac_u64:012X} 注册配对自动应答");
    Some(AutoAcceptGuard { reg_handle })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 结构体布局错了会让 Windows 直接返回 ERROR_INVALID_PARAMETER，
    /// 而且症状是「注册没报错但回调永不触发」，很难查。这里钉死。
    #[test]
    fn device_info_layout_matches_win32() {
        assert_eq!(std::mem::size_of::<SystemTime>(), 16);
        assert_eq!(std::mem::size_of::<BluetoothDeviceInfo>(), 560);
        assert_eq!(std::mem::size_of::<FindRadioParams>(), 4);
    }
}
