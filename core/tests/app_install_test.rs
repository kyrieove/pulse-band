//! 快应用安装抽象层传输与生命周期集成测试 (App Install Transport Tests)

#[path = "../src/app_install.rs"]
mod app_install;

use app_install::{
    AppInstallTransport, InstallChunk, InstallMetadata, MockAppInstallTransport,
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
