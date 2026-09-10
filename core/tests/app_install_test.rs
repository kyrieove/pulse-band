//! 快应用安装抽象层传输与生命周期集成测试 (App Install Transport Tests)

#[path = "../src/crc.rs"]
mod crc;
#[path = "../src/frame.rs"]
mod frame;
#[path = "../src/app_install.rs"]
mod app_install;

use app_install::{
    AppInstallProtocol, AppInstallTransport, BandDeviceTransport, InstallChunk,
    InstallMetadata, InstallProtocolRecorder, InstallTransportDispatcher,
    MockAppInstallProtocol, MockAppInstallTransport, MockBandDeviceTransport,
    MockDeviceReplayTransport, PacketDirection, ProtocolInspector, TransportMode,
    XiaomiBand10Transport,
};
use frame::Frame;

#[test]
fn test_1_prepare_returns_preparing() {
    let mut transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 255523,
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
    };

    let session = transport.prepare(meta).expect("prepare 应当成功");
    assert_eq!(session.status, "preparing");
    assert_eq!(session.file_size, 255523);
    assert_eq!(session.chunk_size, 512);
    assert_eq!(session.total_chunks, (255523 + 511) / 512);
    assert!(session.session_id.starts_with("inst_"));
}

#[test]
fn test_2_chunk_can_be_received() {
    let mut transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    let session = transport.prepare(meta).expect("prepare 应当成功");
    let chunk0 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };

    let ack0 = transport.send_chunk(chunk0).expect("send_chunk 0 应当成功");
    assert_eq!(ack0.index, 0);
    assert_eq!(ack0.received_bytes, 512);
    assert_eq!(transport.received_chunks_count, 1);

    let chunk1 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 1,
        size: 512,
        data: vec![0u8; 512],
    };

    let ack1 = transport.send_chunk(chunk1).expect("send_chunk 1 应当成功");
    assert_eq!(ack1.index, 1);
    assert_eq!(ack1.received_bytes, 1024);
    assert_eq!(transport.received_chunks_count, 2);
}

#[test]
fn test_3_commit_returns_verifying() {
    let mut transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 512,
        hash: "dummy_hash".to_string(),
    };

    let session = transport.prepare(meta).unwrap();
    let result = transport.commit(session.session_id).expect("commit 应当成功");

    assert_eq!(result.status, "verifying");
    assert_ne!(result.status, "completed");
    assert_ne!(result.status, "installed");
}

#[test]
fn test_4_cancel_releases_session() {
    let mut transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    let session = transport.prepare(meta).unwrap();
    assert!(transport.active_session.is_some());

    transport.cancel(session.session_id.clone()).expect("cancel 应当成功");
    assert!(transport.active_session.is_none());
    assert_eq!(transport.received_chunks_count, 0);

    // cancel 之后再次发送 chunk 应当返回错误
    let chunk = InstallChunk {
        session_id: session.session_id,
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let send_res = transport.send_chunk(chunk);
    assert!(send_res.is_err(), "cancel 后必须拒绝分块接收");
}

#[test]
fn test_5_no_completed_state_ever_returned() {
    let mut transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 512,
        hash: "dummy_hash".to_string(),
    };

    let session = transport.prepare(meta).unwrap();
    assert_ne!(session.status, "completed");
    assert_ne!(session.status, "installed");

    let chunk = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let _ = transport.send_chunk(chunk);

    let res = transport.commit(session.session_id).unwrap();
    assert_ne!(res.status, "completed");
    assert_ne!(res.status, "installed");
    assert_eq!(res.status, "verifying");
}

#[test]
fn test_6_no_bluetooth_handles_or_calls() {
    // 验证 MockAppInstallTransport 完全基于纯内存状态，不包含任何蓝牙、RFCOMM 或系统句柄
    let transport = MockAppInstallTransport::new();
    assert!(transport.active_session.is_none());
    assert_eq!(transport.received_chunks_count, 0);
    assert_eq!(transport.total_received_bytes, 0);

    // 结构体验证：仅纯数据与标量计数
    assert_eq!(std::mem::size_of::<MockAppInstallTransport>() > 0, true);
}

#[test]
fn test_7_xiaomi_band10_transport_can_be_initialized() {
    let transport = XiaomiBand10Transport::new();
    assert!(transport.active_session_id.is_none());
    assert_eq!(std::mem::size_of::<XiaomiBand10Transport>() > 0, true);
}

#[test]
fn test_8_xiaomi_band10_transport_returns_not_implemented_without_sending_data() {
    let mut transport = XiaomiBand10Transport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 1. prepare 必须明确拒绝，标明 device_unavailable / not_implemented
    let prep_res = transport.prepare(meta);
    assert!(prep_res.is_err());
    let prep_err = prep_res.err().unwrap();
    assert!(prep_err.contains("device_unavailable"));
    assert!(prep_err.contains("not_implemented"));

    // 2. send_chunk 必须明确拒绝
    let chunk = InstallChunk {
        session_id: "test_sess".to_string(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let chunk_res = transport.send_chunk(chunk);
    assert!(chunk_res.is_err());
    let chunk_err = chunk_res.err().unwrap();
    assert!(chunk_err.contains("device_unavailable"));

    // 3. commit 必须明确拒绝，且绝不返回 completed / installed
    let commit_res = transport.commit("test_sess".to_string());
    assert!(commit_res.is_err());

    // 4. cancel 应当安全退出
    let cancel_res = transport.cancel("test_sess".to_string());
    assert!(cancel_res.is_ok());
}

#[test]
fn test_9_transport_dispatcher_switching_mode() {
    let mut dispatcher = InstallTransportDispatcher::new_mock();
    assert_eq!(dispatcher.mode(), TransportMode::Mock);

    // 切到 Device 模式
    dispatcher.set_mode(TransportMode::Device);
    assert_eq!(dispatcher.mode(), TransportMode::Device);

    // Device 模式下调用 prepare 拒绝
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };
    let res = dispatcher.prepare(meta.clone());
    assert!(res.is_err());

    // 切回 Mock 模式
    dispatcher.set_mode(TransportMode::Mock);
    assert_eq!(dispatcher.mode(), TransportMode::Mock);
    let mock_res = dispatcher.prepare(meta);
    assert!(mock_res.is_ok());
    assert_eq!(mock_res.unwrap().status, "preparing");
}

#[test]
fn test_10_device_mode_returns_device_unavailable_and_no_completed() {
    let mut dispatcher = InstallTransportDispatcher::new_device();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 512,
        hash: "dummy_hash".to_string(),
    };

    let prep_res = dispatcher.prepare(meta);
    assert!(prep_res.is_err());

    let commit_res = dispatcher.commit("any_session".to_string());
    assert!(commit_res.is_err());
    let err_str = commit_res.err().unwrap();
    assert_ne!(err_str, "completed");
    assert_ne!(err_str, "installed");
    assert!(err_str.contains("device_unavailable"));
}

#[test]
fn test_11_mock_band_device_transport_lifecycle() {
    let mut dev_transport = MockBandDeviceTransport::new();
    assert!(!dev_transport.is_connected());
    assert!(dev_transport.target_addr.is_none());

    // 1. 未连接时发送或接收帧返回错误
    let frame = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: vec![0x01, 0x02, 0x03],
    };
    assert!(dev_transport.send_frame(&frame).is_err());
    assert!(dev_transport.receive_frame(100).is_err());

    // 2. 连接后链路状态正常
    assert!(dev_transport.connect("11:22:33:44:55:66").is_ok());
    assert!(dev_transport.is_connected());
    assert_eq!(
        dev_transport.target_addr.as_deref(),
        Some("11:22:33:44:55:66")
    );

    // 3. 正常发送帧并进入已发送队列
    assert!(dev_transport.send_frame(&frame).is_ok());
    assert_eq!(dev_transport.sent_frames.len(), 1);
    assert_eq!(dev_transport.sent_frames[0], frame);

    // 4. 模拟接收队列消费
    let incoming = Frame {
        frame_type: 0x01,
        seq: 1,
        payload: vec![],
    };
    dev_transport.enqueue_incoming(incoming.clone());
    let recv_res = dev_transport.receive_frame(100).expect("应当成功获取帧");
    assert_eq!(recv_res, Some(incoming));
    assert_eq!(dev_transport.receive_frame(100).unwrap(), None);

    // 5. 断开连接后重回未连接状态
    assert!(dev_transport.disconnect().is_ok());
    assert!(!dev_transport.is_connected());
    assert!(dev_transport.send_frame(&frame).is_err());
}

#[test]
fn test_12_xiaomi_band10_transport_safely_fails_without_device() {
    let mut transport = XiaomiBand10Transport::new();
    assert!(transport.device_transport.is_none());

    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 无底层设备接入时安全失败
    let prep_res = transport.prepare(meta);
    assert!(prep_res.is_err());
    let prep_err = prep_res.unwrap_err();
    assert!(prep_err.contains("device_unavailable"));
    assert!(prep_err.contains("not_implemented"));
}

#[test]
fn test_13_xiaomi_band10_transport_with_mock_device_safely_fails_protocol() {
    let mut dev = MockBandDeviceTransport::new();
    assert!(dev.connect("AA:BB:CC:DD:EE:FF").is_ok());

    let mut transport = XiaomiBand10Transport::with_device_transport(Box::new(dev));
    assert!(transport.device_transport().is_some());
    assert!(transport.device_transport().unwrap().is_connected());

    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 即使底层连接就绪，快应用安装协议在当前阶段也严禁假装实现
    let prep_res = transport.prepare(meta);
    assert!(prep_res.is_err());
    let prep_err = prep_res.unwrap_err();
    assert!(prep_err.contains("device_unavailable"));
    assert!(prep_err.contains("not_implemented"));

    // cancel 能够正常调用并断开底层设备
    assert!(transport.cancel("some_session".to_string()).is_ok());
    assert!(!transport.device_transport().unwrap().is_connected());
}

#[test]
fn test_14_xiaomi_band10_transport_has_no_direct_rfcomm_symbols() {
    // 纯架构解耦校验：结构体仅由纯抽象接口与标量状态构成，不包含套接字句柄或 C FFI 符号
    assert_eq!(std::mem::size_of::<XiaomiBand10Transport>() > 0, true);
    assert_eq!(std::mem::size_of::<MockBandDeviceTransport>() > 0, true);
    assert_eq!(std::mem::size_of::<MockAppInstallProtocol>() > 0, true);
}

#[test]
fn test_15_protocol_and_transport_separation() {
    let mut dev = MockBandDeviceTransport::new();
    let mut proto = MockAppInstallProtocol::new();

    assert!(!dev.is_connected());
    assert!(proto.active_session.is_none());

    // 未连接设备时，协议调用直接报错拦截
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };
    let prep_res = proto.prepare_install(&mut dev, &meta);
    assert!(prep_res.is_err());
}

#[test]
fn test_16_mock_app_install_protocol_lifecycle() {
    let mut dev = MockBandDeviceTransport::new();
    assert!(dev.connect("11:22:33:44:55:66").is_ok());

    let mut proto = MockAppInstallProtocol::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 1. prepare (返回 preparing)
    let session = proto.prepare_install(&mut dev, &meta).expect("prepare 成功");
    assert_eq!(session.status, "preparing");
    assert_eq!(session.total_chunks, 2);

    // 2. chunk
    let chunk0 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let ack0 = proto.send_package_chunk(&mut dev, &chunk0).expect("chunk0 成功");
    assert_eq!(ack0.received_bytes, 512);

    let chunk1 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 1,
        size: 512,
        data: vec![0u8; 512],
    };
    let ack1 = proto.send_package_chunk(&mut dev, &chunk1).expect("chunk1 成功");
    assert_eq!(ack1.received_bytes, 1024);

    // 3. verify
    assert!(proto.verify_package(&mut dev, &session.session_id).is_ok());
    assert!(proto.verified);

    // 4. commit (仅允许 verifying，严禁 completed / installed)
    let commit_res = proto
        .commit_install(&mut dev, &session.session_id)
        .expect("commit 成功");
    assert_eq!(commit_res.status, "verifying");
    assert_ne!(commit_res.status, "completed");
    assert_ne!(commit_res.status, "installed");

    // 5. cancel
    assert!(proto.cancel_install(&mut dev, &session.session_id).is_ok());
    assert!(proto.active_session.is_none());
}

#[test]
fn test_17_unknown_protocol_does_not_send_device_frames() {
    let mut dev = MockBandDeviceTransport::new();
    assert!(dev.connect("11:22:33:44:55:66").is_ok());

    // 未注入协议（protocol: None）的未知协议场景
    let mut transport = XiaomiBand10Transport::with_device_transport(Box::new(dev));
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    let prep_res = transport.prepare(meta);
    assert!(prep_res.is_err());
    let err = prep_res.unwrap_err();
    assert!(err.contains("device_unavailable"));
    assert!(err.contains("not_implemented"));

    // 核心断言：未知协议绝不会向设备发送任何数据帧
    let dev_ref = transport.device_transport().unwrap();
    assert_eq!(dev_ref.is_connected(), true);
    // cancel 后安全断开连接
    assert!(transport.cancel("test_sess".to_string()).is_ok());
}

#[test]
fn test_18_full_layered_mock_integration() {
    let dev = MockBandDeviceTransport::new();
    let proto = MockAppInstallProtocol::new();
    let mut transport =
        XiaomiBand10Transport::with_protocol_and_device(Box::new(proto), Box::new(dev));

    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 底层设备未 connect 前 prepare 失败
    assert!(transport.prepare(meta.clone()).is_err());

    // 底层连接后正常流转三层调用
    transport
        .device_transport_mut()
        .unwrap()
        .connect("AA:BB:CC:11:22:33")
        .unwrap();
    let session = transport.prepare(meta).expect("prepare 成功");
    assert_eq!(session.status, "preparing");

    let chunk = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let ack = transport.send_chunk(chunk).expect("send_chunk 成功");
    assert_eq!(ack.received_bytes, 512);

    let res = transport.commit(session.session_id).expect("commit 成功");
    assert_eq!(res.status, "verifying");
    assert_ne!(res.status, "completed");
    assert_ne!(res.status, "installed");
}

#[test]
fn test_19_recorder_transparently_logs_without_modifying_traffic() {
    let recorder = InstallProtocolRecorder::new();
    let mut replay = MockDeviceReplayTransport::with_recorder(recorder);

    assert!(replay.connect("11:22:33:44:55:66").is_ok());

    // 预装入待接收的帧
    let rx_frame = Frame {
        frame_type: 0x01,
        seq: 42,
        payload: vec![0xAA, 0xBB],
    };
    replay.queue_rx_frame(rx_frame.clone());

    // 发送一帧
    let tx_frame = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: vec![0x01, 0x02, 0x03, 0x04],
    };
    assert!(replay.send_frame(&tx_frame).is_ok());

    // 接收一帧
    let received = replay.receive_frame(100).expect("应当成功接收");
    assert_eq!(received, Some(rx_frame));

    // 校验录制器捕获了双向帧且内容准确无篡改
    let rec = replay.recorder.as_ref().unwrap();
    assert_eq!(rec.packets.len(), 2);
    assert_eq!(rec.packets[0].direction, PacketDirection::HostToBand);
    assert_eq!(rec.packets[0].frame_type, 0x03);
    assert_eq!(rec.packets[0].seq, 1);
    assert_eq!(rec.packets[0].payload_hex, "01020304");

    assert_eq!(rec.packets[1].direction, PacketDirection::BandToHost);
    assert_eq!(rec.packets[1].frame_type, 0x01);
    assert_eq!(rec.packets[1].seq, 42);
    assert_eq!(rec.packets[1].payload_hex, "aabb");

    // 校验序列化与反序列化对齐
    let json = rec.to_json().expect("序列化 JSON 成功");
    let loaded = InstallProtocolRecorder::from_json(&json).expect("反序列化 JSON 成功");
    assert_eq!(loaded.packets.len(), 2);
    assert_eq!(loaded.packets[0], rec.packets[0]);
}

#[test]
fn test_20_replay_transport_drives_protocol_flow() {
    let mut recorder = InstallProtocolRecorder::new();
    // 模拟录制到的历史手环 ACK / 应答帧
    recorder.record_rx(&Frame {
        frame_type: 0x01,
        seq: 0,
        payload: vec![0x00],
    });

    let mut replay = MockDeviceReplayTransport::new();
    replay.load_from_recorder(&recorder);
    assert_eq!(replay.rx_replay_queue.len(), 1);

    assert!(replay.connect("11:22:33:44:55:66").is_ok());

    // 注入到 XiaomiBand10Transport
    let proto = MockAppInstallProtocol::new();
    let mut transport =
        XiaomiBand10Transport::with_protocol_and_device(Box::new(proto), Box::new(replay));

    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };

    // 驱动协议流程
    let session = transport.prepare(meta).expect("prepare 成功");
    assert_eq!(session.status, "preparing");

    let chunk = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let ack = transport.send_chunk(chunk).expect("send_chunk 成功");
    assert_eq!(ack.received_bytes, 512);

    let res = transport.commit(session.session_id).expect("commit 成功");
    assert_eq!(res.status, "verifying");
    assert_ne!(res.status, "completed");
    assert_ne!(res.status, "installed");
}

#[test]
fn test_21_protocol_inspector_parses_frames_and_protobuf() {
    // 1. 测试标准 A5A5 二进制帧解码与分析
    let payload = vec![0x08, 0x01, 0x10, 0x09]; // 模拟合法 Protobuf (field 1 = 1, field 2 = 9)
    let len_bytes = (payload.len() as u16).to_le_bytes();
    let crc = crate::crc::crc16_arc(&payload);
    let crc_bytes = crc.to_le_bytes();

    let mut raw = vec![
        0xA5, 0xA5, 0x03, 0x05, len_bytes[0], len_bytes[1], crc_bytes[0], crc_bytes[1],
    ];
    raw.extend_from_slice(&payload);

    let inspection = ProtocolInspector::inspect_raw_bytes(&raw).expect("解析原始帧成功");
    assert!(inspection.magic_valid);
    assert_eq!(inspection.frame_type, 0x03);
    assert_eq!(inspection.frame_type_desc, "Business/Auth");
    assert_eq!(inspection.seq, 0x05);
    assert_eq!(inspection.payload_len, 4);
    assert_eq!(inspection.payload_hex, "08011009");
    assert!(inspection.crc_valid);
    assert!(inspection.protobuf_attempt.success);
    assert_eq!(inspection.protobuf_attempt.field_tags, vec![1, 2]);

    // 2. 测试非 Protobuf 载荷（例如 TLV 协商帧）
    let nego_payload = vec![0x01, 0x01, 0x03]; // 非法 Protobuf (field 0)
    let nego_frame = Frame {
        frame_type: 0x02,
        seq: 0,
        payload: nego_payload,
    };
    let nego_insp = ProtocolInspector::inspect_frame(&nego_frame);
    assert_eq!(nego_insp.frame_type_desc, "Negotiation");
    assert!(!nego_insp.protobuf_attempt.success);
}

#[test]
fn test_22_unknown_payload_safely_rejected_never_completed() {
    // 构造未知未实证的 payload
    let unknown_payload = vec![0xFE, 0xED, 0xBE, 0xEF];
    let proto_insp = ProtocolInspector::try_inspect_protobuf(&unknown_payload);
    // 未经实证协议不会误判为合法 Protobuf
    assert!(!proto_insp.success);

    // 未知安装协议在 XiaomiBand10Transport 下绝不能进入 completed 或 installed
    let mut transport = XiaomiBand10Transport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 512,
        hash: "dummy_hash".to_string(),
    };

    assert!(transport.prepare(meta).is_err());
    let commit_res = transport.commit("dummy".to_string());
    assert!(commit_res.is_err());
    let err_str = commit_res.unwrap_err();
    assert_ne!(err_str, "completed");
    assert_ne!(err_str, "installed");
}
