use super::*;
use std::fs;

fn fixture() -> (PathBuf, RenderSandboxConfig) {
    let root = std::env::temp_dir().join(format!("kordi-render-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let root = fs::canonicalize(root).unwrap();
    let config = RenderSandboxConfig {
        owner: "tea-test".into(),
        group: "sbg-test".into(),
        token: "fixture-only".into(),
        root: root.clone(),
        max_workspaces: 2,
    };
    (root, config)
}
#[test]
fn persistent_checkpoint_survives_restart_and_serializes_owners() {
    let (root, config) = fixture();
    let workspace = store::Workspace::acquire(&config, "account-A").unwrap();
    workspace.commit(b"[]").unwrap();
    // An interrupted or failed replacement must not replace the committed file.
    let directory = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().unwrap().is_dir())
        .unwrap()
        .path();
    fs::create_dir(directory.join("checkpoint.pending")).unwrap();
    assert!(workspace.commit(b"uncommitted").is_err());
    assert_eq!(workspace.load().unwrap().unwrap(), b"[]");
    fs::remove_dir(directory.join("checkpoint.pending")).unwrap();
    assert!(store::Workspace::acquire(&config, "account-A").is_err());
    let other = store::Workspace::acquire(&config, "account-a").unwrap();
    assert!(other.load().unwrap().is_none());
    assert!(store::Workspace::acquire(&config, "third").is_err());
    drop(workspace);
    let restored = store::Workspace::acquire(&config, "account-A").unwrap();
    assert_eq!(restored.load().unwrap().unwrap(), b"[]");
    drop((restored, other));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn checkpoints_reject_escape_duplicate_parent_and_special_files() {
    let valid = json!([
        {"path":"folder","kind":"directory"},
        {"path":"folder/data","kind":"file","data":"aGk=","executable":false}
    ]);
    assert!(validate_checkpoint(&serde_json::to_vec(&valid).unwrap()).is_ok());
    for path in [
        "../escape",
        "/absolute",
        ".",
        "",
        "a/../b",
        "a//b",
        "a/./b",
        "a/",
    ] {
        assert!(validate_checkpoint(
            &serde_json::to_vec(&json!([{ "path":path,"kind":"directory"}])).unwrap()
        )
        .is_err());
    }
    for invalid in [
        json!([{"path":"a/b","kind":"directory"}]),
        json!([{"path":"a","kind":"directory"},{"path":"a","kind":"directory"}]),
        json!([{"path":"link","kind":"symlink","target":"/etc/passwd"}]),
        json!([{"path":"a","kind":"file","data":"!","executable":false}]),
    ] {
        assert!(validate_checkpoint(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}
#[test]
fn capability_credentials_are_restricted_to_the_expected_guest() {
    let value = json!({"method":"POST"});
    assert!(api::validate_capability(
        "https://sbx-test.oregon.sandbox.onrender.com/runs/sync",
        "sbx-test",
        "POST",
        &value
    )
    .is_ok());
    for uri in [
        "http://sbx-test.oregon.sandbox.onrender.com/runs/sync",
        "https://attacker.example/runs/sync",
        "https://sbx-other.oregon.sandbox.onrender.com/runs/sync",
        "https://sbx-test.oregon.sandbox.onrender.com.attacker.example/runs/sync",
        "https://user@sbx-test.oregon.sandbox.onrender.com/runs/sync",
    ] {
        assert!(api::validate_capability(uri, "sbx-test", "POST", &value).is_err());
    }
    assert!(api::validate_capability(
        "https://sbx-test.oregon.sandbox.onrender.com/runs/sync",
        "sbx-test",
        "GET",
        &value
    )
    .is_err());
}
#[test]
fn path_and_configuration_checks_fail_closed() {
    let (root, mut config) = fixture();
    assert!(config.validate().is_ok());
    for path in ["../other", "/etc/passwd", "a/../../other"] {
        assert!(workspace_path(path).is_err());
    }
    config.root = root.join("missing");
    assert!(config.validate().is_err());
    config.root = root.clone();
    config.group = "../other".into();
    assert!(config.validate().is_err());
    fs::remove_dir_all(root).unwrap();
}

/// Explicitly opt in only with a disposable sandbox group and a synthetic,
/// dedicated persistent directory. No credentials or guest output are logged.
#[tokio::test]
#[ignore = "requires an explicitly authorized disposable Render sandbox group"]
async fn live_render_recovery_isolation_and_limits() {
    assert_eq!(
        std::env::var("KORDI_RENDER_LIVE_TEST").as_deref(),
        Ok("synthetic-only")
    );
    let a = RenderSandboxBackend::from_env("render-acceptance-a").unwrap();
    a.write_text("proof.txt", "synthetic persistent fixture")
        .await
        .unwrap();
    eprintln!("Render acceptance: write checkpoint passed");
    drop(a);
    let a = RenderSandboxBackend::from_env("render-acceptance-a").unwrap();
    assert_eq!(
        a.read_text("proof.txt").await.unwrap(),
        "synthetic persistent fixture"
    );
    eprintln!("Render acceptance: restore passed");
    let b = RenderSandboxBackend::from_env("render-acceptance-b").unwrap();
    assert!(b.read_text("proof.txt").await.is_err());
    assert_eq!(a.run_bash("exit 7").await.unwrap().exit_code, 7);
    assert!(a.run_bash("yes").await.unwrap().exit_code != 0);
    assert!(a.run_bash("ln -s /etc/passwd escape").await.is_err());
    assert_eq!(
        a.read_text("proof.txt").await.unwrap(),
        "synthetic persistent fixture"
    );
    let result = a.run_bash("python3 -c 'import socket; s=socket.socket(); s.settimeout(2); s.connect((\"1.1.1.1\",443))'").await.unwrap();
    assert_ne!(result.exit_code, 0);
    let backend = std::sync::Arc::new(a);
    let task_backend = backend.clone();
    let task = tokio::spawn(async move {
        task_backend
            .run_bash("printf unacknowledged > proof.txt; sleep 60")
            .await
    });
    let mut active = None;
    for _ in 0..40 {
        let list = backend
            .api
            .call(
                reqwest::Method::GET,
                &format!("/sandboxes?sandboxGroupId={}", backend.config.group),
                None,
            )
            .await
            .unwrap();
        for row in list.as_array().unwrap() {
            let sandbox = &row["sandbox"];
            if sandbox["status"] != "running" {
                continue;
            }
            let id = sandbox["id"].as_str().unwrap();
            let executions = backend
                .api
                .call(
                    reqwest::Method::GET,
                    &format!("/sandboxes/{id}/execs"),
                    None,
                )
                .await
                .unwrap();
            let runs: Vec<_> = executions
                .as_array()
                .unwrap()
                .iter()
                .map(|v| &v["execution"])
                .filter(|v| v["type"] == "runs")
                .collect();
            if runs.len() >= 2 && runs.iter().any(|v| v["stoppedAt"].is_null()) {
                active = Some(id.to_owned());
                break;
            }
        }
        if active.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let id = active.expect("The synthetic command must be active before cancellation");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    backend.shutdown().await.unwrap();
    let mut terminated = false;
    for _ in 0..40 {
        let state = backend
            .api
            .call(reqwest::Method::GET, &format!("/sandboxes/{id}"), None)
            .await
            .unwrap();
        if state["status"] == "terminated" {
            terminated = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(
        terminated,
        "Cancellation must terminate the executing guest"
    );
    assert_eq!(
        backend.read_text("proof.txt").await.unwrap(),
        "synthetic persistent fixture"
    );
    let timeout = backend.run_bash("sleep 60").await.unwrap();
    assert_ne!(timeout.exit_code, 0);
    eprintln!("Render acceptance: cancellation, recovery, and command deadline passed");
}

#[test]
fn guest_checkpoint_regressions() {
    let test = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/render_sandbox/guest_test.py");
    let result = std::process::Command::new("python3")
        .arg("-B")
        .arg(test)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Guest checkpoint regression failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
