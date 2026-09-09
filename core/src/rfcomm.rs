//! RFCOMM 连接与首包探测模块（阶段 4 实证）
//!
//! 硬件目标：Xiaomi Smart Band 10 (MAC: 04:34:C3:97:9A:06)
//! 协议规范：docs/protocol/transport.md 与 future_version/PHASE4-BRIEF.md
//! 保护条款：
//! - 连接失败 >= 3 次 -> 立即停止，写 STATUS.md
//! - 发包失败 >= 5 次 -> 立即停止，写 STATUS.md

use crate::frame::{decode, encode, Frame};
use std::thread::sleep;
use std::time::Duration;

#[repr(C, packed)]
#[derive(Copy, Clone, Debug)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

#[repr(C, packed)]
#[derive(Copy, Clone, Debug)]
pub struct SockAddrBth {
    pub address_family: u16,
    pub bt_addr: u64,
    pub service_class_id: Guid,
    pub port: u32,
}

#[repr(C)]
pub struct WsaData {
    pub version: u16,
    pub high_version: u16,
    pub description: [u8; 257],
    pub system_status: [u8; 129],
    pub max_sockets: u16,
    pub max_udp_dg: u16,
    pub vendor_info: *mut u8,
}

pub const AF_BTH: i32 = 32;
pub const BTHPROTO_RFCOMM: i32 = 3;
pub const SOCK_STREAM: i32 = 1;
pub const SOL_SOCKET: i32 = 0xFFFF;
pub const SO_RCVTIMEO: i32 = 0x1006;
pub const INVALID_SOCKET: usize = !0;
pub const WSAETIMEDOUT: i32 = 10060;

#[link(name = "ws2_32")]
extern "system" {
    pub fn WSAStartup(version_requested: u16, data: *mut WsaData) -> i32;
    pub fn WSACleanup() -> i32;
    pub fn WSAGetLastError() -> i32;
    pub fn socket(af: i32, type_: i32, protocol: i32) -> usize;
    pub fn connect(s: usize, name: *const SockAddrBth, namelen: i32) -> i32;
    pub fn send(s: usize, buf: *const u8, len: i32, flags: i32) -> i32;
    pub fn recv(s: usize, buf: *mut u8, len: i32, flags: i32) -> i32;
    pub fn setsockopt(s: usize, level: i32, optname: i32, optval: *const u8, optlen: i32) -> i32;
    pub fn closesocket(s: usize) -> i32;
}

pub fn hex_dump(data: &[u8]) -> String {
    data.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn run_probe() -> Result<(), String> {
    println!("==================================================");
    println!("pulse-core 阶段 4: RFCOMM 连接与首包探测 (带保护条款)");
    println!("目标 MAC: 04:34:C3:97:9A:06");
    println!("==================================================");

    let mut conn_fail_count = 0usize;
    let mut send_fail_count = 0usize;

    unsafe {
        let mut wsa_data = std::mem::zeroed::<WsaData>();
        let startup_res = WSAStartup(0x0202, &mut wsa_data);
        if startup_res != 0 {
            return Err(format!("WSAStartup failed: {startup_res}"));
        }
    }

    // SPP UUID: {00001101-0000-1000-8000-00805F9B34FB}
    let spp_guid = Guid {
        data1: 0x00001101,
        data2: 0x0000,
        data3: 0x1000,
        data4: [0x80, 0x00, 0x00, 0x80, 0x5F, 0x9B, 0x34, 0xFB],
    };

    let target_mac_u64: u64 = 0x0434c3979a06;
    let sockaddr = SockAddrBth {
        address_family: AF_BTH as u16,
        bt_addr: target_mac_u64,
        service_class_id: spp_guid,
        port: 0, // port 0 让 Windows 自动执行 SDP 查询 SPP 通道
    };

    // ----------------------------------------------------
    // 第 1 步 · 4a 链路（连接手环）
    // ----------------------------------------------------
    println!("\n[4a 链路] 正在尝试建立 RFCOMM 连接 (最大尝试 3 次)...");
    let mut sock: usize = INVALID_SOCKET;

    while conn_fail_count < 3 {
        let s = unsafe { socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM) };
        if s == INVALID_SOCKET {
            let err = unsafe { WSAGetLastError() };
            conn_fail_count += 1;
            println!(
                "[4a 链路] 创建 socket 失败 (尝试 {}/3): Win32 错误码 {} ({})",
                conn_fail_count,
                err,
                std::io::Error::from_raw_os_error(err)
            );
            if conn_fail_count >= 3 {
                break;
            }
            sleep(Duration::from_secs(5));
            continue;
        }

        println!(
            "[4a 链路] 连接中... (尝试 {}/3, 目标 04:34:c3:97:9a:06, port=0 SDP)",
            conn_fail_count + 1
        );
        let ret = unsafe {
            connect(
                s,
                &sockaddr as *const SockAddrBth,
                std::mem::size_of::<SockAddrBth>() as i32,
            )
        };

        if ret == 0 {
            println!("[4a 链路] 连接成功！RFCOMM 链路已就绪 (socket fd = {s})");
            sock = s;
            break;
        } else {
            let err = unsafe { WSAGetLastError() };
            conn_fail_count += 1;
            println!(
                "[4a 链路] connect 失败 (尝试 {}/3): Win32 错误码 {} ({})",
                conn_fail_count,
                err,
                std::io::Error::from_raw_os_error(err)
            );
            unsafe { closesocket(s) };

            if conn_fail_count >= 3 {
                break;
            }
            println!("[4a 链路] 等待 5 秒后重试...");
            sleep(Duration::from_secs(5));
        }
    }

    if sock == INVALID_SOCKET || conn_fail_count >= 3 {
        println!("\n[保护条款触发] 连接失败达到上限 ({} 次)，停止执行", conn_fail_count);
        println!("保护条款计数器终值: 连接失败 = {} 次, 发包失败 = {} 次", conn_fail_count, send_fail_count);
        unsafe { WSACleanup() };
        return Err(format!("连接失败次数达到上限 ({} 次)", conn_fail_count));
    }

    // ----------------------------------------------------
    // 第 2 步 · 4b 观察（带 10 秒超时读）
    // ----------------------------------------------------
    println!("\n[4b 观察] 设置 10 秒接收超时 (SO_RCVTIMEO = 10000ms)，等待被动数据...");
    let rcv_timeout_10s: u32 = 10000;
    unsafe {
        setsockopt(
            sock,
            SOL_SOCKET,
            SO_RCVTIMEO,
            &rcv_timeout_10s as *const u32 as *const u8,
            std::mem::size_of::<u32>() as i32,
        );
    }

    let mut buf = [0u8; 1024];
    let n = unsafe { recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0) };
    if n > 0 {
        let received = &buf[..n as usize];
        let dump_len = (n as usize).min(128);
        println!("[4b 观察] 收到数据！总长度 = {} 字节", n);
        println!("[4b 观察] Hexdump (前 {} 字节): {}", dump_len, hex_dump(&received[..dump_len]));
    } else if n == 0 {
        println!("[4b 观察] 对端断开了连接 (recv 返回 0)");
        send_fail_count += 1;
    } else {
        let err = unsafe { WSAGetLastError() };
        if err == WSAETIMEDOUT {
            println!("[4b 观察] 10 秒观察窗口内未收到数据 (WSAETIMEDOUT 10060, 预期中，手环不主动推首包)");
        } else {
            println!(
                "[4b 观察] recv 异常: Win32 错误码 {} ({})",
                err,
                std::io::Error::from_raw_os_error(err)
            );
        }
    }

    // ----------------------------------------------------
    // 第 3 步 · 4c 探测（发首包序列，找可区分响应）
    // ----------------------------------------------------
    println!("\n[4c 探测] 开始按阶段 2 实证序列发送首包 (接收超时设为 5000ms)...");
    let rcv_timeout_5s: u32 = 5000;
    unsafe {
        setsockopt(
            sock,
            SOL_SOCKET,
            SO_RCVTIMEO,
            &rcv_timeout_5s as *const u32 as *const u8,
            std::mem::size_of::<u32>() as i32,
        );
    }

    // 探测 1：前导帧 (ba dc fe)
    let preamble = [0xba, 0xdc, 0xfe, 0x00, 0xc0, 0x03, 0x00, 0x00, 0x01, 0x00, 0xef];
    println!("\n[4c 探测 - 包 1/2: 前导握手帧]");
    println!("  发送长度: {} 字节", preamble.len());
    println!("  发送 Hexdump: {}", hex_dump(&preamble));

    let sent_bytes = unsafe { send(sock, preamble.as_ptr(), preamble.len() as i32, 0) };
    if sent_bytes != preamble.len() as i32 {
        let err = unsafe { WSAGetLastError() };
        println!("  发送失败: sent = {}, err = {}", sent_bytes, err);
        send_fail_count += 1;
    } else {
        println!("  发送成功，等待响应 (最多 5 秒)...");
        let mut resp_buf = [0u8; 1024];
        let resp_len = unsafe { recv(sock, resp_buf.as_mut_ptr(), resp_buf.len() as i32, 0) };
        if resp_len > 0 {
            let resp_bytes = &resp_buf[..resp_len as usize];
            println!("  响应长度: {} 字节", resp_len);
            println!("  响应 Hexdump: {}", hex_dump(resp_bytes));

            let expected_preamble_resp = [
                0xba, 0xdc, 0xfe, 0x00, 0x00, 0x06, 0x00, 0x01, 0x02, 0x00, 0x03, 0x01, 0x40, 0xef,
            ];
            if resp_bytes == expected_preamble_resp {
                println!("  解析结果: 100% 匹配预期前导帧响应 (14 字节，完全一致)！");
            } else if resp_bytes.starts_with(&[0xba, 0xdc, 0xfe]) {
                println!("  解析结果: 收到前导帧响应 (ba dc fe 起始，长度 {})", resp_len);
            } else {
                println!("  解析结果: 非预期前导响应");
            }
        } else if resp_len == 0 {
            println!("  对端在等待前导响应时断开连接");
            send_fail_count += 1;
        } else {
            let err = unsafe { WSAGetLastError() };
            println!(
                "  前导帧未收到响应 (错误码 {}: {})",
                err,
                std::io::Error::from_raw_os_error(err)
            );
            send_fail_count += 1;
        }
    }

    if send_fail_count >= 5 {
        println!("\n[保护条款触发] 发包失败达到上限 ({} 次)，停止执行", send_fail_count);
        println!("保护条款计数器终值: 连接失败 = {} 次, 发包失败 = {} 次", conn_fail_count, send_fail_count);
        unsafe {
            closesocket(sock);
            WSACleanup();
        }
        return Err("发包失败达到上限".to_string());
    }

    // 探测 2：type=0x02 协商帧
    let nego = Frame {
        frame_type: 0x02,
        seq: 0x00,
        payload: vec![
            0x01, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0xfc, 0x03, 0x02,
            0x00, 0x20, 0x00, 0x04, 0x02, 0x00, 0x10, 0x27,
        ],
    };
    let nego_raw = encode(&nego);
    println!("\n[4c 探测 - 包 2/2: type=0x02 协商帧]");
    println!("  发送长度: {} 字节", nego_raw.len());
    println!("  发送 Hexdump: {}", hex_dump(&nego_raw));

    let sent_bytes2 = unsafe { send(sock, nego_raw.as_ptr(), nego_raw.len() as i32, 0) };
    if sent_bytes2 != nego_raw.len() as i32 {
        let err = unsafe { WSAGetLastError() };
        println!("  发送失败: sent = {}, err = {}", sent_bytes2, err);
        send_fail_count += 1;
    } else {
        println!("  发送成功，等待响应 (最多 5 秒)...");
        let mut resp_buf = [0u8; 1024];
        let resp_len = unsafe { recv(sock, resp_buf.as_mut_ptr(), resp_buf.len() as i32, 0) };
        if resp_len > 0 {
            let resp_bytes = &resp_buf[..resp_len as usize];
            println!("  响应长度: {} 字节", resp_len);
            println!("  响应 Hexdump: {}", hex_dump(resp_bytes));

            match decode(resp_bytes) {
                Ok((frame, consumed)) => {
                    println!(
                        "  解析结果: 成功 decode 帧！type=0x{:02x}, seq=0x{:02x}, payload_len={}, 已消费 {}/{} 字节",
                        frame.frame_type, frame.seq, frame.payload.len(), consumed, resp_len
                    );
                    if frame.frame_type == 0x01 {
                        println!("  判定: 可区分响应 -> ACK 帧 (seq=0x{:02x})", frame.seq);
                    } else if frame.frame_type == 0x02 {
                        println!("  判定: 可区分响应 -> 链路协商响应帧 (type=0x02, payload_len={})", frame.payload.len());
                    } else if frame.frame_type == 0x03 {
                        println!("  判定: 可区分响应 -> 业务数据帧 (type=0x03, payload_len={})", frame.payload.len());
                    } else {
                        println!("  判定: 非预期帧类型 (type=0x{:02x})", frame.frame_type);
                    }
                }
                Err(e) => {
                    println!("  解析结果: decode 失败 ({e:?})");
                    send_fail_count += 1;
                }
            }
        } else if resp_len == 0 {
            println!("  对端在等待协商响应时断开连接");
            send_fail_count += 1;
        } else {
            let err = unsafe { WSAGetLastError() };
            println!(
                "  协商帧未收到响应 (错误码 {}: {})",
                err,
                std::io::Error::from_raw_os_error(err)
            );
            send_fail_count += 1;
        }
    }

    // 探测完毕，正常关闭套接字
    println!("\n[4c 探测完成] 正常关闭套接字 closesocket...");
    unsafe {
        closesocket(sock);
        WSACleanup();
    }

    println!("\n==================================================");
    println!("保护条款计数器终值: 连接失败 = {} 次, 发包失败 = {} 次", conn_fail_count, send_fail_count);
    println!("==================================================");

    Ok(())
}
