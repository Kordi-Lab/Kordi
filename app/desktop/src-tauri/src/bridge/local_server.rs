use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::workspace;

use super::{
    health_check, hosted_bridge_dir, DesktopBridgeLocalServerStatus, DesktopBridgeManager,
};

#[derive(Default)]
pub(super) struct LocalBridgeServerRuntime {
    child: Option<Child>,
    status: DesktopBridgeLocalServerStatus,
}

pub(super) fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should always have a parent directory")
        .to_path_buf()
}

pub(super) fn determine_bridge_launcher() -> (Option<String>, Option<PathBuf>, Option<PathBuf>) {
    let workspace_status = workspace::desktop_workspace_status();
    let binary = PathBuf::from(&workspace_status.bridges.expected_binary_path);
    if workspace_status.bridges.binary_exists {
        return (
            Some(binary.display().to_string()),
            Some(binary),
            Some(PathBuf::from(&workspace_status.bridges.repo_path)),
        );
    }

    let repo_path = PathBuf::from(&workspace_status.bridges.repo_path);
    let manifest = repo_path.join("cli").join("Cargo.toml");
    if repo_path.exists() && manifest.exists() {
        return (
            Some(format!(
                "cargo run --manifest-path {} -- serve",
                manifest.display()
            )),
            None,
            Some(repo_path),
        );
    }

    (None, None, None)
}

pub(super) async fn refresh_local_server_runtime(runtime: &mut LocalBridgeServerRuntime) {
    let mut clear_child = false;
    if let Some(child) = runtime.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                runtime.status.running = false;
                runtime.status.last_error = Some(format!("Local bridge server exited: {status}"));
                clear_child = true;
            }
            Ok(None) => {
                runtime.status.running = true;
            }
            Err(err) => {
                runtime.status.running = false;
                runtime.status.last_error =
                    Some(format!("Unable to inspect local bridge server: {err}"));
                clear_child = true;
            }
        }
    }
    if clear_child {
        runtime.child = None;
    }
}

pub(super) async fn current_local_server_status(
    manager: &DesktopBridgeManager,
) -> DesktopBridgeLocalServerStatus {
    let mut runtime = manager.local_server.lock().await;
    refresh_local_server_runtime(&mut runtime).await;
    runtime.status.clone()
}

pub(super) async fn start_local_server(
    manager: &DesktopBridgeManager,
    port: u16,
) -> Result<DesktopBridgeLocalServerStatus, String> {
    let mut runtime = manager.local_server.lock().await;
    refresh_local_server_runtime(&mut runtime).await;
    if runtime.status.running {
        return Ok(runtime.status.clone());
    }

    let (launcher_label, binary_path, repo_path) = determine_bridge_launcher();
    let Some(launcher) = launcher_label else {
        return Err("Unable to find a local Bridges binary or repo to launch".to_string());
    };

    let data_dir = hosted_bridge_dir()?.join(format!("port-{port}"));
    std::fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let db_path = data_dir.join("bridges-server.db");
    let log_path = data_dir.join("bridges-server.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| err.to_string())?;
    let log_file_err = log_file.try_clone().map_err(|err| err.to_string())?;

    let mut command = if let Some(binary_path) = binary_path {
        let mut command = Command::new(binary_path);
        command.arg("serve");
        command
    } else {
        let manifest = repo_path
            .ok_or_else(|| "Unable to determine Bridges repo path".to_string())?
            .join("cli")
            .join("Cargo.toml");
        let mut command = Command::new("cargo");
        command
            .arg("run")
            .arg("--manifest-path")
            .arg(manifest)
            .arg("--")
            .arg("serve");
        command
    };
    command
        .arg("--port")
        .arg(port.to_string())
        .arg("--db")
        .arg(&db_path)
        .current_dir(app_root())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = command
        .spawn()
        .map_err(|err| format!("Unable to start local bridge server: {err}"))?;
    runtime.child = Some(child);
    runtime.status = DesktopBridgeLocalServerStatus {
        running: true,
        server_url: Some(format!("http://127.0.0.1:{port}")),
        port: Some(port),
        db_path: Some(db_path.display().to_string()),
        launcher: Some(launcher),
        last_error: None,
    };
    drop(runtime);

    tokio::time::sleep(Duration::from_millis(900)).await;
    let status = current_local_server_status(manager).await;
    if let Some(url) = &status.server_url {
        health_check(url).await?;
    }
    Ok(status)
}

pub(super) async fn stop_local_server(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeLocalServerStatus, String> {
    let mut runtime = manager.local_server.lock().await;
    if let Some(mut child) = runtime.child.take() {
        child
            .kill()
            .map_err(|err| format!("Unable to stop local bridge server: {err}"))?;
        let _ = child.wait();
    }
    runtime.status.running = false;
    runtime.status.last_error = None;
    Ok(runtime.status.clone())
}
