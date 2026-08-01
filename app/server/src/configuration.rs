//! Environment, executable, port, and workspace command resolution.

use directories::BaseDirs;
use serde::Deserialize;
use std::path::PathBuf;

use crate::turn_execution::TurnCommand;

#[derive(Debug, Clone, Deserialize)]
struct BridgesDaemonConfig {
    #[serde(default = "default_bridges_port")]
    local_api_port: u16,
}

pub(super) fn resolve_bridges_base_url() -> String {
    let port = std::env::var("BRIDGES_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(load_bridges_local_api_port);
    format!("http://127.0.0.1:{port}")
}

fn load_bridges_local_api_port() -> u16 {
    let Some(base) = BaseDirs::new() else {
        return default_bridges_port();
    };
    let path = base.home_dir().join(".bridges").join("daemon.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return default_bridges_port();
    };
    serde_json::from_str::<BridgesDaemonConfig>(&raw)
        .map(|config| config.local_api_port)
        .unwrap_or_else(|_| default_bridges_port())
}

fn default_bridges_port() -> u16 {
    7070
}

pub(super) fn resolve_turn_command() -> TurnCommand {
    // Preserve the legacy env var as a fallback while preferring the new Kordi name.
    for key in ["KORDI_BIN", "KORDI_BB_BIN"] {
        if let Ok(path) = std::env::var(key)
            && !path.trim().is_empty()
        {
            return TurnCommand {
                program: path,
                base_args: Vec::new(),
                current_dir: None,
            };
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        let sibling = current_exe.with_file_name(format!("kordi{}", std::env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return TurnCommand {
                program: sibling.display().to_string(),
                base_args: Vec::new(),
                current_dir: None,
            };
        }
    }

    if let Some(repo_root) = compile_time_repo_root() {
        return TurnCommand {
            program: "cargo".to_string(),
            base_args: vec![
                "run".to_string(),
                "-p".to_string(),
                "kordi-cli".to_string(),
                "--".to_string(),
            ],
            current_dir: Some(repo_root),
        };
    }

    TurnCommand {
        program: "kordi".to_string(),
        base_args: Vec::new(),
        current_dir: None,
    }
}

fn compile_time_repo_root() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?.parent()?.to_path_buf();
    if repo_root.join("agent/crates/cli/src/main.rs").is_file() {
        Some(repo_root)
    } else {
        None
    }
}
