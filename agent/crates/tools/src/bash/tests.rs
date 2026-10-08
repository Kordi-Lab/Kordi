use super::*;
use kordi_core::types::ContentBlock;
use std::fs;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

static PATH_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct EnvRestore {
    key: &'static str,
    original: Option<std::ffi::OsString>,
}

impl EnvRestore {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let original = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, original }
    }

    fn remove(key: &'static str) -> Self {
        let original = std::env::var_os(key);
        unsafe {
            std::env::remove_var(key);
        }
        Self { key, original }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        match self.original.as_ref() {
            Some(value) => unsafe { std::env::set_var(self.key, value) },
            None => unsafe { std::env::remove_var(self.key) },
        }
    }
}

#[cfg(unix)]
fn write_fake_rtk(bin_dir: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(bin_dir).expect("bin dir");
    let path = bin_dir.join("rtk");
    fs::write(&path, body).expect("fake rtk script");
    let mut permissions = fs::metadata(&path)
        .expect("fake rtk metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("fake rtk executable");
}

fn make_ctx(dir: &Path) -> ToolContext {
    ToolContext {
        cwd: dir.to_path_buf(),
        artifacts_dir: dir.to_path_buf(),
        model: None,
        execution_policy: crate::ExecutionPolicy::Yolo,
        invocation_id: None,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        mac_local: None,
        execution_mode: ToolExecutionMode::Interactive,
        request_approval: Some(Arc::new(|_| {
            Box::pin(async {
                crate::ToolApprovalOutcome {
                    decision: crate::ToolApprovalDecision::ApprovedOnce,
                }
            })
        })),
    }
}

include!("workdir_tests.rs");

#[tokio::test]
async fn bash_collects_stdout_and_stderr_without_deadlock() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let result = tool
        .execute(
            json!({
                "command": "for i in $(seq 1 2000); do echo err-$i 1>&2; done; echo done"
            }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text,
        other => panic!("unexpected content block: {other:?}"),
    };
    assert!(text.contains("done") || result.artifact_path.is_some());
    assert!(text.contains("err-1"));
    assert!(!text.is_empty());
}

#[tokio::test]
async fn bash_streams_stdout_and_stderr_chunks_to_on_output() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let streamed = Arc::new(Mutex::new(String::new()));
    let streamed_clone = streamed.clone();

    let result = tool
        .execute(
            json!({
                "command": "printf 'out\\n'; printf 'err\\n' 1>&2"
            }),
            &ToolContext {
                invocation_id: None,
                on_output: Some(Box::new(move |chunk| {
                    streamed_clone
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push_str(chunk);
                })),
                ..make_ctx(dir.path())
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    let streamed = streamed
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    assert!(streamed.contains("out"));
    assert!(streamed.contains("err"));
}

#[tokio::test]
async fn bash_redacts_live_streamed_secrets_and_final_output() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let streamed = Arc::new(Mutex::new(String::new()));
    let streamed_clone = streamed.clone();

    let result = tool
            .execute(
                json!({
                    "command": "printf 'Authorization: Bearer '; sleep 0.05; printf 'sk-top-secret\\nOPENAI_API_KEY=sk-inline'"
                }),
                &ToolContext {
                    invocation_id: None,
                    on_output: Some(Box::new(move |chunk| {
                        streamed_clone
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push_str(chunk);
                    })),
                    ..make_ctx(dir.path())
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();

    let streamed = streamed
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    assert!(streamed.contains("Authorization: Bearer [REDACTED]"));
    assert!(streamed.contains("OPENAI_API_KEY=[REDACTED]"));
    assert!(!streamed.contains("sk-top-secret"));
    assert!(!streamed.contains("sk-inline"));

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text,
        other => panic!("unexpected content block: {other:?}"),
    };
    assert!(text.contains("Authorization: Bearer [REDACTED]"));
    assert!(text.contains("OPENAI_API_KEY=[REDACTED]"));
    assert!(!text.contains("sk-top-secret"));
    assert!(!text.contains("sk-inline"));
}

#[tokio::test]
async fn bash_redacts_offloaded_artifact_output() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let command =
        "for i in $(seq 1 3000); do printf 'Authorization: Bearer sk-artifact-secret\\n'; done";

    let result = tool
        .execute(
            json!({ "command": command }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let artifact_path = result.artifact_path.expect("artifact path");
    let artifact = std::fs::read_to_string(&artifact_path).expect("read artifact");
    assert!(artifact.contains("Authorization: Bearer [REDACTED]"));
    assert!(!artifact.contains("sk-artifact-secret"));
}

#[tokio::test]
async fn bash_truncates_long_output_by_line_count_without_artifact() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;

    let result = tool
        .execute(
            json!({
                "command": "for i in $(seq 1 2105); do echo x; done"
            }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(result.artifact_path.is_none());
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text,
        other => panic!("unexpected content block: {other:?}"),
    };
    assert!(text.contains("[105 more lines truncated]"));
    assert_eq!(text.lines().filter(|line| *line == "x").count(), 2000);
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|details| details.get("truncated")),
        Some(&json!(true))
    );
}

#[tokio::test]
async fn bash_rejects_invalid_timeout() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let err = tool
        .execute(
            json!({
                "command": "echo hi",
                "timeout": 0
            }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .expect_err("zero timeout should be rejected");

    assert!(err.to_string().contains("bash timeout must be > 0"));
}

#[tokio::test]
async fn bash_timeout_sets_timed_out_detail() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let result = tool
        .execute(
            json!({
                "command": "sleep 1",
                "timeout": 0.05
            }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(result.is_error);
    let details = result.details.unwrap();
    assert_eq!(details["timedOut"], true);
    assert_eq!(details["cancelled"], false);
}

#[tokio::test]
async fn bash_cancellation_sets_cancelled_detail() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        canceller.cancel();
    });

    let result = tool
        .execute(
            json!({
                "command": "sleep 5"
            }),
            &make_ctx(dir.path()),
            cancel,
        )
        .await
        .unwrap();

    assert!(result.is_error);
    let details = result.details.unwrap();
    assert_eq!(details["cancelled"], true);
    assert_eq!(details["timedOut"], false);
}

mod more;
