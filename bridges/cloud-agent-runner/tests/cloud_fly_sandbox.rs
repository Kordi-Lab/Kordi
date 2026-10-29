use kordi_cloud_agent_runner::fly_sandbox::FlySandboxBackend;
use kordi_cloud_agent_runner::sandbox_client::SandboxBackend;
use std::sync::Arc;
use std::time::Duration;

/// Opt-in, paid integration test. Requires a dedicated empty Fly sandbox app,
/// app-scoped credentials, and an explicit disposable workspace prefix.
#[tokio::test]
#[ignore = "requires an explicitly configured isolated Fly app; creates paid resources"]
async fn live_workspace_persistence_isolation_and_cancellation() {
    let prefix =
        std::env::var("KORDI_FLY_TEST_WORKSPACE").expect("Set a disposable test workspace prefix");
    assert!(prefix.starts_with("test-"));
    let note_path = format!("notes/{}.txt", uuid::Uuid::new_v4().simple());
    let first = Arc::new(FlySandboxBackend::from_env(&format!("{prefix}-a")).unwrap());
    first
        .write_text(&note_path, "durable fixture\n")
        .await
        .unwrap();
    assert_eq!(
        first.read_text(&note_path).await.unwrap(),
        "durable fixture\n"
    );
    assert!(first.read_bytes_bounded(&note_path, 2).await.is_err());
    first.shutdown().await.unwrap();
    drop(first);
    let restored = Arc::new(FlySandboxBackend::from_env(&format!("{prefix}-a")).unwrap());
    assert_eq!(
        restored.read_text(&note_path).await.unwrap(),
        "durable fixture\n"
    );
    let second = FlySandboxBackend::from_env(&format!("{prefix}-b")).unwrap();
    assert!(second.read_text(&note_path).await.is_err());
    second
        .write_text(&note_path, "second workspace\n")
        .await
        .unwrap();
    assert_eq!(
        restored.read_text(&note_path).await.unwrap(),
        "durable fixture\n"
    );
    second.shutdown().await.unwrap();
    let marker = uuid::Uuid::new_v4().simple().to_string();
    let expected_marker = marker.clone();
    let running = restored.clone();
    let task = tokio::spawn(async move {
        running
            .run_bash(&format!(
                "printf {marker} > cancel-started; sleep 20; printf leaked > cancel-leaked"
            ))
            .await
    });
    tokio::time::sleep(Duration::from_secs(5)).await;
    task.abort();
    let _ = task.await;
    restored.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_secs(21)).await;
    assert!(restored.read_text("cancel-leaked").await.is_err());
    assert_eq!(
        restored.read_text("cancel-started").await.unwrap(),
        expected_marker
    );
    assert_eq!(
        restored.read_text(&note_path).await.unwrap(),
        "durable fixture\n"
    );
    restored.renew_lease().await.unwrap();
    // Simulate abrupt runner death: no shutdown, Drop, or heartbeat. A new
    // backend must await expiry, stop the orphan VM, and retain its workspace.
    std::mem::forget(restored);
    let recovered = FlySandboxBackend::from_env(&format!("{prefix}-a")).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(110), recovered.read_text(&note_path))
            .await
            .unwrap()
            .unwrap(),
        "durable fixture\n"
    );
    recovered.shutdown().await.unwrap();
}
