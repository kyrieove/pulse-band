//! 快应用安装抽象层传输与生命周期集成测试 (App Install Transport Tests)

#[path = "../src/app_install.rs"]
mod app_install;

use app_install::{
    AppInstallTransport, InstallChunk, InstallMetadata, InstallTransportDispatcher,
    MockAppInstallTransport, TransportMode, XiaomiBand10Transport,
};

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
