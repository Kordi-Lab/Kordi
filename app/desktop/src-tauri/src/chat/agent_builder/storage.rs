//! Durable draft metadata, path, JSON, and mutation-lock storage.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::super::now_millis;
use super::models::{DesktopAgentBuilderMetadata, DesktopAgentBuilderTestReport};
use super::{METADATA_FILE, RESOURCES_DIR, SESSION_PREFIX, TEST_REPORT_FILE, WORKSPACE_DIR};

pub(super) fn drafts_root() -> PathBuf {
    kordi_core::config::preferred_global_settings_dir().join("agent-drafts")
}

pub(super) fn builder_mutation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(super) fn checked_draft_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    uuid::Uuid::parse_str(trimmed).map_err(|_| "Kordi Factory draft id is invalid".to_string())?;
    Ok(trimmed)
}

pub(super) fn container_for_draft(draft_id: &str) -> Result<PathBuf, String> {
    Ok(drafts_root().join(checked_draft_id(draft_id)?))
}

pub(super) fn workspace_for_draft(draft_id: &str) -> Result<PathBuf, String> {
    Ok(container_for_draft(draft_id)?.join(WORKSPACE_DIR))
}

pub(super) fn draft_container(workspace: &Path) -> Result<&Path, String> {
    workspace
        .parent()
        .ok_or_else(|| "Kordi Factory workspace is invalid".to_string())
}

pub(super) fn metadata_path(container: &Path) -> PathBuf {
    container.join(METADATA_FILE)
}

pub(super) fn test_report_path(container: &Path) -> PathBuf {
    container.join(TEST_REPORT_FILE)
}

pub(super) fn resources_root(container: &Path) -> PathBuf {
    container.join(RESOURCES_DIR).join("skills")
}

pub(super) fn write_metadata(
    workspace: &Path,
    metadata: &DesktopAgentBuilderMetadata,
) -> Result<(), String> {
    write_json(&metadata_path(draft_container(workspace)?), metadata)
}

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))
}

pub(super) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to encode {}: {error}", path.display()))?;
    fs::write(path, format!("{text}\n"))
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

pub(super) fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    }
    fs::write(path, content).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

pub(super) fn find_active_draft(target_key: &str) -> Option<DesktopAgentBuilderMetadata> {
    let entries = fs::read_dir(drafts_root()).ok()?;
    entries
        .flatten()
        .filter_map(|entry| {
            read_json::<DesktopAgentBuilderMetadata>(&metadata_path(&entry.path())).ok()
        })
        .filter(|metadata| metadata.target_key == target_key && metadata.status == "draft")
        .max_by_key(|metadata| metadata.updated_at_ms)
}

pub(super) fn new_metadata(target_key: &str) -> DesktopAgentBuilderMetadata {
    let draft_id = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    DesktopAgentBuilderMetadata {
        session_id: format!("{SESSION_PREFIX}{draft_id}"),
        draft_id,
        target_key: target_key.to_string(),
        status: "draft".to_string(),
        created_at_ms: now,
        updated_at_ms: now,
    }
}

pub(super) fn read_test_report(container: &Path) -> Option<DesktopAgentBuilderTestReport> {
    read_json(&test_report_path(container)).ok()
}

pub(super) fn load_metadata(
    draft_id: &str,
) -> Result<(PathBuf, DesktopAgentBuilderMetadata), String> {
    let container = container_for_draft(draft_id)?;
    let workspace = workspace_for_draft(draft_id)?;
    let metadata = read_json(&metadata_path(&container))?;
    Ok((workspace, metadata))
}
