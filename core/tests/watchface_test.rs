//! 小米表盘第一阶段（GET_INSTALLED_LIST 只读）离线自动化测试

#![allow(unused_imports)]

#[path = "../src/crc.rs"]
mod crc;
#[path = "../src/frame.rs"]
mod frame;
#[path = "../src/app_install.rs"]
mod app_install;

use app_install::install::xiaomi::l2::L2Packet;
use app_install::install::xiaomi::watch_face::{
    apply_watchface_id, build_watchface_list_query, build_watchface_prepare_query,
    build_watchface_set_query, decode_watchface_install_result, decode_watchface_list_response,
    decode_watchface_prepare_response, extract_watchface_id, is_valid_watchface_id,
    WatchFace, WatchFaceId, WatchFaceItem, WatchFacePayload,
};
use app_install::install::xiaomi::wear_packet::{WearPacket, WearPacketPayload, WearPacketType};
use app_install::install::xiaomi::device_session::MockInstallWireSender;
use app_install::install::xiaomi::runtime_bridge::{
    dispatch_install_frame_event, InstallFrameEvent, XiaomiInstallTransport,
};
use frame::Frame;

/// 串行化所有依赖 GLOBAL_INSTALL_EVENT_QUEUE 的桥接流程测试
static BRIDGE_FLOW_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn test_watchface_list_query_wire_bytes() {
    let raw = build_watchface_list_query();
    // 依据源码与协议证据：
    // - tag 1 (type): Varint = 4 (WATCH_FACE) -> [0x08, 0x04]
    // - tag 2 (id): Varint = 0 (GET_INSTALLED_LIST) -> [0x10, 0x00]
    // - tag 6 (watch_face): LengthDelimited = 0B -> [0x32, 0x00]
    // 总长度必须精确为 6 字节
    assert_eq!(raw, vec![0x08, 0x04, 0x10, 0x00, 0x32, 0x00]);

    // 能够正确反序列化为 WearPacket
    let wp = WearPacket::decode(&raw).expect("解码查询报文应成功");
    assert_eq!(wp.pkt_type, WearPacketType::WatchFace);
    assert_eq!(wp.id, WatchFaceId::GetInstalledList.as_u32());
    match wp.payload {
        Some(WearPacketPayload::WatchFace(wf)) => {
            assert!(wf.payload.is_none());
        }
        other => panic!("期望 WatchFace 载荷，实际为: {other:?}"),
    }
}

#[test]
fn test_watchface_list_response_roundtrip() {
    let items = vec![
        WatchFaceItem {
            id: "24716947".to_string(),
            name: "Classic Pointer".to_string(),
            is_current: true,
            can_remove: false,
            version_code: 65536,
            can_edit: true,
            background_color: "#000000".to_string(),
            background_image: "bg_default.bin".to_string(),
            style: "analog".to_string(),
        },
        WatchFaceItem {
            id: "custom_pulse_01".to_string(),
            name: "Pulse Cyber".to_string(),
            is_current: false,
            can_remove: true,
            version_code: 100,
            can_edit: false,
            background_color: "#112233".to_string(),
            background_image: "".to_string(),
            style: "digital".to_string(),
        },
    ];

    let wf = WatchFace::new_list(items.clone());
    let wp = WearPacket::new_watch_face(0, wf);
    let pb_bytes = wp.encode();

    // 1. 直接裸明文解码
    let decoded = decode_watchface_list_response(&pb_bytes).expect("裸明文应成功解码");
    assert_eq!(decoded, items);

    // 2. 带 L2 (channel=Pb, opcode=Write) 前缀解码
    let l2_bytes = L2Packet::pb_write(pb_bytes).to_bytes();
    let decoded_l2 = decode_watchface_list_response(&l2_bytes).expect("带 L2 前缀应成功解码");
    assert_eq!(decoded_l2, items);
}

#[test]
fn test_watchface_list_response_negative_cases() {
    // 负例 1: type 不是 WatchFace (例如传了 ThirdpartyApp type=20)
    let bad_type = WearPacket::new(WearPacketType::ThirdpartyApp, 0).encode();
    let err = decode_watchface_list_response(&bad_type).unwrap_err();
    assert!(err.contains("不是 WatchFace 报文"));

    // 负例 2: id 不是 0 (例如 id=1 SET_WATCH_FACE)
    let bad_id = WearPacket::new_watch_face(1, WatchFace::default()).encode();
    let err2 = decode_watchface_list_response(&bad_id).unwrap_err();
    assert!(err2.contains("id 不是 0"));

    // 负例 3: 缺少 tag 6 WatchFace 载荷
    let missing_tag6 = WearPacket::new(WearPacketType::WatchFace, 0).encode();
    let err3 = decode_watchface_list_response(&missing_tag6).unwrap_err();
    assert!(err3.contains("缺少 WatchFace 载荷"));

    // 负例 4: 截断损坏的 protobuf
    let corrupted = vec![0x08, 0x04, 0x10, 0x00, 0x32, 0x05, 0xAA, 0xBB];
    assert!(decode_watchface_list_response(&corrupted).is_err());
}

#[test]
fn test_runtime_bridge_watchface_list_flow() {
    // GLOBAL_INSTALL_EVENT_QUEUE 是进程级全局队列，两个桥接流程测试必须串行，
    // 否则并行线程互取对方响应造成交叉污染。
    let _guard = BRIDGE_FLOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock_wire = Box::new(MockInstallWireSender::new());
    mock_wire.set_authenticated(true);
    let wire_for_thread = mock_wire.clone();
    let wire_for_assert = mock_wire.clone();

    let mut transport = XiaomiInstallTransport::with_wire(mock_wire);

    let items = vec![WatchFaceItem {
        id: "wf_test_100".to_string(),
        name: "Test Watch Face".to_string(),
        is_current: true,
        can_remove: false,
        version_code: 1,
        can_edit: false,
        background_color: String::new(),
        background_image: String::new(),
        style: String::new(),
    }];

    let wf = WatchFace::new_list(items.clone());
    let resp_bytes = WearPacket::new_watch_face(0, wf).encode();

    // 模拟设备在接收到查询后回包
    std::thread::spawn(move || {
        // 等待查询下发
        for _ in 0..50 {
            if wire_for_thread.sent_count() > 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
            frame_type: 0x03,
            seq: 1,
            payload: resp_bytes,
        }));
    });

    let res = transport
        .fetch_installed_watchfaces()
        .expect("Mock 链路下查询表盘列表应成功");
    assert_eq!(res, items);

    // 校验实际发出的下行载荷为标准查询明文
    assert_eq!(wire_for_assert.sent_count(), 1);
    let sent = wire_for_assert.sent_records();
    assert_eq!(sent[0].plaintext_l2, vec![0x08, 0x04, 0x10, 0x00, 0x32, 0x00]);
}

#[test]
fn test_watchface_set_query_wire_bytes() {
    // 依据上游 watchface_system.dart _buildWatchfaceSet：
    // WearPacket(type=4, id=1) + WatchFace{field2: string id}
    // tag 1 (type): [0x08, 0x04]
    // tag 2 (id):   [0x10, 0x01] (SET_WATCH_FACE)
    // tag 6 (watch_face): [0x32, 0x0E] + 内层 [0x12, 0x0C] + 12 字节 id
    let raw = build_watchface_set_query("120917423094");
    let mut expected = vec![0x08, 0x04, 0x10, 0x01, 0x32, 0x0E, 0x12, 0x0C];
    expected.extend_from_slice(b"120917423094");
    assert_eq!(raw, expected);

    // 能够正确反序列化回 SET_WATCH_FACE 语义
    let wp = WearPacket::decode(&raw).expect("解码设置报文应成功");
    assert_eq!(wp.pkt_type, WearPacketType::WatchFace);
    assert_eq!(wp.id, WatchFaceId::SetWatchFace.as_u32());
    match wp.payload {
        Some(WearPacketPayload::WatchFace(wf)) => match wf.payload {
            Some(WatchFacePayload::Id(id)) => assert_eq!(id, "120917423094"),
            other => panic!("载荷应为 Id 字符串，实际为 {other:?}"),
        },
        other => panic!("载荷应为 WatchFace，实际为 {other:?}"),
    }
}

#[test]
fn test_runtime_bridge_watchface_set_flow() {
    let _guard = BRIDGE_FLOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock_wire = Box::new(MockInstallWireSender::new());
    mock_wire.set_authenticated(true);
    let wire_for_thread = mock_wire.clone();
    let wire_for_assert = mock_wire.clone();

    let mut transport = XiaomiInstallTransport::with_wire(mock_wire);

    let target = "wf_test_set_001";
    let other = "wf_test_set_000";

    // 依据 set_current_watchface 的判定规则：SET 前目标未生效、SET 后已生效
    let make_list = |target_current: bool| {
        let items = vec![
            WatchFaceItem {
                id: other.to_string(),
                name: "Other".to_string(),
                is_current: !target_current,
                can_remove: true,
                version_code: 1,
                can_edit: false,
                background_color: String::new(),
                background_image: String::new(),
                style: String::new(),
            },
            WatchFaceItem {
                id: target.to_string(),
                name: "Target".to_string(),
                is_current: target_current,
                can_remove: true,
                version_code: 1,
                can_edit: true,
                background_color: String::new(),
                background_image: String::new(),
                style: String::new(),
            },
        ];
        WearPacket::new_watch_face(0, WatchFace::new_list(items)).encode()
    };

    // 模拟设备：列表查询按"SET 是否已发出"返回未生效/已生效两种列表；
    // SET 本身不回包（上游 fire-and-forget，无已知直接应答）。
    std::thread::spawn(move || {
        let mut examined = 0usize;
        let mut set_sent = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            let records = wire_for_thread.sent_records();
            for i in examined..records.len() {
                let p = &records[i].plaintext_l2;
                if p.starts_with(&[0x08, 0x04, 0x10, 0x00]) {
                    dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
                        frame_type: 0x03,
                        seq: 1,
                        payload: make_list(set_sent),
                    }));
                } else if p.starts_with(&[0x08, 0x04, 0x10, 0x01]) {
                    set_sent = true;
                }
            }
            examined = records.len();
            // 两次列表响应都已投递即可结束
            if set_sent && examined >= 3 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });

    let res = transport
        .set_current_watchface(target)
        .expect("Mock 链路下设置当前表盘应成功");
    assert_eq!(res.id, target);
    assert!(res.is_current);

    // 至少发出: 1 次前置列表查询 + 1 次 SET + ≥1 次生效轮询查询
    assert!(wire_for_assert.sent_count() >= 3);
    let sent = wire_for_assert.sent_records();
    // 第 1 条是列表查询、第 2 条必须是 SET_WATCH_FACE 明文
    assert_eq!(sent[0].plaintext_l2, vec![0x08, 0x04, 0x10, 0x00, 0x32, 0x00]);
    assert_eq!(&sent[1].plaintext_l2[..4], &[0x08, 0x04, 0x10, 0x01]);
}

#[test]
fn test_watchface_prepare_query_wire_bytes() {
    // 依据上游 install_system.dart installWatchface：
    // WearPacket(type=4, id=4) + WatchFace{field6: PrepareInfo{field1:id, field2:size, field3:version_code}}
    // id="a" (1B), size=1, version_code=65536:
    //   PrepareInfo = [0A 01 61] + [10 01] + [18 80 80 04] = 9B
    //   WatchFace   = [32 09] + PrepareInfo = 11B
    //   WearPacket  = [08 04] [10 04] [32 0B] + WatchFace = 17B（双层 field 6 嵌套）
    let raw = build_watchface_prepare_query("a", 1, 65536);
    assert_eq!(
        raw,
        vec![
            0x08, 0x04, 0x10, 0x04, 0x32, 0x0B, 0x32, 0x09, 0x0A, 0x01, 0x61, 0x10, 0x01, 0x18,
            0x80, 0x80, 0x04
        ]
    );

    // 回读校验语义
    let wp = WearPacket::decode(&raw).expect("解码准备请求应成功");
    assert_eq!(wp.pkt_type, WearPacketType::WatchFace);
    assert_eq!(wp.id, WatchFaceId::PrepareInstallWatchFace.as_u32());
    match wp.payload {
        Some(WearPacketPayload::WatchFace(wf)) => match wf.payload {
            Some(WatchFacePayload::PrepareInfo(pi)) => {
                assert_eq!(pi.id, "a");
                assert_eq!(pi.size, 1);
                assert_eq!(pi.version_code, 65536);
            }
            other => panic!("载荷应为 PrepareInfo，实际 {other:?}"),
        },
        other => panic!("载荷应为 WatchFace，实际 {other:?}"),
    }
}

fn make_prepare_response(status: u32) -> Vec<u8> {
    WearPacket::new_watch_face(
        WatchFaceId::PrepareInstallWatchFace.as_u32(),
        WatchFace {
            payload: Some(WatchFacePayload::PrepareStatus(status)),
        },
    )
    .encode()
}

#[test]
fn test_watchface_prepare_response_decode() {
    assert_eq!(decode_watchface_prepare_response(&make_prepare_response(0)).unwrap(), 0);
    assert_eq!(decode_watchface_prepare_response(&make_prepare_response(1)).unwrap(), 1);

    // 负例：id 不是 4
    let wrong_id = WearPacket::new_watch_face(0, WatchFace::default()).encode();
    assert!(decode_watchface_prepare_response(&wrong_id).is_err());
}

fn make_install_result(id: &str, code: u32) -> Vec<u8> {
    WearPacket::new_watch_face(
        WatchFaceId::ReportInstallResult.as_u32(),
        WatchFace {
            payload: Some(WatchFacePayload::InstallResult(
                app_install::install::xiaomi::watch_face::WatchfaceInstallResult {
                    id: id.to_string(),
                    code,
                },
            )),
        },
    )
    .encode()
}

#[test]
fn test_watchface_install_result_decode() {
    let r = decode_watchface_install_result(&make_install_result("976603977", 2)).unwrap();
    assert_eq!(r.id, "976603977");
    assert_eq!(r.code, 2);

    let r3 = decode_watchface_install_result(&make_install_result("", 3)).unwrap();
    assert_eq!(r3.code, 3);

    // 负例：type 错误
    let bad_type = WearPacket::new(WearPacketType::ThirdpartyApp, 5).encode();
    assert!(decode_watchface_install_result(&bad_type).is_err());
}

#[test]
fn test_watchface_id_extract_apply_validate() {
    // 构造 0x34+ 文件，0x28 处写 9 字符 ID（右补零）
    let mut file = vec![0u8; 0x40];
    file[0] = 0x5A;
    file[0x28..0x28 + 9].copy_from_slice(b"976603977");
    assert_eq!(extract_watchface_id(&file).as_deref(), Some("976603977"));

    // 全零 → None（无效，需生成）
    let mut zero_file = vec![0u8; 0x40];
    zero_file[0] = 0x5A;
    assert_eq!(extract_watchface_id(&zero_file), None);

    // 文件过短 → None
    assert_eq!(extract_watchface_id(&[0u8; 10]), None);

    // 改写：12 字符 ID 覆盖写入，读回一致
    apply_watchface_id(&mut zero_file, "testwf01").unwrap();
    assert_eq!(extract_watchface_id(&zero_file).as_deref(), Some("testwf01"));

    // 非法输入被拒绝
    assert!(!is_valid_watchface_id(""));
    assert!(!is_valid_watchface_id("abcdefghijklm")); // 13 字符
    assert!(!is_valid_watchface_id("bad id!"));
    assert!(!is_valid_watchface_id("000000000000")); // 全零 = 未写 ID，须拒绝
    assert!(is_valid_watchface_id("a-b_C9"));
}

/// 表盘整包安装全流程（Mock 链路）：PREPARE READY → Mass Prepare READY(slice=244) →
/// 1 个 Mass 分片 + ACK → INSTALL_SUCCESS(2)。
#[test]
fn test_runtime_bridge_watchface_install_flow() {
    use app_install::install::xiaomi::mass::{Mass, PrepareResponse};

    let _guard = BRIDGE_FLOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock_wire = Box::new(MockInstallWireSender::new());
    mock_wire.set_authenticated(true);
    let wire_for_thread = mock_wire.clone();
    let wire_for_assert = mock_wire.clone();

    let mut transport = XiaomiInstallTransport::with_wire(mock_wire);

    let file_bytes = vec![0x5Au8; 100];
    let md5_hex = "00112233445566778899aabbccddeeff".to_string();

    // 模拟设备：按安装进度延迟投递应答（bridge 方法启动时会 discard_stale_frames，
    // 预置帧必须在 discard 之后入队才有效）。
    // 进度依据: Pb 发送 1 条=表盘准备已发出 → 回 READY；2 条=Mass 准备已发出 → 回 Mass READY；
    // Mass 通道出现分片 → 回累积 ACK(seq=最后一片) + INSTALL_SUCCESS(2)。
    std::thread::spawn(move || {
        let mass_ready_payload = WearPacket::new_mass(
            0,
            Mass::from_prepare_response(PrepareResponse {
                data_id: vec![0u8; 16],
                prepare_status: 0,
                select_compress_mode: None,
                remained_data_length: None,
                expected_slice_length: Some(244),
            }),
        )
        .encode();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut stage = 0usize;
        loop {
            if std::time::Instant::now() >= deadline {
                break;
            }
            match stage {
                0 if wire_for_thread.sent_records().len() >= 1 => {
                    dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
                        frame_type: 0x03,
                        seq: 1,
                        payload: make_prepare_response(0),
                    }));
                    stage = 1;
                }
                1 if wire_for_thread.sent_records().len() >= 2 => {
                    dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
                        frame_type: 0x03,
                        seq: 2,
                        payload: mass_ready_payload.clone(),
                    }));
                    stage = 2;
                }
                2 if !wire_for_thread.sent_mass_records().is_empty() => {
                    let last = wire_for_thread.sent_mass_records().last().unwrap().seq;
                    dispatch_install_frame_event(InstallFrameEvent::Ack { seq: last });
                    dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
                        frame_type: 0x03,
                        seq: 3,
                        payload: make_install_result("testwf01", 2),
                    }));
                    stage = 3;
                }
                3 => break,
                _ => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    });

    let outcome = transport
        .install_watchface_file(&file_bytes, &md5_hex, Some("testwf01"))
        .expect("Mock 链路下表盘安装应成功");
    assert_eq!(outcome.watchface_id, "testwf01");
    assert_eq!(outcome.result_code, 2);

    // Pb 通道应有 2 条：表盘准备 + Mass 准备
    let sent = wire_for_assert.sent_records();
    assert_eq!(sent.len(), 2);
    assert_eq!(&sent[0].plaintext_l2[..4], &[0x08, 0x04, 0x10, 0x04]);
    assert_eq!(&sent[1].plaintext_l2[..4], &[0x08, 0x16, 0x10, 0x00]);

    // 准备请求内嵌的 id/size 必须与改写后的文件一致
    let wp = WearPacket::decode(&sent[0].plaintext_l2).unwrap();
    match wp.payload {
        Some(WearPacketPayload::WatchFace(wf)) => match wf.payload {
            Some(WatchFacePayload::PrepareInfo(pi)) => {
                assert_eq!(pi.id, "testwf01");
                assert_eq!(pi.size, 100);
                assert_eq!(pi.version_code, 65536);
            }
            other => panic!("载荷应为 PrepareInfo，实际 {other:?}"),
        },
        other => panic!("载荷应为 WatchFace，实际 {other:?}"),
    }

    // Mass 通道 1 条分片（body=126B ≤ cap=238），带 02 01 头与片号 1/1
    let mass_records = wire_for_assert.sent_mass_records();
    assert_eq!(mass_records.len(), 1);
    let m = &mass_records[0].plaintext_l2;
    assert_eq!(&m[0..2], &[0x02, 0x01]);
    assert_eq!(u16::from_le_bytes([m[2], m[3]]), 1, "total_parts");
    assert_eq!(u16::from_le_bytes([m[4], m[5]]), 1, "current_part");
}

#[test]
fn test_watchface_install_rejects_busy_and_store_prefix() {
    let _guard = BRIDGE_FLOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock_wire = Box::new(MockInstallWireSender::new());
    mock_wire.set_authenticated(true);
    let wire_for_thread = mock_wire.clone();
    let wire_for_assert = mock_wire.clone();

    let mut transport = XiaomiInstallTransport::with_wire(mock_wire);
    let file_bytes = vec![0x5Au8; 0x40];
    let md5_hex = "00112233445566778899aabbccddeeff".to_string();

    // 设备在收到表盘准备请求后回 BUSY(1)
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if wire_for_thread.sent_records().len() >= 1 {
                dispatch_install_frame_event(InstallFrameEvent::Incoming(Frame {
                    frame_type: 0x03,
                    seq: 1,
                    payload: make_prepare_response(1),
                }));
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    });

    // 负例 1：设备 BUSY(1) → 失败，且不得继续发 Mass 准备
    let err = transport
        .install_watchface_file(&file_bytes, &md5_hex, Some("testwf01"))
        .expect_err("BUSY 应失败");
    assert!(err.contains("prepare_status=1"), "实际错误: {err}");
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(wire_for_assert.sent_records().len(), 1, "BUSY 后不应发 Mass 准备");

    // 负例 2：显式 1209 商店前缀 ID → 策略拒绝，且未发出任何帧
    let err2 = transport
        .install_watchface_file(&file_bytes, &md5_hex, Some("120917361"))
        .expect_err("1209 前缀应被策略拒绝");
    assert!(err2.contains("1209"), "实际错误: {err2}");
    assert_eq!(wire_for_assert.sent_records().len(), 1);
}
