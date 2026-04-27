use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    #[serde(alias = "bbAgentPath")]
    pub kordi_runtime_path: String,
    pub bridges_path: String,
    #[serde(alias = "bbAgentBinary")]
    pub kordi_runtime_binary: String,
    pub bridges_binary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub label: String,
    pub repo_path: String,
    pub exists: bool,
    pub cargo_manifest_exists: bool,
    pub expected_binary_path: String,
    pub binary_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub label: String,
    pub bundled_path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceStatus {
    pub app_root: String,
    pub workspace_file: String,
    pub kordi_runtime: RepoStatus,
    pub bridges: RepoStatus,
    pub sidecars: Vec<SidecarStatus>,
}

fn current_target_triple() -> String {
    option_env!("TAURI_ENV_TARGET_TRIPLE")
        .or(option_env!("TARGET"))
        .unwrap_or(std::env::consts::ARCH)
        .to_string()
}

pub(crate) fn source_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should always have a parent directory")
        .to_path_buf()
}

pub(crate) fn repo_root() -> PathBuf {
    source_root()
        .parent()
        .and_then(|path| path.parent())
        .expect("app/desktop should always live under the repo root")
        .to_path_buf()
}

fn default_config() -> WorkspaceConfig {
    WorkspaceConfig {
        kordi_runtime_path: "../../agent".into(),
        bridges_path: "../../bridges".into(),
        kordi_runtime_binary: "../target/release/kordi".into(),
        bridges_binary: "target/release/bridges".into(),
    }
}

pub fn read_workspace_config() -> (PathBuf, WorkspaceConfig) {
    let path = source_root().join("kordi.workspace.json");
    let config = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<WorkspaceConfig>(&raw).ok())
        .unwrap_or_else(default_config);

    (path, config)
}

fn build_repo_status(label: &str, repo_path: &Path, binary_relative_path: &str) -> RepoStatus {
    let cargo_manifest = repo_path.join("Cargo.toml");
    let expected_binary = repo_path.join(binary_relative_path);

    RepoStatus {
        label: label.to_string(),
        repo_path: repo_path.display().to_string(),
        exists: repo_path.exists(),
        cargo_manifest_exists: cargo_manifest.exists(),
        expected_binary_path: expected_binary.display().to_string(),
        binary_exists: expected_binary.exists(),
    }
}

fn allowed_workspace_text_read_target(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("AGENTS.md" | "CLAUDE.md" | "identity.md" | "config.json" | "settings.json")
    )
}

fn allowed_workspace_text_write_target(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("AGENTS.md" | "CLAUDE.md" | "identity.md" | "config.json" | "settings.json")
    )
}

fn resolve_allowed_workspace_text_path(
    raw_path: &str,
    allow_write: bool,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }

    let relative = Path::new(trimmed);
    if relative.is_absolute() {
        return Err("Path must be repo-relative".to_string());
    }

    let root = repo_root();
    let candidate = root.join(relative);

    if allow_write {
        if !allowed_workspace_text_write_target(relative) {
            return Err(
                "Writing is only allowed for repo-relative agent identity and config files"
                    .to_string(),
            );
        }
    } else if !allowed_workspace_text_read_target(relative) {
        return Err("Reading is only allowed for agent identity and config files".to_string());
    }

    if candidate.exists() {
        let canonical = candidate.canonicalize().map_err(|err| err.to_string())?;
        if !canonical.starts_with(&root) {
            return Err("Path must stay inside the repo".to_string());
        }
        return Ok(canonical);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "Path must have a parent directory".to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|err| err.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("Path must stay inside the repo".to_string());
    }

    Ok(candidate)
}

pub fn desktop_read_workspace_text_file(path: String) -> Result<String, String> {
    let resolved = resolve_allowed_workspace_text_path(&path, false)?;
    fs::read_to_string(&resolved).map_err(|err| err.to_string())
}

pub fn desktop_write_workspace_text_file(path: String, contents: String) -> Result<String, String> {
    let resolved = resolve_allowed_workspace_text_path(&path, true)?;

    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    fs::write(&resolved, contents).map_err(|err| err.to_string())?;
    Ok(resolved.display().to_string())
}

pub fn desktop_workspace_status() -> DesktopWorkspaceStatus {
    let app_root = source_root();
    let (workspace_file, config) = read_workspace_config();

    let kordi_runtime_repo = app_root.join(&config.kordi_runtime_path);
    let bridges_repo = app_root.join(&config.bridges_path);
    let sidecar_dir = app_root.join("src-tauri").join("binaries");
    let target_triple = current_target_triple();

    DesktopWorkspaceStatus {
        app_root: app_root.display().to_string(),
        workspace_file: workspace_file.display().to_string(),
        kordi_runtime: build_repo_status(
            "Kordi runtime",
            &kordi_runtime_repo,
            &config.kordi_runtime_binary,
        ),
        bridges: build_repo_status("Bridges", &bridges_repo, &config.bridges_binary),
        sidecars: vec![
            SidecarStatus {
                label: "Kordi runtime".into(),
                bundled_path: sidecar_dir
                    .join(format!("kordi-{}", target_triple))
                    .display()
                    .to_string(),
                exists: sidecar_dir
                    .join(format!("kordi-{}", target_triple))
                    .exists(),
            },
            SidecarStatus {
                label: "Bridges".into(),
                bundled_path: sidecar_dir
                    .join(format!("bridges-{}", target_triple))
                    .display()
                    .to_string(),
                exists: sidecar_dir
                    .join(format!("bridges-{}", target_triple))
                    .exists(),
            },
        ],
    }
}
