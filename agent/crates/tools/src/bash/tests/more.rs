use super::*;

#[tokio::test]
async fn bash_denies_approval_needed_commands_in_noninteractive_mode() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let result = tool
        .execute(
            json!({
                "command": "cargo check --workspace"
            }),
            &ToolContext {
                execution_policy: crate::ExecutionPolicy::Safety,
                execution_mode: ToolExecutionMode::NonInteractive,
                ..make_ctx(dir.path())
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text,
        other => panic!("unexpected content block: {other:?}"),
    };
    assert!(result.is_error);
    assert!(text.contains("blocked"));
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|details| details.get("blockedBySafetyPolicy"))
            .and_then(|value| value.as_bool()),
        Some(true)
    );
}

#[tokio::test]
async fn bash_requests_approval_for_non_read_only_commands() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let approval_calls = Arc::new(AtomicUsize::new(0));
    let callback_calls = approval_calls.clone();

    let result = tool
        .execute(
            json!({
                "command": "echo hi > /tmp/out.txt"
            }),
            &ToolContext {
                execution_policy: crate::ExecutionPolicy::Safety,
                connector_tools: None,
                request_approval: Some(Arc::new(move |request| {
                    let callback_calls = callback_calls.clone();
                    Box::pin(async move {
                        callback_calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(request.tool_name, "bash");
                        assert!(request.reason.contains("shell control operators"));
                        crate::ToolApprovalOutcome {
                            decision: crate::ToolApprovalDecision::Denied,
                        }
                    })
                })),
                ..make_ctx(dir.path())
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(approval_calls.load(Ordering::SeqCst), 1);
    assert!(result.is_error);
}

#[cfg(unix)]
#[tokio::test]
async fn bash_uses_rtk_when_opted_in_and_available() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    write_fake_rtk(
        &bin_dir,
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "rtk 1.2.3"
  exit 0
fi
echo "RTK_FILTERED:$*"
"#,
    );
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let joined_path = format!("{}:{}", bin_dir.display(), original_path.to_string_lossy());
    let _path = EnvRestore::set("PATH", joined_path);
    let _rtk = EnvRestore::set("KORDI_BASH_RTK", "1");
    let tool = BashTool;

    let result = tool
        .execute(
            json!({ "command": "printf raw-output" }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let ContentBlock::Text { text } = &result.content[0] else {
        panic!("expected text result");
    };
    assert!(text.contains("RTK_FILTERED:"));
    assert_ne!(text, "raw-output");
    let details = result.details.as_ref().expect("details");
    assert_eq!(details["outputOptimization"]["provider"], "rtk");
    assert_eq!(details["outputOptimization"]["enabled"], true);
    assert_eq!(details["outputOptimization"]["applied"], true);
    assert_eq!(details["outputOptimization"]["version"], "rtk 1.2.3");
}

#[cfg(unix)]
#[tokio::test]
async fn bash_skips_rtk_when_opted_out_even_if_available() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    write_fake_rtk(
        &bin_dir,
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "rtk 1.2.3"
  exit 0
fi
echo "RTK_FILTERED:$*"
"#,
    );
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let joined_path = format!("{}:{}", bin_dir.display(), original_path.to_string_lossy());
    let _path = EnvRestore::set("PATH", joined_path);
    let _rtk = EnvRestore::remove("KORDI_BASH_RTK");
    let tool = BashTool;

    let result = tool
        .execute(
            json!({ "command": "printf raw-output" }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let ContentBlock::Text { text } = &result.content[0] else {
        panic!("expected text result");
    };
    assert_eq!(text, "raw-output");
    assert_eq!(
        result.details.as_ref().expect("details")["outputOptimization"]["enabled"],
        false
    );
}

#[cfg(unix)]
#[tokio::test]
async fn rtk_detection_reports_missing_rtk_without_breaking_sessions() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let _path = EnvRestore::set("PATH", "");

    let error = process::detect_rtk_version()
        .await
        .expect_err("missing rtk should be reported as unavailable");

    assert!(error.contains("rtk not available"));
}

#[cfg(unix)]
#[tokio::test]
async fn bash_falls_back_to_raw_when_rtk_detection_fails() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    write_fake_rtk(
        &bin_dir,
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "rtk broken" >&2
  exit 2
fi
echo "RTK_FILTERED:$*"
"#,
    );
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let joined_path = format!("{}:{}", bin_dir.display(), original_path.to_string_lossy());
    let _path = EnvRestore::set("PATH", joined_path);
    let _rtk = EnvRestore::set("KORDI_BASH_RTK", "1");
    let tool = BashTool;

    let result = tool
        .execute(
            json!({ "command": "printf raw-output" }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let ContentBlock::Text { text } = &result.content[0] else {
        panic!("expected text result");
    };
    assert_eq!(text, "raw-output");
    let details = result.details.as_ref().expect("details");
    assert_eq!(details["outputOptimization"]["enabled"], true);
    assert_eq!(details["outputOptimization"]["applied"], false);
    assert!(
        details["outputOptimization"]["fallbackReason"]
            .as_str()
            .unwrap()
            .contains("rtk --version failed")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn bash_raw_parameter_bypasses_rtk_for_debugging() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    write_fake_rtk(
        &bin_dir,
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "rtk 1.2.3"
  exit 0
fi
echo "RTK_FILTERED:$*"
"#,
    );
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let joined_path = format!("{}:{}", bin_dir.display(), original_path.to_string_lossy());
    let _path = EnvRestore::set("PATH", joined_path);
    let _rtk = EnvRestore::set("KORDI_BASH_RTK", "1");
    let tool = BashTool;

    let result = tool
        .execute(
            json!({ "command": "printf raw-output", "raw": true }),
            &make_ctx(dir.path()),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let ContentBlock::Text { text } = &result.content[0] else {
        panic!("expected text result");
    };
    assert_eq!(text, "raw-output");
    let details = result.details.as_ref().expect("details");
    assert_eq!(details["outputOptimization"]["enabled"], true);
    assert_eq!(details["outputOptimization"]["applied"], false);
    assert_eq!(
        details["outputOptimization"]["fallbackReason"],
        "raw output requested"
    );
}

#[tokio::test]
async fn safety_mode_requires_sandbox_backend_without_falling_back() {
    let _path_guard = PATH_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let tool = BashTool;
    let original_path = std::env::var_os("PATH");
    unsafe {
        std::env::set_var("PATH", "");
    }

    let result = tool
        .execute(
            json!({
                "command": "echo should-not-run > sandbox-sentinel"
            }),
            &ToolContext {
                execution_policy: crate::ExecutionPolicy::Safety,
                ..make_ctx(dir.path())
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();

    match original_path {
        Some(path) => unsafe { std::env::set_var("PATH", path) },
        None => unsafe { std::env::remove_var("PATH") },
    }

    assert!(result.is_error);
    assert!(!dir.path().join("sandbox-sentinel").exists());
    let details = result.details.unwrap();
    assert_eq!(details["sandbox"]["failure"]["kind"], "backendUnavailable");
    assert_eq!(
        details["sandbox"]["failure"]["escalation"]["action"],
        "rerunWithBroaderPermissions"
    );
}
