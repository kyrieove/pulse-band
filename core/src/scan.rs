//! 经典蓝牙查询扫描（`pulse-core --scan`）
//!
//! # 为什么需要这个
//!
//! 首次配置要把手环的 BR/EDR MAC 写进 device.json，`pairing.rs` 才会只对这个 MAC 自动同意配对。
//! 以前 MAC 只能从 Windows 已配对设备列表里取，新用户得先去系统设置配对一次——
//! 但手环本来就会在每次 connect 时主动发起配对，那一步是多余的。
//! 这里直接做一次 inquiry，列出附近设备的名字和地址，由 Electron 侧挑出小米手环。
//!
//! 输出：stdout 一行 JSON 数组 `[{"name":"Xiaomi Smart Band 10 9A06","addr":"04:34:C3:97:9A:06"}]`。
//! 只列设备，不连接、不配对。

use crate::pairing::BluetoothDeviceInfo;

/// BLUETOOTH_DEVICE_SEARCH_PARAMS（x64 下 sizeof == 40，测试里钉死）
#[repr(C)]
struct DeviceSearchParams {
    dw_size: u32,
    f_return_authenticated: i32,
    f_return_remembered: i32,
    f_return_unknown: i32,
    f_return_connected: i32,
    f_issue_inquiry: i32,
    /// 查询时长 = 值 × 1.28 秒
    c_timeout_multiplier: u8,
    h_radio: usize,
}

/// 6 × 1.28 ≈ 8 秒：手环亮屏时足够被扫到，又不会让向导等太久
const INQUIRY_TIMEOUT_MULTIPLIER: u8 = 6;

type FnFindFirstDevice =
    unsafe extern "system" fn(*const DeviceSearchParams, *mut BluetoothDeviceInfo) -> usize;
type FnFindNextDevice = unsafe extern "system" fn(usize, *mut BluetoothDeviceInfo) -> i32;
type FnFindDeviceClose = unsafe extern "system" fn(usize) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryA(name: *const u8) -> usize;
    fn GetProcAddress(module: usize, name: *const u8) -> usize;
}

fn device_json(info: &BluetoothDeviceInfo) -> serde_json::Value {
    let len = info
        .sz_name
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(info.sz_name.len());
    let name = String::from_utf16_lossy(&info.sz_name[..len]);
    let b = info.address.to_be_bytes();
    let addr = format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        b[2], b[3], b[4], b[5], b[6], b[7]
    );
    serde_json::json!({ "name": name, "addr": addr })
}

/// 扫描附近（含已记住的）经典蓝牙设备。和 pairing.rs 一样动态加载 bthprops.cpl（MinGW 没有导入库）。
pub fn run_scan() -> Result<(), String> {
    let (first, next, close) = unsafe {
        let module = LoadLibraryA(b"bthprops.cpl\0".as_ptr());
        if module == 0 {
            return Err("加载 bthprops.cpl 失败".into());
        }
        let first = GetProcAddress(module, b"BluetoothFindFirstDevice\0".as_ptr());
        let next = GetProcAddress(module, b"BluetoothFindNextDevice\0".as_ptr());
        let close = GetProcAddress(module, b"BluetoothFindDeviceClose\0".as_ptr());
        if first == 0 || next == 0 || close == 0 {
            return Err("bthprops.cpl 缺少设备查找导出".into());
        }
        (
            std::mem::transmute::<usize, FnFindFirstDevice>(first),
            std::mem::transmute::<usize, FnFindNextDevice>(next),
            std::mem::transmute::<usize, FnFindDeviceClose>(close),
        )
    };

    let params = DeviceSearchParams {
        dw_size: std::mem::size_of::<DeviceSearchParams>() as u32,
        f_return_authenticated: 1,
        f_return_remembered: 1,
        f_return_unknown: 1,
        f_return_connected: 1,
        f_issue_inquiry: 1,
        c_timeout_multiplier: INQUIRY_TIMEOUT_MULTIPLIER,
        h_radio: 0, // NULL = 所有本机适配器
    };
    let mut info = BluetoothDeviceInfo::for_address(0);
    let mut devices = Vec::new();
    let find = unsafe { first(&params, &mut info) };
    if find != 0 {
        loop {
            devices.push(device_json(&info));
            info = BluetoothDeviceInfo::for_address(0);
            if unsafe { next(find, &mut info) } == 0 {
                break;
            }
        }
        unsafe { close(find) };
    }
    // find == 0 可能是「附近没有设备」（ERROR_NO_MORE_ITEMS），也可能是没有蓝牙适配器；两者都输出空列表
    println!("{}", serde_json::Value::Array(devices));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_params_layout_matches_win32() {
        assert_eq!(std::mem::size_of::<DeviceSearchParams>(), 40);
    }

    #[test]
    fn formats_address_as_colon_mac() {
        let mut info = BluetoothDeviceInfo::for_address(0x0434_C397_9A06);
        for (i, c) in "Band".encode_utf16().enumerate() {
            info.sz_name[i] = c;
        }
        let v = device_json(&info);
        assert_eq!(v["addr"], "04:34:C3:97:9A:06");
        assert_eq!(v["name"], "Band");
    }
}
