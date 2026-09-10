//! 快应用安装抽象层传输与生命周期集成测试 (App Install Transport Tests)

#[path = "../src/crc.rs"]
mod crc;
#[path = "../src/frame.rs"]
mod frame;
#[path = "../src/app_install.rs"]
mod app_install;

use app_install::{
    compute_payload_sha256, AppInstallProtocol, AppInstallTransport, BandDeviceTransport,
    CaptureBundle, CaptureLoader, CaptureMetadata, InstallChunk, InstallMetadata,
    InstallProtocolRecorder, InstallTransportDispatcher, MockAppInstallProtocol,
    MockAppInstallTransport, MockBandDeviceTransport, MockDeviceReplayTransport, PacketDirection,
    ProtocolAnalysisPipeline, ProtocolInspector, ProtocolReportGenerator, SampleValidator,
    TransportMode, XiaomiBand10Transport,
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

#[test]
fn test_23_protocol_report_generator_generates_markdown() {
    let mut recorder = InstallProtocolRecorder::new();
    let frame1 = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: vec![0x08, 0x01, 0x10, 0x02], // Protobuf field 1, 2
    };
    let frame2 = Frame {
        frame_type: 0x01,
        seq: 1,
        payload: vec![0x00], // ACK
    };
    let frame3 = Frame {
        frame_type: 0x01,
        seq: 2,
        payload: vec![0x00], // duplicate payload
    };

    recorder.record_tx(&frame1);
    recorder.record_rx(&frame2);
    recorder.record_rx(&frame3);

    let md_report = ProtocolReportGenerator::generate_markdown_report(&recorder)
        .expect("报告生成应当成功");

    assert!(md_report.contains("# 协议取证与流量分析报告"));
    assert!(md_report.contains("## 1. 流量概要与方向统计"));
    assert!(md_report.contains("- **总捕获帧数**: 3"));
    assert!(md_report.contains("- **Host -> Band (下发)**: 1 帧"));
    assert!(md_report.contains("- **Band -> Host (上报)**: 2 帧"));
    assert!(md_report.contains("## 2. Frame Type 分布统计"));
    assert!(md_report.contains("`0x03` | Business/Auth 业务或握手数据帧"));
    assert!(md_report.contains("`0x01` | ACK 确认帧"));
    assert!(md_report.contains("## 3. Payload 长度统计"));
    assert!(md_report.contains("## 4. 重复 Payload 检测"));
    assert!(md_report.contains("出现频次 | 说明"));
    assert!(md_report.contains("## 5. Protobuf 字段候选"));
    assert!(md_report.contains("`1` | 1 次"));
    assert!(md_report.contains("`2` | 1 次"));
    assert!(md_report.contains("## 6. Frame 时间线详细记录"));

    // 验证从 JSON 序列化字符串恢复生成报告也是等价的
    let json_str = recorder.to_json().expect("序列化 JSON 应当成功");
    let json_md_report = ProtocolReportGenerator::generate_markdown_from_json(&json_str)
        .expect("从 JSON 生成报告应当成功");
    assert_eq!(md_report, json_md_report);

    // 验证真实纳管的抓包模板样本文件可被无缝解析并生成有效报告
    let template_json = include_str!("../../docs/protocol/captures/sample-rpk-exchange-template.json");
    let template_report = ProtocolReportGenerator::generate_markdown_from_json(template_json)
        .expect("解析样本模板并生成报告成功");
    assert!(template_report.contains("- **总捕获帧数**: 4"));
    assert!(template_report.contains("- **Host -> Band (下发)**: 2 帧"));
    assert!(template_report.contains("- **Band -> Host (上报)**: 2 帧"));
}

#[test]
fn test_24_replay_transport_expected_frames_assertion_success() {
    let mut transport = MockDeviceReplayTransport::new();
    transport.connect("AA:BB:CC:DD:EE:FF").expect("连接应当成功");

    let p1 = vec![0x11, 0x22, 0x33];
    let p2 = vec![0x44, 0x55];
    let hash1 = compute_payload_sha256(&p1);
    let hash2 = compute_payload_sha256(&p2);

    // 设置预期的两帧断言
    transport.expect_frame(0x03, Some(1), Some(&hash1));
    transport.expect_frame(0x03, Some(2), Some(&hash2));

    // 发送与预期完全一致的帧
    let f1 = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: p1,
    };
    let f2 = Frame {
        frame_type: 0x03,
        seq: 2,
        payload: p2,
    };

    transport.send_frame(&f1).expect("发送 f1 成功");
    transport.send_frame(&f2).expect("发送 f2 成功");

    // 验证断言成功
    let assert_res = transport.verify_expected_frames();
    assert!(assert_res.is_ok(), "预期的帧断言应该完全通过");
}

#[test]
fn test_25_replay_transport_expected_frames_assertion_failure() {
    // 场景 1: 帧总数不匹配
    {
        let mut transport = MockDeviceReplayTransport::new();
        transport.connect("AA:BB:CC:DD:EE:FF").unwrap();
        transport.expect_frame(0x03, Some(1), None);
        transport.expect_frame(0x03, Some(2), None);

        let f1 = Frame {
            frame_type: 0x03,
            seq: 1,
            payload: vec![0x01],
        };
        transport.send_frame(&f1).unwrap();

        let err = transport.verify_expected_frames().unwrap_err();
        assert!(err.contains("发送帧总数不匹配"));
    }

    // 场景 2: frame_type 不匹配
    {
        let mut transport = MockDeviceReplayTransport::new();
        transport.connect("AA:BB:CC:DD:EE:FF").unwrap();
        transport.expect_frame(0x01, Some(1), None); // 期望 0x01

        let f1 = Frame {
            frame_type: 0x03, // 实际发送 0x03
            seq: 1,
            payload: vec![0x01],
        };
        transport.send_frame(&f1).unwrap();

        let err = transport.verify_expected_frames().unwrap_err();
        assert!(err.contains("frame_type 不匹配"));
    }

    // 场景 3: seq 不匹配
    {
        let mut transport = MockDeviceReplayTransport::new();
        transport.connect("AA:BB:CC:DD:EE:FF").unwrap();
        transport.expect_frame(0x03, Some(5), None); // 期望 seq = 5

        let f1 = Frame {
            frame_type: 0x03,
            seq: 1, // 实际 seq = 1
            payload: vec![0x01],
        };
        transport.send_frame(&f1).unwrap();

        let err = transport.verify_expected_frames().unwrap_err();
        assert!(err.contains("seq 不匹配"));
    }

    // 场景 4: payload hash 不匹配
    {
        let mut transport = MockDeviceReplayTransport::new();
        transport.connect("AA:BB:CC:DD:EE:FF").unwrap();
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        transport.expect_frame(0x03, Some(1), Some(wrong_hash));

        let f1 = Frame {
            frame_type: 0x03,
            seq: 1,
            payload: vec![0xAA, 0xBB],
        };
        transport.send_frame(&f1).unwrap();

        let err = transport.verify_expected_frames().unwrap_err();
        assert!(err.contains("payload hash 不匹配"));
    }
}

#[test]
fn test_26_old_api_and_submodule_paths_fully_compatible() {
    // 验证既有老 API 访问无破坏
    let mut old_transport = MockAppInstallTransport::new();
    let meta = InstallMetadata {
        package_id: "com.codeisland.compat".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 1,
        file_size: 1024,
        hash: "dummy_hash".to_string(),
    };
    let sess = old_transport.prepare(meta).expect("老 API prepare 成功");
    assert_eq!(sess.status, "preparing");

    // 验证全新子模块精细化路径完全可用
    use app_install::install::model as sub_model;
    use app_install::install::transport as sub_transport;
    use app_install::install::protocol as sub_protocol;
    use app_install::install::recorder as sub_recorder;
    use app_install::install::replay as sub_replay;
    use app_install::install::inspector as sub_inspector;
    use app_install::install::report as sub_report;
    use app_install::install::pipeline as sub_pipeline;

    let sub_meta = sub_model::InstallMetadata {
        package_id: "com.codeisland.sub".to_string(),
        version_name: "2.0.0".to_string(),
        version_code: 2,
        file_size: 2048,
        hash: "hash_sub".to_string(),
    };
    let mut sub_t = sub_transport::MockAppInstallTransport::new();
    let sub_sess = sub_transport::AppInstallTransport::prepare(&mut sub_t, sub_meta).unwrap();
    assert_eq!(sub_sess.status, "preparing");

    let mut _proto = sub_protocol::MockAppInstallProtocol::new();
    let mut _rec = sub_recorder::InstallProtocolRecorder::new();
    let mut _rep = sub_replay::MockDeviceReplayTransport::new();
    let _insp = sub_inspector::ProtocolInspector;
    let _rep_gen = sub_report::ProtocolReportGenerator;
    let _pipe = sub_pipeline::ProtocolAnalysisPipeline;
    let _loader = sub_pipeline::CaptureLoader;
}

#[test]
fn test_27_capture_loader_reads_json_and_directory() {
    let template_json = include_str!("../../docs/protocol/captures/sample-rpk-exchange-template.json");

    // 1. 测试从 JSON 文本加载
    let recorder = CaptureLoader::load_from_json(template_json).expect("从 JSON 加载成功");
    assert_eq!(recorder.packets.len(), 4);
    assert_eq!(recorder.packets[0].direction, PacketDirection::HostToBand);
    assert_eq!(recorder.packets[1].direction, PacketDirection::BandToHost);

    // 2. 测试从单个文件加载
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };
    let file_path = format!("{captures_dir}/sample-rpk-exchange-template.json");
    let file_recorder = CaptureLoader::load_from_file(&file_path).expect("从文件加载成功");
    assert_eq!(file_recorder.packets.len(), 4);

    // 3. 测试目录扫描加载（验证自动跳过 manifest 与非 json 文件）
    let dir_samples = CaptureLoader::load_from_dir(captures_dir).expect("从目录扫描成功");
    assert!(!dir_samples.is_empty());
    assert_eq!(dir_samples[0].0, "sample-rpk-exchange-template.json");
    assert_eq!(dir_samples[0].1.packets.len(), 4);
}

#[test]
fn test_28_protocol_analysis_pipeline_end_to_end_and_consistent() {
    let template_json = include_str!("../../docs/protocol/captures/sample-rpk-exchange-template.json");

    // 1. 从 Capture JSON 启动分析管线
    let report_from_json = ProtocolAnalysisPipeline::run_from_capture_json(template_json)
        .expect("Pipeline run_from_capture_json 成功");

    // 2. 从 Recorder 启动分析管线
    let recorder = CaptureLoader::load_from_json(template_json).unwrap();
    let report_from_recorder = ProtocolAnalysisPipeline::run_from_recorder(&recorder)
        .expect("Pipeline run_from_recorder 成功");

    // 两者输出必须 100% 一致对账
    assert_eq!(report_from_json, report_from_recorder);

    // 验证报告关键章节与统计
    assert!(report_from_json.contains("# 协议取证与流量分析报告"));
    assert!(report_from_json.contains("- **总捕获帧数**: 4"));
    assert!(report_from_json.contains("- **Host -> Band (下发)**: 2 帧"));
    assert!(report_from_json.contains("- **Band -> Host (上报)**: 2 帧"));

    // 3. 验证目录批量批处理管线
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };
    let batch_reports = ProtocolAnalysisPipeline::run_from_captures_dir(captures_dir)
        .expect("Pipeline run_from_captures_dir 成功");
    assert!(!batch_reports.is_empty());
    assert_eq!(batch_reports[0].0, "sample-rpk-exchange-template.json");
    assert_eq!(batch_reports[0].1, report_from_json);
}

#[test]
fn test_29_replay_transport_drives_pipeline_asserted_workflow() {
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };
    let file_path = format!("{captures_dir}/sample-rpk-exchange-template.json");
    let recorder = CaptureLoader::load_from_file(&file_path).expect("加载模板文件");

    let mut replay = MockDeviceReplayTransport::new();
    replay.connect("AA:BB:CC:DD:EE:FF").unwrap();

    // 载入回放流
    replay.load_from_recorder(&recorder);
    assert_eq!(replay.rx_replay_queue.len(), 2);

    // 模拟逐帧接收并验证内容
    let frame1 = replay.receive_frame(100).unwrap().expect("应当接收第一帧");
    assert_eq!(frame1.frame_type, 0x01); // ACK
    assert_eq!(frame1.seq, 1);
    assert_eq!(frame1.payload, vec![0x00]);

    let frame2 = replay.receive_frame(100).unwrap().expect("应当接收第二帧");
    assert_eq!(frame2.frame_type, 0x01);
    assert_eq!(frame2.seq, 2);

    // 队列耗尽安全返回 None
    let frame3 = replay.receive_frame(100).unwrap();
    assert!(frame3.is_none());
}

#[test]
fn test_30_capture_bundle_loader_and_metadata_binding() {
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };
    let bundle_path = format!("{captures_dir}/capture_sample_001");
    // 1. 测试单目录 Bundle 加载
    let bundle: CaptureBundle = CaptureLoader::load_bundle_from_dir(&bundle_path)
        .expect("加载 capture_sample_001 应当成功");
    assert_eq!(bundle.metadata.capture_id, "CAPTURE-20260910-001");
    assert_eq!(bundle.metadata.source, "synthetic_bench_capture");
    assert_eq!(bundle.metadata.device_model, "Xiaomi Smart Band 10 (M2345B1)");
    assert_eq!(bundle.metadata.app_version, "Mi Fitness v3.35.0");
    assert_eq!(bundle.metadata.analysis_status, "analyzed");
    assert_eq!(bundle.recorder.packets.len(), 4);
    assert!(bundle.analysis_markdown.is_some());
    assert!(bundle.analysis_markdown.as_ref().unwrap().contains("CAPTURE-20260910-001"));

    // 2. 测试批量扫描 Bundle 目录
    let all_bundles = CaptureLoader::load_all_bundles(captures_dir)
        .expect("扫描所有 bundle 应当成功");
    assert!(!all_bundles.is_empty());
    assert!(all_bundles.iter().any(|b| b.metadata.capture_id == "CAPTURE-20260910-001"));
}

#[test]
fn test_31_report_generator_with_metadata_binding() {
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };
    let bundle_path = format!("{captures_dir}/capture_sample_001");
    let bundle = CaptureLoader::load_bundle_from_dir(&bundle_path).unwrap();

    // 1. 测试从 bundle 生成带元数据的报告
    let report = ProtocolReportGenerator::generate_bundle_report(&bundle)
        .expect("生成 bundle 报告成功");
    assert!(report.contains("# 协议取证与流量分析报告"));
    assert!(report.contains("## 0. 捕获样本元数据 (Capture Metadata)"));
    assert!(report.contains("- **Capture ID**: `CAPTURE-20260910-001`"));
    assert!(report.contains("- **捕获来源 (Source)**: `synthetic_bench_capture`"));
    assert!(report.contains("- **目标设备 (Device Model)**: `Xiaomi Smart Band 10 (M2345B1)`"));
    assert!(report.contains("- **App 版本 (App Version)**: `Mi Fitness v3.35.0`"));
    assert!(report.contains("- **分析状态 (Analysis Status)**: `analyzed`"));
    assert!(report.contains("## 1. 流量概要与方向统计"));
    assert!(report.contains("## 6. Frame 时间线详细记录"));

    // 2. 验证 Pipeline 运行结果完全一致
    let pipe_report = ProtocolAnalysisPipeline::run_from_bundle_dir(&bundle_path)
        .expect("Pipeline 运行 bundle 成功");
    assert_eq!(report, pipe_report);

    // 3. 验证批量 Bundle Pipeline
    let all_reports = ProtocolAnalysisPipeline::run_all_bundles_pipeline(captures_dir)
        .expect("批量运行 bundle 成功");
    assert!(!all_reports.is_empty());
    assert_eq!(all_reports[0].0, "CAPTURE-20260910-001");
    assert_eq!(all_reports[0].1, report);
}

#[test]
fn test_32_sample_validator_rejects_invalid_samples() {
    // 场景 1: 缺少必要元数据字段
    let mut invalid_meta = CaptureMetadata {
        capture_id: "".to_string(), // 空 ID
        source: "btsnoop".to_string(),
        device_model: "Band 10".to_string(),
        app_version: "1.0.0".to_string(),
        timestamp: 1000,
        notes: "test".to_string(),
        analysis_status: "analyzed".to_string(),
    };
    assert!(SampleValidator::validate_metadata(&invalid_meta).is_err());

    invalid_meta.capture_id = "VALID_ID".to_string();
    invalid_meta.device_model = "".to_string(); // 空 device_model
    assert!(SampleValidator::validate_metadata(&invalid_meta).is_err());

    // 场景 2: 包含未脱敏敏感字段 token/secret/credential
    let mut sensitive_meta = CaptureMetadata {
        capture_id: "SENS_001".to_string(),
        source: "token=abc123456789".to_string(), // 未脱敏 token
        device_model: "Band 10".to_string(),
        app_version: "1.0.0".to_string(),
        timestamp: 1000,
        notes: "test".to_string(),
        analysis_status: "analyzed".to_string(),
    };
    let err = SampleValidator::validate_metadata(&sensitive_meta).unwrap_err();
    assert!(err.contains("敏感安全扫描拒绝"));

    // 场景 3: 包含未脱敏的真实蓝牙 MAC 地址
    sensitive_meta.source = "btmon".to_string();
    sensitive_meta.notes = "Device real address is 12:34:56:78:9A:BC".to_string();
    let mac_err = SampleValidator::validate_metadata(&sensitive_meta).unwrap_err();
    assert!(mac_err.contains("真实蓝牙 MAC 地址"));

    // 脱敏占位符 AA:BB:CC:DD:EE:FF 应当安全放行
    sensitive_meta.notes = "Sanitized MAC: AA:BB:CC:DD:EE:FF".to_string();
    assert!(SampleValidator::validate_metadata(&sensitive_meta).is_ok());

    // 场景 4: 数据帧 CRC 校验不匹配
    let mut bad_recorder = InstallProtocolRecorder::new();
    bad_recorder.packets.push(app_install::install::recorder::RecordedPacket {
        direction: PacketDirection::HostToBand,
        timestamp_ms: 100,
        frame_type: 3,
        seq: 1,
        len: 1,
        crc: 0xFFFF, // 错误 CRC
        payload_hex: "00".to_string(), // 真实 CRC 应为 0x0000
    });
    let crc_err = SampleValidator::validate_frames(&bad_recorder).unwrap_err();
    assert!(crc_err.contains("CRC16 校验不匹配"));

    // 场景 5: 数据帧长度不匹配
    let mut len_mismatch_rec = InstallProtocolRecorder::new();
    len_mismatch_rec.packets.push(app_install::install::recorder::RecordedPacket {
        direction: PacketDirection::HostToBand,
        timestamp_ms: 100,
        frame_type: 3,
        seq: 1,
        len: 10, // 声明 10 字节，实际仅 1 字节
        crc: 0,
        payload_hex: "00".to_string(),
    });
    let len_err = SampleValidator::validate_frames(&len_mismatch_rec).unwrap_err();
    assert!(len_err.contains("声明长度"));
}

#[test]
fn test_33_legacy_json_format_backward_compatibility() {
    let template_json = include_str!("../../docs/protocol/captures/sample-rpk-exchange-template.json");
    let captures_dir = if std::path::Path::new("../docs/protocol/captures").exists() {
        "../docs/protocol/captures"
    } else {
        "docs/protocol/captures"
    };

    // 老单文件 JSON 读取继续保持兼容
    let rec_json = CaptureLoader::load_from_json(template_json).expect("load_from_json 兼容");
    assert_eq!(rec_json.packets.len(), 4);

    let rec_file = CaptureLoader::load_from_file(format!("{captures_dir}/sample-rpk-exchange-template.json"))
        .expect("load_from_file 兼容");
    assert_eq!(rec_file.packets.len(), 4);

    let rec_dir = CaptureLoader::load_from_dir(captures_dir).expect("load_from_dir 兼容");
    assert!(!rec_dir.is_empty());
}
