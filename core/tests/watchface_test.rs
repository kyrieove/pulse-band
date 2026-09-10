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
    build_watchface_list_query, decode_watchface_list_response, WatchFace, WatchFaceId,
    WatchFaceItem,
};
use app_install::install::xiaomi::wear_packet::{WearPacket, WearPacketPayload, WearPacketType};
use app_install::install::xiaomi::device_session::MockInstallWireSender;
use app_install::install::xiaomi::runtime_bridge::{
    dispatch_install_frame_event, InstallFrameEvent, XiaomiInstallTransport,
};
use frame::Frame;

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
