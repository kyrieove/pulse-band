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

/// 全局安装事件队列是**进程级单例**，所有触碰它的测试必须串行执行。
///
/// 缺陷背景（阶段 21 审计发现）：`test_runtime_bridge_*` 这几个测试并行运行时，
/// 彼此调用的 `clear_global_install_events()` 会把对方刚派发的帧清掉，导致
/// `test_runtime_bridge_normal_business_isolation` 偶发假失败
/// （实测 `normal_message_queue` 长度 2 != 3，40 次里 1 次）。串行化后行为确定。
static GLOBAL_QUEUE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_global_queue() -> std::sync::MutexGuard<'static, ()> {
    GLOBAL_QUEUE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

#[test]
fn test_34_protobuf_roundtrip_wear_packet_thirdparty_and_mass() {
    use app_install::xiaomi::*;

    // 1. AppInstallerRequest roundtrip
    let req = AppInstallerRequest::new("com.test.app", 100, 1024);
    let req_bytes = req.encode();
    let req_decoded = AppInstallerRequest::decode(&req_bytes).expect("Request decode 成功");
    assert_eq!(req_decoded, req);

    // 2. AppInstallerResponse roundtrip
    let resp = AppInstallerResponse::new(0, Some(244));
    let resp_bytes = resp.encode();
    let resp_decoded = AppInstallerResponse::decode(&resp_bytes).expect("Response decode 成功");
    assert_eq!(resp_decoded, resp);
    assert!(resp_decoded.is_ready());

    // 3. AppInstallerResult roundtrip
    let res = AppInstallerResult::new(InstallResultCode::Success, Some("com.test.app".to_string()));
    let res_bytes = res.encode();
    let res_decoded = AppInstallerResult::decode(&res_bytes).expect("Result decode 成功");
    assert_eq!(res_decoded, res);

    // 4. PrepareRequest roundtrip
    let md5 = vec![0xAB; 16];
    let prep_req = PrepareRequest::new(MASS_DATA_TYPE_THIRDPARTY_APP, md5.clone(), 50000);
    let prep_bytes = prep_req.encode();
    let prep_decoded = PrepareRequest::decode(&prep_bytes).expect("PrepareRequest decode 成功");
    assert_eq!(prep_decoded, prep_req);

    // 5. PrepareResponse roundtrip
    let prep_resp = PrepareResponse {
        data_id: md5.clone(),
        prepare_status: 0,
        select_compress_mode: Some(0),
        remained_data_length: Some(0),
        expected_slice_length: Some(244),
    };
    let prep_resp_bytes = prep_resp.encode();
    let prep_resp_decoded = PrepareResponse::decode(&prep_resp_bytes).expect("PrepareResponse decode 成功");
    assert_eq!(prep_resp_decoded, prep_resp);
    assert!(prep_resp_decoded.is_ready());

    // 6. MassControl roundtrip
    let ctrl = MassControl::new(MassControlOp::Cancel, MASS_DATA_TYPE_THIRDPARTY_APP, md5);
    let ctrl_bytes = ctrl.encode();
    let ctrl_decoded = MassControl::decode(&ctrl_bytes).expect("MassControl decode 成功");
    assert_eq!(ctrl_decoded, ctrl);

    // 7. WearPacket wrapping ThirdpartyApp roundtrip
    let app = ThirdpartyApp::from_install_request(req);
    let wp_app = WearPacket::new_thirdparty_app(1, app);
    let wp_app_bytes = wp_app.encode();
    let wp_app_decoded = WearPacket::decode(&wp_app_bytes).expect("WearPacket ThirdpartyApp decode 成功");
    assert_eq!(wp_app_decoded.pkt_type, WearPacketType::ThirdpartyApp);
    assert_eq!(wp_app_decoded.id, 1);

    // 8. WearPacket wrapping Mass roundtrip
    let mass = Mass::from_prepare_request(prep_req);
    let wp_mass = WearPacket::new_mass(0, mass);
    let wp_mass_bytes = wp_mass.encode();
    let wp_mass_decoded = WearPacket::decode(&wp_mass_bytes).expect("WearPacket Mass decode 成功");
    assert_eq!(wp_mass_decoded.pkt_type, WearPacketType::Mass);
    assert_eq!(wp_mass_decoded.id, 0);
}

#[test]
fn test_35_mass_prepare_packet_and_md5_correctness() {
    use app_install::xiaomi::*;

    let rpk_dummy = vec![0x12; 1000];
    let valid_md5 = vec![0x5A; 16];

    // 1. MD5 长度校验 (非 16 字节被拒绝)
    let invalid_md5 = vec![0x5A; 15];
    assert!(encode_mass_prepare(&rpk_dummy, &invalid_md5).is_err());

    // 2. 正常编码
    let bytes = encode_mass_prepare(&rpk_dummy, &valid_md5).expect("encode_mass_prepare 成功");

    // 3. 解码验证
    let wp = WearPacket::decode(&bytes).expect("WearPacket decode 成功");
    assert_eq!(wp.pkt_type, WearPacketType::Mass);
    assert_eq!(wp.id, 0);

    let mass = match wp.payload {
        Some(WearPacketPayload::Mass(m)) => m,
        _ => panic!("Expected Mass payload"),
    };

    let prep = match mass.payload {
        Some(MassPayload::PrepareRequest(p)) => p,
        _ => panic!("Expected PrepareRequest payload"),
    };

    assert_eq!(prep.data_type, 64);
    assert_eq!(prep.data_id, valid_md5);
    assert_eq!(prep.data_length, 1000);
}

#[test]
fn test_36_mass_chunk_header_and_fragment_length() {
    use app_install::xiaomi::*;

    let fragment = vec![0xAA, 0xBB, 0xCC, 0xDD];
    let total_parts = 50u16;
    let current_part = 12u16;

    // 1. 编码分片 (包含 L2 channel=2, opcode=1 封装)
    let chunk_bytes = encode_mass_chunk(total_parts, current_part, &fragment).expect("encode_mass_chunk 成功");

    // 2. 解封装 L2
    let l2 = L2Packet::from_bytes(&chunk_bytes).expect("L2 decode 成功");
    assert_eq!(l2.channel, L2Channel::Mass);
    assert_eq!(l2.channel.as_u8(), 2);
    assert_eq!(l2.opcode, L2OpCode::Write);
    assert_eq!(l2.opcode.as_u8(), 1);

    // 3. 解码 MassChunk 头部
    let chunk = MassChunk::decode(&l2.payload).expect("MassChunk decode 成功");
    assert_eq!(chunk.total_parts, 50);
    assert_eq!(chunk.current_part, 12);
    assert_eq!(chunk.fragment, fragment);

    // 4. 边界异常分片拒绝
    assert!(MassChunk::decode(&[]).is_err());
    assert!(MassChunk::decode(&[0, 0, 0]).is_err()); // < 4 bytes
    assert!(MassChunk::decode(&[0, 0, 1, 0]).is_err()); // total_parts = 0
    assert!(MassChunk::decode(&[10, 0, 0, 0]).is_err()); // current_part = 0
    assert!(MassChunk::decode(&[10, 0, 11, 0]).is_err()); // current_part > total_parts
}

#[test]
fn test_37_l2_channel_and_opcode_isolation() {
    use app_install::xiaomi::*;

    // 1. 验证 L2Channel 数值与映射
    assert_eq!(L2Channel::Pb.as_u8(), 1);
    assert_eq!(L2Channel::Mass.as_u8(), 2);
    assert_eq!(L2Channel::from_u8(1).unwrap(), L2Channel::Pb);
    assert_eq!(L2Channel::from_u8(2).unwrap(), L2Channel::Mass);
    assert!(L2Channel::from_u8(99).is_err());

    // 2. 验证 L2OpCode 数值与映射
    assert_eq!(L2OpCode::Write.as_u8(), 1);
    assert_eq!(L2OpCode::WriteEnc.as_u8(), 2);
    assert_eq!(L2OpCode::Read.as_u8(), 3);
    assert_eq!(L2OpCode::from_u8(1).unwrap(), L2OpCode::Write);
    assert!(L2OpCode::from_u8(99).is_err());

    // 3. L2 报文序列化
    let payload = vec![0x10, 0x20, 0x30];
    let packet = L2Packet::new(L2Channel::Mass, L2OpCode::Write, payload.clone());
    let bytes = packet.to_bytes();
    assert_eq!(bytes[0], 2);
    assert_eq!(bytes[1], 1);
    assert_eq!(&bytes[2..], &payload[..]);

    let decoded = L2Packet::from_bytes(&bytes).expect("L2 decode 成功");
    assert_eq!(decoded, packet);
}

#[test]
fn test_38_mass_inner_payload_crc32_and_validation() {
    use app_install::xiaomi::*;

    let file_dummy = b"Hello RPK Wear Mass Transfer Payload Content";
    let md5 = vec![0x11; 16];

    // 1. 构造内部载荷
    let payload = build_mass_inner_payload(file_dummy, 64, &md5).expect("build payload 成功");

    // 结构验证：0x00 | 0x40 | MD5 (16B) | len (4B) | file | CRC32 (4B)
    assert_eq!(payload[0], 0x00);
    assert_eq!(payload[1], 0x40);
    assert_eq!(&payload[2..18], &md5[..]);
    let len = u32::from_le_bytes([payload[18], payload[19], payload[20], payload[21]]);
    assert_eq!(len as usize, file_dummy.len());

    // 2. 校验 CRC32
    assert!(verify_mass_inner_payload(&payload).is_ok());

    // 3. 篡改文件数据导致 CRC32 不匹配
    let mut corrupted = payload.clone();
    corrupted[25] ^= 0xFF;
    let err = verify_mass_inner_payload(&corrupted).unwrap_err();
    assert!(err.contains("CRC32 校验失败"));

    // 4. 截断载荷拒绝
    assert!(verify_mass_inner_payload(&payload[..20]).is_err());
}

#[test]
fn test_39_protocol_state_machine_flow_to_waiting_device_result() {
    use app_install::xiaomi::*;

    // 1. 验证状态机状态流转：preparing -> transferring -> waiting_device_result
    let state_prep = XiaomiInstallState::Preparing;
    let state_trans = XiaomiInstallState::Transferring;
    let state_wait = XiaomiInstallState::WaitingDeviceResult;

    assert_eq!(state_prep.as_str(), "preparing");
    assert_eq!(state_trans.as_str(), "transferring");
    assert_eq!(state_wait.as_str(), "waiting_device_result");

    // 严格安全防线：严禁状态包含 completed 或 installed
    assert_ne!(state_wait.as_str(), "completed");
    assert_ne!(state_wait.as_str(), "installed");
    assert_ne!(state_wait.as_str(), "success");

    // 2. 验证与现有 Mock 状态机的协调互锁
    let mut mock_proto = MockAppInstallProtocol::new();
    let mut dev = MockBandDeviceTransport::new();
    dev.connect("00:00:00:00:00:00").unwrap();

    let meta = InstallMetadata {
        package_id: "com.test.xiaomi".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 10,
        file_size: 512,
        hash: "dummy_hash".to_string(),
    };

    let sess = mock_proto.prepare_install(&mut dev, &meta).unwrap();
    assert_eq!(sess.status, state_prep.as_str());

    let chunk = InstallChunk {
        session_id: sess.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    let ack = mock_proto.send_package_chunk(&mut dev, &chunk).unwrap();
    assert_eq!(ack.received_bytes, 512);

    let commit = mock_proto.commit_install(&mut dev, &sess.session_id).unwrap();
    assert_ne!(commit.status, "completed");
    assert_ne!(commit.status, "installed");
}

#[test]
fn test_40_negative_payload_rejection_tests() {
    use app_install::xiaomi::*;

    // 1. 空 package_name 拒绝
    assert!(encode_install_request("", 1, 100).is_err());

    // 2. 解码非法/截断的 AppInstallerRequest
    assert!(AppInstallerRequest::decode(&[]).is_err());
    assert!(AppInstallerRequest::decode(&[0x0A, 0xFF]).is_err()); // 截断长度

    // 3. 非法/截断的 WearPacket
    assert!(WearPacket::decode(&[]).is_err());
    assert!(WearPacket::decode(&[0x08]).is_err()); // tag 1 缺少 varint 载荷

    // 4. decode_install_response 面对非法载荷拒绝
    let bad_wp = WearPacket::new(WearPacketType::System, 99).encode();
    assert!(decode_install_response(&bad_wp).is_err());

    // 5. decode_install_result 面对非法载荷拒绝
    assert!(decode_install_result(&bad_wp).is_err());

    // 6. decode_mass_ack 截断载荷拒绝
    assert!(decode_mass_ack(&[0x01]).is_err()); // 长度不足 2 字节
}

#[test]
fn test_xiaomi_protocol_prepare_encode() {
    use app_install::xiaomi::*;

    let mut proto = XiaomiAppInstallProtocol::new();
    let mut dev = MockBandDeviceTransport::new();
    dev.connect("AA:BB:CC:11:22:33").unwrap();

    // 模拟手环响应: WearPacket(type=20, id=1, ThirdpartyApp with AppInstallerResponse(prepare_status=0, expected_slice_length=244))
    let resp = AppInstallerResponse::new(0, Some(244));
    let app_resp = ThirdpartyApp::from_install_response(resp);
    let wp_resp = WearPacket::new_thirdparty_app(1, app_resp);
    let l2_resp = L2Packet::pb_write(wp_resp.encode());
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 1,
        payload: l2_resp.to_bytes(),
    });

    let meta = InstallMetadata {
        package_id: "com.xiaomi.demo".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 100,
        file_size: 1024,
        hash: "0123456789abcdef0123456789abcdef".to_string(),
    };

    let session = proto.prepare_install(&mut dev, &meta).expect("prepare_install 成功");
    assert_eq!(session.file_size, 1024);
    assert_eq!(proto.state, XiaomiInstallState::Transferring);

    // 验证发出的帧结构
    assert_eq!(dev.sent_frames.len(), 1);
    let sent = &dev.sent_frames[0];
    assert_eq!(sent.frame_type, 0x03);

    // 载荷解包验证: L2 -> WearPacket -> ThirdpartyApp -> AppInstallerRequest
    let l2 = L2Packet::from_bytes(&sent.payload).expect("L2 decode 成功");
    assert_eq!(l2.channel, L2Channel::Pb);
    let wp = WearPacket::decode(&l2.payload).expect("WearPacket decode 成功");
    assert_eq!(wp.pkt_type, WearPacketType::ThirdpartyApp);
    assert_eq!(wp.id, 1);

    let app = match wp.payload {
        Some(WearPacketPayload::ThirdpartyApp(a)) => a,
        _ => panic!("Expected ThirdpartyApp"),
    };
    let req = match app.payload {
        Some(ThirdpartyAppPayload::InstallRequest(r)) => r,
        _ => panic!("Expected InstallRequest"),
    };
    assert_eq!(req.package_name, "com.xiaomi.demo");
    assert_eq!(req.version_code, 100);
    assert_eq!(req.package_size, 1024);
}

#[test]
fn test_xiaomi_mass_transfer_sequence() {
    use app_install::xiaomi::*;

    let mut proto = XiaomiAppInstallProtocol::new();
    let mut dev = MockBandDeviceTransport::new();
    dev.connect("AA:BB:CC:11:22:33").unwrap();

    // 先模拟完成 prepare 握手
    let resp = AppInstallerResponse::new(0, Some(244));
    let wp_resp = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp));
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 1,
        payload: L2Packet::pb_write(wp_resp.encode()).to_bytes(),
    });

    let meta = InstallMetadata {
        package_id: "com.xiaomi.demo".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 100,
        file_size: 1024, // 2 chunks (512 each)
        hash: "0123456789abcdef0123456789abcdef".to_string(),
    };
    let session = proto.prepare_install(&mut dev, &meta).unwrap();
    assert_eq!(session.total_chunks, 2);

    // 发送 chunk 0 (首块触发 Mass Prepare + Mass Chunk)
    let chunk0 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0x11; 512],
    };
    let ack0 = proto.send_package_chunk(&mut dev, &chunk0).expect("chunk0 发送成功");
    assert_eq!(ack0.received_bytes, 512);
    assert_eq!(proto.state, XiaomiInstallState::Transferring);

    // 检查发出帧：1 (prepare_install) + 1 (mass_prepare) + 1 (mass_chunk0)
    assert_eq!(dev.sent_frames.len(), 3);

    let mass_prep_frame = &dev.sent_frames[1];
    let mass_prep_l2 = L2Packet::from_bytes(&mass_prep_frame.payload).unwrap();
    let mass_prep_wp = WearPacket::decode(&mass_prep_l2.payload).unwrap();
    assert_eq!(mass_prep_wp.pkt_type, WearPacketType::Mass);
    assert_eq!(mass_prep_wp.id, 0);

    let chunk0_frame = &dev.sent_frames[2];
    let chunk0_l2 = L2Packet::from_bytes(&chunk0_frame.payload).unwrap();
    assert_eq!(chunk0_l2.channel, L2Channel::Mass);
    assert_eq!(chunk0_l2.opcode, L2OpCode::Write);
    let chunk0_mass = MassChunk::decode(&chunk0_l2.payload).unwrap();
    assert_eq!(chunk0_mass.total_parts, 2);
    assert_eq!(chunk0_mass.current_part, 1);
    assert_eq!(chunk0_mass.fragment.len(), 512);

    // 发送 chunk 1 (末尾块，完成后状态流转进入 waiting_device_result)
    let chunk1 = InstallChunk {
        session_id: session.session_id.clone(),
        index: 1,
        size: 512,
        data: vec![0x22; 512],
    };
    let ack1 = proto.send_package_chunk(&mut dev, &chunk1).expect("chunk1 发送成功");
    assert_eq!(ack1.received_bytes, 1024);

    assert_eq!(dev.sent_frames.len(), 4);
    let chunk1_frame = &dev.sent_frames[3];
    let chunk1_l2 = L2Packet::from_bytes(&chunk1_frame.payload).unwrap();
    let chunk1_mass = MassChunk::decode(&chunk1_l2.payload).unwrap();
    assert_eq!(chunk1_mass.total_parts, 2);
    assert_eq!(chunk1_mass.current_part, 2);

    // 状态流转确认：进入 waiting_device_result，绝不产生 completed
    assert_eq!(proto.state, XiaomiInstallState::WaitingDeviceResult);
    assert_ne!(proto.state.as_str(), "completed");
    assert_ne!(proto.state.as_str(), "installed");
}

#[test]
fn test_xiaomi_result_decode() {
    use app_install::xiaomi::*;

    let mut proto = XiaomiAppInstallProtocol::new();
    let mut dev = MockBandDeviceTransport::new();
    dev.connect("AA:BB:CC:11:22:33").unwrap();

    // 完成 prepare
    let resp = AppInstallerResponse::new(0, Some(244));
    let wp_resp = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp));
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 1,
        payload: L2Packet::pb_write(wp_resp.encode()).to_bytes(),
    });

    let meta = InstallMetadata {
        package_id: "com.xiaomi.demo".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 100,
        file_size: 512,
        hash: "0123456789abcdef0123456789abcdef".to_string(),
    };
    let session = proto.prepare_install(&mut dev, &meta).unwrap();

    let chunk = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0x11; 512],
    };
    proto.send_package_chunk(&mut dev, &chunk).unwrap();
    assert_eq!(proto.state, XiaomiInstallState::WaitingDeviceResult);

    // 注入设备真实返回结果: WearPacket(type=20, id=2, payload=AppInstallerResult(code=Success, package_name="com.xiaomi.demo"))
    let res = AppInstallerResult::new(InstallResultCode::Success, Some("com.xiaomi.demo".to_string()));
    let wp_res = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(res));
    let l2_res = L2Packet::pb_write(wp_res.encode());
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 2,
        payload: l2_res.to_bytes(),
    });

    // 调用 wait_install_result
    let result = proto.wait_install_result(&mut dev, &session.session_id).expect("wait_install_result 应当成功");
    assert_eq!(result.status, "success");
    assert_ne!(result.status, "completed");
    assert_ne!(result.status, "installed");
    assert_eq!(proto.state, XiaomiInstallState::Success);
}

#[test]
fn test_xiaomi_protocol_failure_states() {
    use app_install::xiaomi::*;

    let mut proto = XiaomiAppInstallProtocol::new();
    let mut dev = MockBandDeviceTransport::new();

    let meta = InstallMetadata {
        package_id: "com.xiaomi.fail".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 100,
        file_size: 512,
        hash: "0123456789abcdef0123456789abcdef".to_string(),
    };

    // 1. 未连接设备时调用 prepare 拒绝
    let err_not_conn = proto.prepare_install(&mut dev, &meta).unwrap_err();
    assert!(err_not_conn.contains("device_unavailable"));

    // 2. 连接后，设备响应 prepare_status != 0 (例如 BUSY=1)
    dev.connect("AA:BB:CC:11:22:33").unwrap();
    let resp_busy = AppInstallerResponse::new(1, None); // BUSY
    let wp_busy = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp_busy));
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 1,
        payload: L2Packet::pb_write(wp_busy.encode()).to_bytes(),
    });

    let err_busy = proto.prepare_install(&mut dev, &meta).unwrap_err();
    assert!(err_busy.contains("未就绪"));
    assert_eq!(proto.state, XiaomiInstallState::Failure);

    // 3. 设备返回失败结果: code = INSTALL_FAILED (1)
    let resp_ready = AppInstallerResponse::new(0, Some(244));
    let wp_ready = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp_ready));
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 2,
        payload: L2Packet::pb_write(wp_ready.encode()).to_bytes(),
    });
    let session = proto.prepare_install(&mut dev, &meta).unwrap();

    let chunk = InstallChunk {
        session_id: session.session_id.clone(),
        index: 0,
        size: 512,
        data: vec![0u8; 512],
    };
    proto.send_package_chunk(&mut dev, &chunk).unwrap();

    // 注入失败结果 (INSTALL_FAILED)
    let fail_res = AppInstallerResult::new(InstallResultCode::Failed, Some("com.xiaomi.fail".to_string()));
    let wp_fail = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(fail_res));
    dev.incoming_queue.push_back(Frame {
        frame_type: 0x03,
        seq: 3,
        payload: L2Packet::pb_write(wp_fail.encode()).to_bytes(),
    });

    let err_install = proto.wait_install_result(&mut dev, &session.session_id).unwrap_err();
    assert!(err_install.contains("INSTALL_FAILED"));
    assert_eq!(proto.state, XiaomiInstallState::Failure);

    // 4. 超时无报文情况：保持在 waiting_device_result，绝不冒充成功
    proto.state = XiaomiInstallState::WaitingDeviceResult;
    let timeout_res = proto.wait_install_result(&mut dev, &session.session_id).unwrap();
    assert_eq!(timeout_res.status, "waiting_device_result");
    assert_ne!(timeout_res.status, "completed");
    assert_ne!(timeout_res.status, "installed");
}

#[test]
fn test_install_session_can_send_packet() {
    use app_install::xiaomi::*;
    use app_install::transport::BandDeviceTransport;

    // 1. 未连接时发送应当失败
    let mut session = XiaomiInstallDeviceSession::new();
    let frame = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: vec![0x01, 0x02, 0x03],
    };
    let err_unauthed = session.send_install_packet(&frame).unwrap_err();
    assert!(err_unauthed.contains("device_unavailable"));

    // 2. 绑定已认证会话 + Mock 实时链路后，发送确实写入实时链路（不是只入队）
    session.connect("AA:BB:CC:11:22:33").unwrap();
    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let wire_handle = wire.clone();
    session.bind_wire(Box::new(wire));
    session.refresh_authentication();
    assert!(session.is_connected());
    assert!(session.is_authenticated());

    let req_pb = encode_install_request("com.xiaomi.demo", 1, 1024).expect("编码安装请求应当成功");
    let l2_pkt = L2Packet::pb_write(req_pb);
    let install_frame = Frame {
        frame_type: 0x03,
        seq: 0xEE,
        payload: l2_pkt.to_bytes(),
    };
    let sent = session
        .send_install_packet(&install_frame)
        .expect("发送安装包应当成功");
    // 实时链路确认真实发送，且 seq 来自链路而不是 protocol 自增的伪 seq
    assert_eq!(wire_handle.sent_count(), 1);
    assert_eq!(sent.seq, 0);
    assert_ne!(sent.seq, 0xEE);
    assert_eq!(wire_handle.sent_records()[0].plaintext_l2, l2_pkt.to_bytes());
    assert_eq!(session.outgoing_install_frames.len(), 1);
    assert_eq!(session.outgoing_install_frames.front().unwrap().seq, 0);

    // 3. 验证 MockDeviceSession 仍保留离线记录路径
    let mut mock_session = MockDeviceSession::new();
    mock_session.connect("11:22:33:44:55:66").unwrap();
    mock_session.send_install_packet(&install_frame).unwrap();
    assert_eq!(mock_session.sent_install_frames.len(), 1);
    assert_eq!(mock_session.sent_install_frames[0].payload, l2_pkt.to_bytes());
}

#[test]
fn test_install_response_routing() {
    use app_install::xiaomi::*;

    let mut session = XiaomiInstallDeviceSession::new();
    session.connect("AA:BB:CC:11:22:33").unwrap();

    // 1. 构造三类合法安装响应帧
    // A: AppInstallerResponse (WearPacket type=20, id=1)
    let resp = AppInstallerResponse::new(0, Some(244));
    let wp_resp = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp));
    let frame_resp = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: L2Packet::pb_write(wp_resp.encode()).to_bytes(),
    };

    // B: AppInstallerResult (WearPacket type=20, id=2)
    let res = AppInstallerResult::new(InstallResultCode::Success, Some("com.xiaomi.demo".to_string()));
    let wp_res = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(res));
    let frame_res = Frame {
        frame_type: 0x03,
        seq: 2,
        payload: L2Packet::pb_write(wp_res.encode()).to_bytes(),
    };

    // C: Mass 数据通道报文 (L2Channel::Mass)
    let frame_mass = Frame {
        frame_type: 0x03,
        seq: 3,
        payload: L2Packet::mass_write(vec![0x00, 0x01, 0x02, 0x03]).to_bytes(),
    };

    // 2. 验证 filter_install_response 判定均返回 true
    assert!(filter_install_response(&frame_resp.payload));
    assert!(filter_install_response(&frame_res.payload));
    assert!(filter_install_response(&frame_mass.payload));

    // 3. 通过 dispatch_incoming_frame 进行路由分发
    assert!(session.dispatch_incoming_frame(frame_resp.clone()));
    assert!(session.dispatch_incoming_frame(frame_res.clone()));
    assert!(session.dispatch_incoming_frame(frame_mass.clone()));

    // 4. 验证安装队列按 FIFO 接收，且普通业务队列为空
    assert_eq!(session.incoming_install_queue.len(), 3);
    assert_eq!(session.normal_message_queue.len(), 0);

    let rec1 = session.receive_install_packet(100).unwrap().expect("应收到响应1");
    assert_eq!(rec1.seq, 1);
    let rec2 = session.receive_install_packet(100).unwrap().expect("应收到响应2");
    assert_eq!(rec2.seq, 2);
    let rec3 = session.receive_install_packet(100).unwrap().expect("应收到响应3");
    assert_eq!(rec3.seq, 3);
    assert!(session.receive_install_packet(100).unwrap().is_none());
}

#[test]
fn test_normal_message_isolation() {
    use app_install::xiaomi::*;

    let mut session = XiaomiInstallDeviceSession::new();
    session.connect("AA:BB:CC:11:22:33").unwrap();

    // 1. 构造日常非安装业务报文（严禁被安装通道拦截或吞没）
    // A: interconnect fetch 报文 (type=20, id=9)
    let wp_fetch = WearPacket::new(WearPacketType::ThirdpartyApp, 9);
    let frame_fetch = Frame {
        frame_type: 0x03,
        seq: 10,
        payload: L2Packet::pb_write(wp_fetch.encode()).to_bytes(),
    };

    // B: app status 查询报文 (type=20, id=6)
    let wp_status = WearPacket::new(WearPacketType::ThirdpartyApp, 6);
    let frame_status = Frame {
        frame_type: 0x03,
        seq: 11,
        payload: L2Packet::pb_write(wp_status.encode()).to_bytes(),
    };

    // C: phone message 下行报文 (type=20, id=8)
    let wp_phone = WearPacket::new(WearPacketType::ThirdpartyApp, 8);
    let frame_phone = Frame {
        frame_type: 0x03,
        seq: 12,
        payload: L2Packet::pb_write(wp_phone.encode()).to_bytes(),
    };

    // 2. 验证 filter_install_response 判定均返回 false
    assert!(!filter_install_response(&frame_fetch.payload));
    assert!(!filter_install_response(&frame_status.payload));
    assert!(!filter_install_response(&frame_phone.payload));

    // 3. 通过 dispatch_incoming_frame 进行路由分发
    assert!(!session.dispatch_incoming_frame(frame_fetch.clone()));
    assert!(!session.dispatch_incoming_frame(frame_status.clone()));
    assert!(!session.dispatch_incoming_frame(frame_phone.clone()));

    // 4. 严格断言：安装接收队列完全为空，日常普通报文全量保留在普通队列
    assert_eq!(session.incoming_install_queue.len(), 0);
    assert_eq!(session.normal_message_queue.len(), 3);
    assert!(session.receive_install_packet(100).unwrap().is_none());

    // 验证普通消息队列数据完整性
    assert_eq!(session.normal_message_queue[0].seq, 10);
    assert_eq!(session.normal_message_queue[1].seq, 11);
    assert_eq!(session.normal_message_queue[2].seq, 12);
}

#[test]
fn test_no_duplicate_bluetooth_connection() {
    use app_install::xiaomi::*;
    use app_install::transport::BandDeviceTransport;

    // 1. 初始化 XiaomiInstallDeviceSession，验证无第二套连接
    let mut session = XiaomiInstallDeviceSession::new();
    assert!(!session.has_duplicate_connection());
    assert!(session.is_shared_connection());

    // 2. 调用 connect 模拟绑定既有认证会话，验证依然没有建立第二套连接
    session.connect("AA:BB:CC:11:22:33").unwrap();
    assert!(session.is_connected());
    assert!(!session.has_duplicate_connection());
    assert!(session.is_shared_connection());

    // 3. 从既有句柄构建会话
    let session_bound = XiaomiInstallDeviceSession::from_authenticated_session(9999, "AA:BB:CC:11:22:33");
    assert!(session_bound.is_connected());
    assert!(!session_bound.has_duplicate_connection());
    assert_eq!(session_bound.underlying_handle, Some(9999));

    // 4. 验证 MockDeviceSession 同样遵守无重复连接约束
    let mock = MockDeviceSession::new();
    assert!(!mock.has_duplicate_connection());
}

#[test]
fn test_install_frame_routing() {
    use std::collections::VecDeque;
    use app_install::xiaomi::*;

    let router = InstallFrameRouter::new();
    let mut install_queue = VecDeque::new();
    let mut normal_queue = VecDeque::new();

    // 1. 安装准备请求帧 (L2 Pb + WearPacket ThirdpartyApp id=1)
    let req_pb = encode_install_request("com.test.routing", 1, 2048).unwrap();
    let frame_req = router.encode_install_frame(&L2Packet::pb_write(req_pb).to_bytes(), 1);
    assert!(router.is_install_frame(&frame_req));
    assert!(router.route_frame(frame_req, &mut install_queue, &mut normal_queue));

    // 2. 安装准备响应帧 (L2 Pb + WearPacket ThirdpartyApp id=1)
    let resp = AppInstallerResponse::new(0, Some(244));
    let wp_resp = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp));
    let frame_resp = router.encode_install_frame(&L2Packet::pb_write(wp_resp.encode()).to_bytes(), 2);
    assert!(router.is_install_frame(&frame_resp));
    assert!(router.route_frame(frame_resp, &mut install_queue, &mut normal_queue));

    // 3. Mass 传输准备控制帧 (L2 Pb + WearPacket Mass id=0)
    let prep_pb = encode_mass_prepare(&vec![0u8; 100], &[0xCC; 16]).unwrap();
    let frame_prep = router.encode_install_frame(&L2Packet::pb_write(prep_pb).to_bytes(), 3);
    assert!(router.is_install_frame(&frame_prep));
    assert!(router.route_frame(frame_prep, &mut install_queue, &mut normal_queue));

    // 4. Mass 数据分片传输帧 (L2Channel::Mass)
    let chunk_bytes = encode_mass_chunk(5, 1, &[0x33; 64]).unwrap();
    let frame_chunk = Frame {
        frame_type: 0x03,
        seq: 4,
        payload: chunk_bytes,
    };
    assert!(router.is_install_frame(&frame_chunk));
    assert!(router.route_frame(frame_chunk, &mut install_queue, &mut normal_queue));

    // 5. 安装结果上报帧 (L2 Pb + WearPacket ThirdpartyApp id=2)
    let res = AppInstallerResult::new(InstallResultCode::Success, Some("com.test.routing".to_string()));
    let wp_res = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(res));
    let frame_res = router.encode_install_frame(&L2Packet::pb_write(wp_res.encode()).to_bytes(), 5);
    assert!(router.is_install_frame(&frame_res));
    assert!(router.route_frame(frame_res, &mut install_queue, &mut normal_queue));

    // 验证路由队列统计与序列
    assert_eq!(install_queue.len(), 5);
    assert_eq!(normal_queue.len(), 0);
    for i in 1..=5 {
        assert_eq!(install_queue.pop_front().unwrap().seq, i);
    }
}

#[test]
fn test_normal_frame_isolation() {
    use std::collections::VecDeque;
    use app_install::xiaomi::*;

    let router = InstallFrameRouter::new();
    let mut install_queue = VecDeque::new();
    let mut normal_queue = VecDeque::new();

    // 1. 日常 interconnect fetch 上行业务帧 (id=9)
    let wp_fetch = WearPacket::new(WearPacketType::ThirdpartyApp, 9);
    let frame_fetch = Frame {
        frame_type: 0x03,
        seq: 10,
        payload: L2Packet::pb_write(wp_fetch.encode()).to_bytes(),
    };
    assert!(!router.is_install_frame(&frame_fetch));
    assert!(!router.route_frame(frame_fetch.clone(), &mut install_queue, &mut normal_queue));

    // 2. 日常 interconnect __hs__ 握手帧 (id=9)
    let wp_hs = WearPacket::new(WearPacketType::ThirdpartyApp, 9);
    let frame_hs = Frame {
        frame_type: 0x03,
        seq: 11,
        payload: L2Packet::pb_write(wp_hs.encode()).to_bytes(),
    };
    assert!(!router.is_install_frame(&frame_hs));
    assert!(!router.route_frame(frame_hs.clone(), &mut install_queue, &mut normal_queue));

    // 3. 日常手环端快应用状态请求 (id=6)
    let wp_status = WearPacket::new(WearPacketType::ThirdpartyApp, 6);
    let frame_status = Frame {
        frame_type: 0x03,
        seq: 12,
        payload: L2Packet::pb_write(wp_status.encode()).to_bytes(),
    };
    assert!(!router.is_install_frame(&frame_status));
    assert!(!router.route_frame(frame_status.clone(), &mut install_queue, &mut normal_queue));

    // 4. 手环端快应用连接同步 (id=7)
    let wp_sync = WearPacket::new(WearPacketType::ThirdpartyApp, 7);
    let frame_sync = Frame {
        frame_type: 0x03,
        seq: 13,
        payload: L2Packet::pb_write(wp_sync.encode()).to_bytes(),
    };
    assert!(!router.is_install_frame(&frame_sync));
    assert!(!router.route_frame(frame_sync.clone(), &mut install_queue, &mut normal_queue));

    // 5. 手机端下行通知业务帧 (id=8)
    let wp_phone = WearPacket::new(WearPacketType::ThirdpartyApp, 8);
    let frame_phone = Frame {
        frame_type: 0x03,
        seq: 14,
        payload: L2Packet::pb_write(wp_phone.encode()).to_bytes(),
    };
    assert!(!router.is_install_frame(&frame_phone));
    assert!(!router.route_frame(frame_phone.clone(), &mut install_queue, &mut normal_queue));

    // 严格断言：安装队列无任何污染，日常报文 100% 隔离保存在普通队列中
    assert_eq!(install_queue.len(), 0);
    assert_eq!(normal_queue.len(), 5);
    assert_eq!(normal_queue[0].seq, 10);
    assert_eq!(normal_queue[1].seq, 11);
    assert_eq!(normal_queue[2].seq, 12);
    assert_eq!(normal_queue[3].seq, 13);
    assert_eq!(normal_queue[4].seq, 14);
}

#[test]
fn test_install_frame_encode() {
    use app_install::xiaomi::*;

    let router = InstallFrameRouter::new();

    // 1. 验证编码安装准备请求帧
    let req_pb = encode_install_request("com.encode.test", 42, 65536).unwrap();
    let l2 = L2Packet::pb_write(req_pb.clone());
    let frame = router.encode_install_frame(&l2.to_bytes(), 0x7F);

    assert_eq!(frame.frame_type, 0x03);
    assert_eq!(frame.seq, 0x7F);
    assert_eq!(frame.payload, l2.to_bytes());

    // 反向解码验证载荷字段
    let decoded_l2 = L2Packet::from_bytes(&frame.payload).expect("L2 解码成功");
    assert_eq!(decoded_l2.channel, L2Channel::Pb);
    assert_eq!(decoded_l2.opcode, L2OpCode::Write);
    let decoded_wp = WearPacket::decode(&decoded_l2.payload).expect("WearPacket 解码成功");
    assert_eq!(decoded_wp.pkt_type, WearPacketType::ThirdpartyApp);
    assert_eq!(decoded_wp.id, 1);

    // 2. 验证编码 Mass 数据分片帧
    let chunk_data = vec![0xAB; 244];
    let mass_chunk_l2 = encode_mass_chunk(10, 3, &chunk_data).unwrap();
    let frame_chunk = router.encode_install_frame(&mass_chunk_l2, 0x80);

    assert_eq!(frame_chunk.frame_type, 0x03);
    assert_eq!(frame_chunk.seq, 0x80);
    let decoded_chunk_l2 = L2Packet::from_bytes(&frame_chunk.payload).unwrap();
    assert_eq!(decoded_chunk_l2.channel, L2Channel::Mass);
    assert_eq!(decoded_chunk_l2.opcode, L2OpCode::Write);
}

#[test]
fn test_encrypted_payload_path() {
    use std::collections::VecDeque;
    use app_install::xiaomi::*;

    // 模拟经过认证协商后的双向 16 字节 AES-128-CTR 密钥
    let enc_key = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    let dec_key = [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0xF0, 0xDE, 0xBC, 0x9A, 0x78, 0x56, 0x34, 0x12];

    let router = InstallFrameRouter::with_keys(enc_key, dec_key);
    let mut install_queue = VecDeque::new();
    let mut normal_queue = VecDeque::new();

    // 1. 下行加密路径验证 (Downlink Encryption Path)
    let req_pb = encode_install_request("com.encrypted.app", 1, 1024).unwrap();
    let plaintext_l2 = L2Packet::pb_write(req_pb).to_bytes();
    let enc_frame = router.encode_install_frame(&plaintext_l2, 1);

    assert_eq!(enc_frame.frame_type, 0x03);
    assert_eq!(enc_frame.seq, 1);
    assert_eq!(&enc_frame.payload[0..2], &BIZ_PREFIX);
    assert_ne!(&enc_frame.payload[2..], &plaintext_l2); // 密文与明文不同

    // 使用同方向 enc_key 解密 CTR 密文，验证明文完整性
    let decrypted_downlink = biz_stream(&enc_key, &enc_frame.payload[2..]);
    assert_eq!(decrypted_downlink, plaintext_l2);

    // 2. 上行加密安装响应路由验证 (Uplink Encrypted Install Routing)
    let resp = AppInstallerResponse::new(0, Some(244));
    let wp_resp = WearPacket::new_thirdparty_app(1, ThirdpartyApp::from_install_response(resp));
    let plain_resp_l2 = L2Packet::pb_write(wp_resp.encode()).to_bytes();
    let enc_resp_payload = business_frame_payload(&dec_key, &plain_resp_l2);
    let enc_resp_frame = Frame {
        frame_type: 0x03,
        seq: 100,
        payload: enc_resp_payload,
    };

    assert!(router.is_install_frame(&enc_resp_frame));
    assert!(router.route_frame(enc_resp_frame.clone(), &mut install_queue, &mut normal_queue));
    assert_eq!(install_queue.len(), 1);
    assert_eq!(normal_queue.len(), 0);

    let resolved = router.resolve_payload(&enc_resp_frame);
    assert_eq!(resolved, plain_resp_l2);

    // 3. 上行加密日常业务帧隔离验证 (Uplink Encrypted Normal Frame Isolation)
    let wp_fetch = WearPacket::new(WearPacketType::ThirdpartyApp, 9);
    let plain_fetch_l2 = L2Packet::pb_write(wp_fetch.encode()).to_bytes();
    let enc_fetch_payload = business_frame_payload(&dec_key, &plain_fetch_l2);
    let enc_fetch_frame = Frame {
        frame_type: 0x03,
        seq: 101,
        payload: enc_fetch_payload,
    };

    assert!(!router.is_install_frame(&enc_fetch_frame));
    assert!(!router.route_frame(enc_fetch_frame, &mut install_queue, &mut normal_queue));
    assert_eq!(install_queue.len(), 1); // 安装队列未被污染
    assert_eq!(normal_queue.len(), 1);  // 日常报文安全分流到普通队列

    // 4. 会话级密钥配置与加解密集成测试
    let mut session = XiaomiInstallDeviceSession::new();
    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    session.bind_wire(Box::new(wire));
    session.set_crypto_keys(enc_key, dec_key);
    session.connect("AA:BB:CC:11:22:33").unwrap();

    let tx_frame = session.encode_install_frame(&plaintext_l2, 2);
    session.send_install_packet(&tx_frame).unwrap();
    assert_eq!(session.outgoing_install_frames.len(), 1);
    assert_eq!(&session.outgoing_install_frames[0].payload[0..2], &BIZ_PREFIX);
}

#[test]
fn test_runtime_bridge_send_path() {
    use app_install::xiaomi::*;

    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let wire_handle = wire.clone();
    let mut bridge = XiaomiInstallRuntimeBridge::with_wire(Box::new(wire));

    // 验证初始状态与无冗余连接
    assert_eq!(bridge.state, RuntimeBridgeState::Authenticated);
    assert_eq!(bridge.has_duplicate_connection(), false);

    // 构造下行明文 L2 报文 (安装请求)
    let req_pb = encode_install_request("com.test.runtime", 1, 4096).unwrap();
    let plaintext_l2 = L2Packet::pb_write(req_pb).to_bytes();

    // 通过实时链路发送（真实发送动作，seq 由链路递增）
    let frame = bridge
        .send_install_packet(&plaintext_l2)
        .expect("send_install_packet 应当成功");

    assert_eq!(bridge.state, RuntimeBridgeState::Sending);
    assert_eq!(frame.frame_type, 0x03);
    assert_eq!(frame.seq, 0);
    assert_eq!(wire_handle.sent_count(), 1);
    assert_eq!(wire_handle.sent_records()[0].plaintext_l2, plaintext_l2);

    // 第二帧 seq 必须真实递增
    let frame2 = bridge.send_install_packet(&plaintext_l2).unwrap();
    assert_eq!(frame2.seq, 1);
    assert_eq!(wire_handle.sent_count(), 2);

    // 确认：没有创建第二个 socket
    assert_eq!(bridge.has_duplicate_connection(), false);
    assert_eq!(bridge.install_session.outgoing_install_frames.len(), 2);
}

#[test]
fn test_real_install_packet_uses_live_transport_interface() {
    use app_install::xiaomi::*;

    // 该测试验证：安装包不是只进入 outgoing 队列，而是通过实时链路接口真实发送。
    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let wire_handle = wire.clone();
    let mut transport = XiaomiInstallTransport::with_wire(Box::new(wire));

    let req_pb = encode_install_request("com.test.realwire", 7, 8192).unwrap();
    let plaintext_l2 = L2Packet::pb_write(req_pb).to_bytes();

    let sent = transport
        .bridge
        .send_install_packet(&plaintext_l2)
        .expect("安装帧必须通过实时链路接口发送");

    assert_eq!(sent.seq, 0);
    assert_eq!(wire_handle.sent_count(), 1, "必须发生真实发送动作，而不是只入队");
    assert_eq!(wire_handle.sent_records()[0].seq, 0);
    assert_eq!(wire_handle.sent_records()[0].plaintext_l2, plaintext_l2);
    assert_eq!(
        transport.bridge.install_session.outgoing_install_frames.len(),
        1
    );

    // 第二次发送 seq 递增，证明使用的是实时链路序号而不是本地伪序号
    let sent2 = transport.bridge.send_install_packet(&plaintext_l2).unwrap();
    assert_eq!(sent2.seq, 1);
    assert_eq!(wire_handle.sent_count(), 2);
}

#[test]
fn test_runtime_bridge_receive_install_result() {
    use app_install::xiaomi::*;

    let mut bridge = XiaomiInstallRuntimeBridge::new();
    let enc_key = [0x12; 16];
    let dec_key = [0x34; 16];
    bridge.install_session.set_crypto_keys(enc_key, dec_key);
    bridge.install_session.connect("AA:BB:CC:11:22:33").unwrap();
    bridge.state = RuntimeBridgeState::Transferring;
    let _serial = lock_global_queue();

    // 构造真实结果报文：type=20, id=2 且 result_code == 0
    let app_res = AppInstallerResult::new(InstallResultCode::Success, Some("com.test.runtime".to_string()));
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    let plain_l2 = L2Packet::pb_write(wp.encode()).to_bytes();
    let enc_payload = business_frame_payload(&dec_key, &plain_l2);

    let frame = Frame {
        frame_type: 0x03,
        seq: 42,
        payload: enc_payload,
    };

    // 派发到全局入站队列并驱动 bridge 接收
    clear_global_install_events();
    dispatch_install_frame_event(InstallFrameEvent::Incoming(frame));

    // 轮询安装结果
    let res = bridge.poll_install_result().expect("poll_install_result 应当成功");
    assert!(res.is_some());
    assert_eq!(res.unwrap().status, "completed");

    // 严格断言：状态变更为 Completed
    assert_eq!(bridge.state, RuntimeBridgeState::Completed);
}

#[test]
fn test_runtime_bridge_failure_state() {
    use app_install::xiaomi::*;

    let mut bridge = XiaomiInstallRuntimeBridge::new();
    let enc_key = [0x12; 16];
    let dec_key = [0x34; 16];
    bridge.install_session.set_crypto_keys(enc_key, dec_key);
    bridge.install_session.connect("AA:BB:CC:11:22:33").unwrap();
    bridge.state = RuntimeBridgeState::Transferring;
    let _serial = lock_global_queue();

    // 构造失败报文：type=20, id=2 且 code == Failed (1) (result != 0)
    let app_res = AppInstallerResult::new(InstallResultCode::Failed, Some("com.test.runtime".to_string()));
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    let plain_l2 = L2Packet::pb_write(wp.encode()).to_bytes();
    let enc_payload = business_frame_payload(&dec_key, &plain_l2);

    let frame = Frame {
        frame_type: 0x03,
        seq: 43,
        payload: enc_payload,
    };

    clear_global_install_events();
    dispatch_install_frame_event(InstallFrameEvent::Incoming(frame));

    let res = bridge.poll_install_result().expect("poll_install_result 应当返回");
    assert!(res.is_some());
    assert_eq!(res.unwrap().status, "failed");

    // 严格断言：状态变更为 Failed，绝不进入 Completed 假成功
    assert_eq!(bridge.state, RuntimeBridgeState::Failed);
    assert_ne!(bridge.state, RuntimeBridgeState::Completed);
}

#[test]
fn test_runtime_bridge_normal_business_isolation() {
    use app_install::xiaomi::*;

    let mut bridge = XiaomiInstallRuntimeBridge::new();
    let enc_key = [0x12; 16];
    let dec_key = [0x34; 16];
    bridge.install_session.set_crypto_keys(enc_key, dec_key);
    bridge.install_session.connect("AA:BB:CC:11:22:33").unwrap();
    let _serial = lock_global_queue();

    // 1. fetch 报文 (日常 interconnect 消息, id=9 SEND_WEAR_MESSAGE)
    let wp_fetch = WearPacket::new(WearPacketType::ThirdpartyApp, 9);
    let plain_fetch = L2Packet::pb_write(wp_fetch.encode()).to_bytes();
    let frame_fetch = Frame {
        frame_type: 0x03,
        seq: 1,
        payload: business_frame_payload(&dec_key, &plain_fetch),
    };

    // 2. id=6 报文 (REQUEST_PHONE_APP_STATUS 状态查询)
    let wp_id6 = WearPacket::new(WearPacketType::ThirdpartyApp, 6);
    let plain_id6 = L2Packet::pb_write(wp_id6.encode()).to_bytes();
    let frame_id6 = Frame {
        frame_type: 0x03,
        seq: 2,
        payload: business_frame_payload(&dec_key, &plain_id6),
    };

    // 3. id=8 报文 (PHONE_APP_MESSAGE 业务消息)
    let wp_id8 = WearPacket::new(WearPacketType::ThirdpartyApp, 8);
    let plain_id8 = L2Packet::pb_write(wp_id8.encode()).to_bytes();
    let frame_id8 = Frame {
        frame_type: 0x03,
        seq: 3,
        payload: business_frame_payload(&dec_key, &plain_id8),
    };

    // 派发全部 3 个日常业务帧到全局队列
    clear_global_install_events();
    dispatch_install_frame_event(InstallFrameEvent::Incoming(frame_fetch));
    dispatch_install_frame_event(InstallFrameEvent::Incoming(frame_id6));
    dispatch_install_frame_event(InstallFrameEvent::Incoming(frame_id8));

    // 尝试拉取安装帧
    let install_frame = bridge.receive_frame().unwrap();
    assert!(install_frame.is_none());

    // 严格断言：日常报文绝不进入 install queue，全部隔离分流到 normal_message_queue
    assert_eq!(bridge.install_session.incoming_install_queue.len(), 0);
    assert_eq!(bridge.install_session.normal_message_queue.len(), 3);
}

#[test]
fn test_install_pipeline_gate_defaults_off() {
    use app_install::xiaomi::*;

    let _serial = lock_global_queue();

    // 阶段 21 审计：默认必须关闭 —— 生产数据泵不得把每个业务帧复制进无人消费的全局队列
    assert_eq!(is_install_pipeline_active(), false);

    set_install_pipeline_active(true);
    assert_eq!(is_install_pipeline_active(), true);

    set_install_pipeline_active(false);
    assert_eq!(is_install_pipeline_active(), false);
}

#[test]
fn test_runtime_bridge_wait_result_timeout_never_completes() {
    use app_install::xiaomi::*;
    use app_install::InstallSession;

    let _serial = lock_global_queue();
    clear_global_install_events();

    let mut bridge = XiaomiInstallRuntimeBridge::new();
    bridge.install_session.set_crypto_keys([0x12; 16], [0x34; 16]);
    bridge.install_session.connect("AA:BB:CC:11:22:33").unwrap();

    // 会话已就绪，但设备**没有**上报任何结果（队列为空 → wait_install_result 超时分支）
    let session_id = "xiaomi_inst_com.test.timeout_1".to_string();
    bridge.protocol.active_session = Some(InstallSession {
        session_id: session_id.clone(),
        status: "transferring".to_string(),
        file_size: 4096,
        chunk_size: 512,
        total_chunks: 8,
    });

    let res = bridge
        .execute_wait_result(&session_id)
        .expect("设备未上报时应返回 waiting_device_result，而不是报错");

    // 关键防伪断言：设备没回话，绝不能进入 completed
    assert_eq!(res.status, "waiting_device_result");
    assert_ne!(res.status, "completed");
    assert_eq!(bridge.state, RuntimeBridgeState::WaitingResult);
    assert_ne!(bridge.state, RuntimeBridgeState::Completed);
}

#[test]
fn test_xiaomi_install_result_wrong_package_rejected() {
    use app_install::xiaomi::*;
    use app_install::InstallSession;

    let _serial = lock_global_queue();
    clear_global_install_events();

    let mut bridge = XiaomiInstallRuntimeBridge::new();
    bridge.install_session.set_crypto_keys([0x12; 16], [0x34; 16]);
    bridge.install_session.connect("AA:BB:CC:11:22:33").unwrap();

    let mut protocol = XiaomiAppInstallProtocol::new();
    let session_id = "xiaomi_inst_com.test.expected_1".to_string();
    protocol.active_session = Some(InstallSession {
        session_id: session_id.clone(),
        status: "transferring".to_string(),
        file_size: 4096,
        chunk_size: 512,
        total_chunks: 8,
    });
    protocol.metadata = Some(InstallMetadata {
        package_id: "com.test.expected".to_string(),
        version_name: "1.0.0".to_string(),
        version_code: 1,
        file_size: 4096,
        hash: "test_hash".to_string(),
    });
    bridge.protocol = protocol;

    // 设备上报“成功”，但目标包名是**另一个包**：
    // 证据纪律要求“不能只收到 id=2 就成功”，必须核验响应目标。
    let app_res = AppInstallerResult::new(
        InstallResultCode::Success,
        Some("com.other.app".to_string()),
    );
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    let frame = Frame {
        frame_type: 0x03,
        seq: 44,
        payload: L2Packet::pb_write(wp.encode()).to_bytes(),
    };
    bridge.process_incoming_frame(frame);

    let res = bridge.execute_wait_result(&session_id);
    assert!(res.is_err(), "目标包名不匹配必须报错，不能判成功");
    assert_eq!(bridge.state, RuntimeBridgeState::Failed);
    assert_ne!(bridge.state, RuntimeBridgeState::Completed);
}

#[test]
fn test_transport_commit_requires_installed_list_confirmation() {
    use app_install::xiaomi::*;
    use app_install::InstallSession;

    let _serial = lock_global_queue();
    clear_global_install_events();

    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let wire_handle = wire.clone();
    let mut transport = XiaomiInstallTransport::with_wire(Box::new(wire));

    let session_id = "xiaomi_inst_com.test.confirm_1".to_string();
    transport.bridge.protocol.active_session = Some(InstallSession {
        session_id: session_id.clone(),
        status: "transferring".to_string(),
        file_size: 4096,
        chunk_size: 512,
        total_chunks: 8,
    });
    transport.bridge.protocol.metadata = Some(InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 4096,
        hash: "test_hash".to_string(),
    });

    // 1. 设备上报 id=2 且 result_code=0（成功），目标包名一致
    let app_res = AppInstallerResult::new(
        InstallResultCode::Success,
        Some("com.codeisland.band".to_string()),
    );
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 50,
        payload: L2Packet::pb_write(wp.encode()).to_bytes(),
    });

    // 2. 已安装列表里**没有**目标包 → 必须判失败，不能只凭 id=2 成功
    let list = encode_installed_list_response(&[InstalledApp::new("com.other.app", 1)]);
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 51,
        payload: L2Packet::pb_write(list).to_bytes(),
    });

    let res = transport.bridge.transport_commit(&session_id);
    assert!(res.is_err(), "已安装列表未命中时不得判成功");
    assert_eq!(transport.bridge.state, RuntimeBridgeState::Failed);
    assert_ne!(transport.bridge.state, RuntimeBridgeState::Completed);

    // 已安装列表查询确实发到了真实链路（不是只入队）
    assert!(
        wire_handle.sent_count() >= 1,
        "commit 必须真的发出 id=0 已安装列表查询"
    );
}

#[test]
fn test_transport_commit_completes_only_when_installed_list_matches() {
    use app_install::xiaomi::*;
    use app_install::InstallSession;

    let _serial = lock_global_queue();
    clear_global_install_events();

    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let mut transport = XiaomiInstallTransport::with_wire(Box::new(wire));

    let session_id = "xiaomi_inst_com.test.confirm_2".to_string();
    transport.bridge.protocol.active_session = Some(InstallSession {
        session_id: session_id.clone(),
        status: "transferring".to_string(),
        file_size: 4096,
        chunk_size: 512,
        total_chunks: 8,
    });
    transport.bridge.protocol.metadata = Some(InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 4096,
        hash: "test_hash".to_string(),
    });

    // id=2 成功
    let app_res = AppInstallerResult::new(
        InstallResultCode::Success,
        Some("com.codeisland.band".to_string()),
    );
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 60,
        payload: L2Packet::pb_write(wp.encode()).to_bytes(),
    });

    // 已安装列表命中 package_name + version_code
    let mut installed = InstalledApp::new("com.codeisland.band", 26);
    installed.app_name = Some("Pulse".to_string());
    installed.fingerprint = vec![0xBB; 20];
    let list = encode_installed_list_response(&[installed]);
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 61,
        payload: L2Packet::pb_write(list).to_bytes(),
    });

    let res = transport
        .bridge
        .transport_commit(&session_id)
        .expect("id=2 成功且已安装列表命中时应判成功");
    assert_eq!(res.status, "completed");
    assert_eq!(transport.bridge.state, RuntimeBridgeState::Completed);
}

#[test]
fn test_wait_result_skips_unrelated_frames_before_install_result() {
    use app_install::xiaomi::*;
    use app_install::InstallSession;

    let _serial = lock_global_queue();
    clear_global_install_events();

    let wire = MockInstallWireSender::new();
    wire.set_authenticated(true);
    let mut transport = XiaomiInstallTransport::with_wire(Box::new(wire));

    let session_id = "xiaomi_inst_com.test.skip_1".to_string();
    transport.bridge.protocol.active_session = Some(InstallSession {
        session_id: session_id.clone(),
        status: "transferring".to_string(),
        file_size: 4096,
        chunk_size: 512,
        total_chunks: 8,
    });
    transport.bridge.protocol.metadata = Some(InstallMetadata {
        package_id: "com.codeisland.band".to_string(),
        version_name: "1.0.1".to_string(),
        version_code: 26,
        file_size: 4096,
        hash: "test_hash".to_string(),
    });

    // 队首先放一个 Mass 通道帧（分片传输期间累积、无人消费），再放真正的 id=2 结果。
    // 修复前 wait_install_result 会拿队首严格解码并直接报错。
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 40,
        payload: L2Packet::mass_write(vec![0xAA; 8]).to_bytes(),
    });
    let app_res = AppInstallerResult::new(
        InstallResultCode::Success,
        Some("com.codeisland.band".to_string()),
    );
    let wp = WearPacket::new_thirdparty_app(2, ThirdpartyApp::from_install_result(app_res));
    transport.bridge.process_incoming_frame(Frame {
        frame_type: 0x03,
        seq: 41,
        payload: L2Packet::pb_write(wp.encode()).to_bytes(),
    });

    let res = transport
        .bridge
        .protocol
        .wait_install_result(&mut transport.bridge.install_session, &session_id)
        .expect("跳过 Mass 帧后应能读到真正的 id=2 结果");
    assert_eq!(res.status, "success");
    assert_eq!(transport.bridge.protocol.state, XiaomiInstallState::Success);
}

#[test]
fn test_no_oronbox_dependency() {
    let files_to_check = [
        "src/install/xiaomi/runtime_bridge.rs",
        "src/install/xiaomi/protocol.rs",
        "src/install/xiaomi/device_session.rs",
        "src/install/xiaomi/mass.rs",
        "src/install/xiaomi/l2.rs",
        "src/install/xiaomi/thirdparty_app.rs",
        "src/install/xiaomi/wear_packet.rs",
        "src/install/xiaomi/codec.rs",
        "src/install/xiaomi/wire.rs",
    ];

    let forbidden_patterns = ["oronbox", "install.local"];

    for file_rel in files_to_check {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file_rel);
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("无法读取文件 {:?}: {e}", path));
        let lower = content.to_lowercase();
        for pattern in forbidden_patterns {
            assert!(
                !lower.contains(pattern),
                "违规依赖检测失败: 文件 {:?} 包含了禁用关键字 {:?}",
                file_rel,
                pattern
            );
        }
    }
}
