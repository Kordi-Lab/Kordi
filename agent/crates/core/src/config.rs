use std::path::{Path, PathBuf};

use crate::settings::StorageSettings;

const PROJECT_ROOT_MARKERS: &[&str] = &[
    ".git",
    "Cargo.toml",
    "package.json",
    "go.mod",
    "pyproject.toml",
    ".hg",
    "AGENTS.md",
    "CLAUDE.md",
];
// Keep the legacy project directory name for automatic migration/fallback.
const LEGACY_PROJECT_CONFIG_DIRNAME: &str = ".bb-agent";
const PRIMARY_PROJECT_SETTINGS_DIRNAME: &str = ".kordi";
const SETTINGS_FILENAME: &str = "settings.json";
const AGENTS_MD_FILENAME: &str = "AGENTS.md";
const SESSIONS_DB_FILENAME: &str = "sessions.db";
const AUTH_FILENAME: &str = "auth.json";
const ARTIFACTS_DIRNAME: &str = "artifacts";
const UPDATE_CHECK_FILENAME: &str = "update-check.json";
const REQUEST_METRICS_FILENAME: &str = "request-metrics.jsonl";
const TUI_DEBUG_LOG_FILENAME: &str = "tui-debug.log";
const SYSTEM_PROMPTS_DIRNAME: &str = "system-prompts";
const SKILLS_DIRNAME: &str = "skills";
const EXTENSIONS_DIRNAME: &str = "extensions";
const PROMPTS_DIRNAME: &str = "prompts";
const AGENTS_DIRNAME: &str = "agents";
const NPM_PACKAGES_DIRNAME: &str = "npm";
const GIT_PACKAGES_DIRNAME: &str = "git";
const APP_DATA_DIR_ENV_VAR: &str = "APP_DATA_DIR";
const KORDI_STORAGE_ROOT_ENV_VAR: &str = "KORDI_STORAGE_ROOT";
const KORDI_AUTH_PATH_ENV_VAR: &str = "KORDI_AUTH_PATH";

/// Resolve the legacy global agent resource directory.
///
/// This remains the default root for older prompt/package/extension lookup
/// call sites until those are migrated to explicit Kordi-branded helpers.
pub fn global_dir() -> PathBuf {
    if let Some(root) = process_storage_root() {
        return root.join(LEGACY_PROJECT_CONFIG_DIRNAME);
    }

    if let Some(home) = home_dir() {
        home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
    } else {
        PathBuf::from(LEGACY_PROJECT_CONFIG_DIRNAME)
    }
}

/// Resolve the preferred Kordi global settings/storage directory.
pub fn preferred_global_settings_dir() -> PathBuf {
    if let Some(root) = process_storage_root() {
        return root;
    }

    if let Some(home) = home_dir() {
        home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
    } else {
        PathBuf::from(PRIMARY_PROJECT_SETTINGS_DIRNAME)
    }
}

/// Resolve the preferred Kordi global settings path.
pub fn preferred_global_settings_path() -> PathBuf {
    preferred_global_settings_dir().join(SETTINGS_FILENAME)
}

/// Resolve the effective global settings path.
///
/// Prefers the new Kordi path when present, falls back to the legacy agent
/// settings path, and otherwise returns the new Kordi default path.
pub fn global_settings_path() -> PathBuf {
    choose_existing_path(
        preferred_global_settings_path(),
        global_dir().join(SETTINGS_FILENAME),
    )
}

/// Find the effective project root for `start` by walking ancestors.
///
/// Markers include common repository files (`.git`, `Cargo.toml`, `package.json`, etc.)
/// plus explicit project-local `.kordi/settings.json` or legacy project
/// settings files.
///
/// The global home-level settings files are intentionally *not* treated as a
/// project marker, so running inside a subdirectory of `$HOME` does not
/// accidentally load global settings as project settings.
pub fn project_root(start: &Path) -> Option<PathBuf> {
    let start = normalize_path(start);
    let home = home_dir().map(|path| normalize_path(&path));

    for dir in start.ancestors() {
        if has_project_marker(dir, home.as_deref()) {
            return Some(dir.to_path_buf());
        }
    }
    None
}

/// Resolve the legacy project-local agent resource directory using the
/// discovered project root when possible.
/// Falls back to the provided `cwd` if no project root markers are found.
pub fn project_dir(cwd: &Path) -> PathBuf {
    project_root(cwd)
        .unwrap_or_else(|| normalize_path(cwd))
        .join(LEGACY_PROJECT_CONFIG_DIRNAME)
}

/// Resolve the preferred Kordi project-local settings directory using the
/// discovered project root when possible.
/// Falls back to the provided `cwd` if no project root markers are found.
pub fn preferred_project_settings_dir(cwd: &Path) -> PathBuf {
    project_root(cwd)
        .unwrap_or_else(|| normalize_path(cwd))
        .join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
}

/// Resolve the preferred Kordi project-local settings path.
pub fn preferred_project_settings_path(cwd: &Path) -> PathBuf {
    preferred_project_settings_dir(cwd).join(SETTINGS_FILENAME)
}

/// Resolve the effective project-local settings path.
///
/// Prefers the new Kordi path when present, falls back to the legacy project
/// settings path, and otherwise returns the new Kordi default path.
pub fn project_settings_path(cwd: &Path) -> PathBuf {
    choose_existing_path(
        preferred_project_settings_path(cwd),
        project_dir(cwd).join(SETTINGS_FILENAME),
    )
}

/// Resolve a preferred global resource directory under `~/.kordi/`.
pub fn preferred_global_resource_dir(name: &str) -> PathBuf {
    preferred_global_settings_dir().join(name)
}

/// Resolve candidate global resource directories in preferred-first order.
pub fn global_resource_dir_candidates(name: &str) -> Vec<PathBuf> {
    unique_paths([preferred_global_resource_dir(name), global_dir().join(name)])
}

/// Resolve a preferred project-local resource directory under `.kordi/`.
pub fn preferred_project_resource_dir(cwd: &Path, name: &str) -> PathBuf {
    preferred_project_settings_dir(cwd).join(name)
}

/// Resolve candidate project-local resource directories in preferred-first order.
pub fn project_resource_dir_candidates(cwd: &Path, name: &str) -> Vec<PathBuf> {
    unique_paths([
        preferred_project_resource_dir(cwd, name),
        project_dir(cwd).join(name),
    ])
}

/// Resolve the effective global AGENTS.md path.
pub fn global_agents_md_path() -> PathBuf {
    choose_existing_path(
        preferred_global_settings_dir().join(AGENTS_MD_FILENAME),
        global_dir().join(AGENTS_MD_FILENAME),
    )
}

/// Resolve the preferred shaped-agent storage directory under `~/.kordi/agents`.
pub fn preferred_global_agents_dir() -> PathBuf {
    preferred_global_settings_dir().join(AGENTS_DIRNAME)
}

/// Resolve the effective shaped-agent storage directory.
pub fn global_agents_dir() -> PathBuf {
    choose_existing_path(
        preferred_global_agents_dir(),
        global_dir().join(AGENTS_DIRNAME),
    )
}

/// Migrate legacy global config/resources into `~/.kordi` when the new
/// target does not already exist.
pub fn migrate_legacy_global_config() -> std::io::Result<()> {
    for (preferred, legacy) in [
        (
            preferred_global_settings_path(),
            global_dir().join(SETTINGS_FILENAME),
        ),
        (
            preferred_global_settings_dir().join(AGENTS_MD_FILENAME),
            global_dir().join(AGENTS_MD_FILENAME),
        ),
        (
            preferred_global_resource_dir(SYSTEM_PROMPTS_DIRNAME),
            global_dir().join(SYSTEM_PROMPTS_DIRNAME),
        ),
        (
            preferred_global_resource_dir(SKILLS_DIRNAME),
            global_dir().join(SKILLS_DIRNAME),
        ),
        (
            preferred_global_resource_dir(EXTENSIONS_DIRNAME),
            global_dir().join(EXTENSIONS_DIRNAME),
        ),
        (
            preferred_global_resource_dir(PROMPTS_DIRNAME),
            global_dir().join(PROMPTS_DIRNAME),
        ),
        (
            preferred_global_agents_dir(),
            global_dir().join(AGENTS_DIRNAME),
        ),
        (
            preferred_global_resource_dir(NPM_PACKAGES_DIRNAME),
            global_dir().join(NPM_PACKAGES_DIRNAME),
        ),
        (
            preferred_global_resource_dir(GIT_PACKAGES_DIRNAME),
            global_dir().join(GIT_PACKAGES_DIRNAME),
        ),
    ] {
        migrate_path_if_needed(&preferred, &legacy)?;
    }
    Ok(())
}

/// Migrate legacy project-local config/resources into `.kordi` when the new
/// target does not already exist.
pub fn migrate_legacy_project_config(cwd: &Path) -> std::io::Result<()> {
    for (preferred, legacy) in [
        (
            preferred_project_settings_path(cwd),
            project_dir(cwd).join(SETTINGS_FILENAME),
        ),
        (
            preferred_project_resource_dir(cwd, SKILLS_DIRNAME),
            project_dir(cwd).join(SKILLS_DIRNAME),
        ),
        (
            preferred_project_resource_dir(cwd, EXTENSIONS_DIRNAME),
            project_dir(cwd).join(EXTENSIONS_DIRNAME),
        ),
        (
            preferred_project_resource_dir(cwd, PROMPTS_DIRNAME),
            project_dir(cwd).join(PROMPTS_DIRNAME),
        ),
        (
            preferred_project_resource_dir(cwd, NPM_PACKAGES_DIRNAME),
            project_dir(cwd).join(NPM_PACKAGES_DIRNAME),
        ),
        (
            preferred_project_resource_dir(cwd, GIT_PACKAGES_DIRNAME),
            project_dir(cwd).join(GIT_PACKAGES_DIRNAME),
        ),
    ] {
        migrate_path_if_needed(&preferred, &legacy)?;
    }
    Ok(())
}

/// Migrate legacy runtime/storage files into the resolved storage root when
/// the new target does not already exist.
pub fn migrate_legacy_global_storage(storage: &StorageSettings) -> std::io::Result<()> {
    for (preferred, legacy) in [
        (
            preferred_session_db_path(storage),
            global_dir().join(SESSIONS_DB_FILENAME),
        ),
        (
            preferred_auth_path(storage),
            global_dir().join(AUTH_FILENAME),
        ),
        (
            preferred_artifacts_dir(storage),
            global_dir().join(ARTIFACTS_DIRNAME),
        ),
        (
            preferred_update_check_cache_path(storage),
            global_dir().join(UPDATE_CHECK_FILENAME),
        ),
        (
            preferred_request_metrics_log_path(storage),
            global_dir().join(REQUEST_METRICS_FILENAME),
        ),
        (
            preferred_tui_debug_log_path(storage),
            global_dir().join(TUI_DEBUG_LOG_FILENAME),
        ),
    ] {
        migrate_path_if_needed(&preferred, &legacy)?;
    }
    Ok(())
}

/// Resolve the effective session database path.
pub fn session_db_path(storage: &StorageSettings) -> PathBuf {
    if storage.db_path.is_some() || configured_storage_root(storage).is_some() {
        return preferred_session_db_path(storage);
    }
    choose_existing_path(
        preferred_session_db_path(storage),
        global_dir().join(SESSIONS_DB_FILENAME),
    )
}

/// Resolve the effective artifact storage directory.
pub fn artifacts_dir(storage: &StorageSettings) -> PathBuf {
    if storage.artifacts_dir.is_some() || configured_storage_root(storage).is_some() {
        return preferred_artifacts_dir(storage);
    }
    choose_existing_path(
        preferred_artifacts_dir(storage),
        global_dir().join(ARTIFACTS_DIRNAME),
    )
}

/// Resolve the effective auth store path.
pub fn auth_path(storage: &StorageSettings) -> PathBuf {
    if let Some(auth_path) = process_auth_path() {
        return auth_path;
    }
    if configured_storage_root(storage).is_some() {
        return preferred_auth_path(storage);
    }
    choose_existing_path(
        preferred_auth_path(storage),
        global_dir().join(AUTH_FILENAME),
    )
}

/// Resolve the effective update-check cache path.
pub fn update_check_cache_path(storage: &StorageSettings) -> PathBuf {
    if configured_storage_root(storage).is_some() {
        return preferred_update_check_cache_path(storage);
    }
    choose_existing_path(
        preferred_update_check_cache_path(storage),
        global_dir().join(UPDATE_CHECK_FILENAME),
    )
}

/// Resolve the effective request-metrics log path.
pub fn request_metrics_log_path(storage: &StorageSettings) -> PathBuf {
    if configured_storage_root(storage).is_some() {
        return preferred_request_metrics_log_path(storage);
    }
    choose_existing_path(
        preferred_request_metrics_log_path(storage),
        global_dir().join(REQUEST_METRICS_FILENAME),
    )
}

/// Resolve the effective TUI debug log path.
pub fn tui_debug_log_path(storage: &StorageSettings) -> PathBuf {
    if configured_storage_root(storage).is_some() {
        return preferred_tui_debug_log_path(storage);
    }
    choose_existing_path(
        preferred_tui_debug_log_path(storage),
        global_dir().join(TUI_DEBUG_LOG_FILENAME),
    )
}

fn preferred_session_db_path(storage: &StorageSettings) -> PathBuf {
    if let Some(root) = process_storage_root() {
        return root.join(SESSIONS_DB_FILENAME);
    }

    storage
        .db_path
        .as_deref()
        .map(expand_user_path)
        .unwrap_or_else(|| preferred_storage_root(storage).join(SESSIONS_DB_FILENAME))
}

fn preferred_artifacts_dir(storage: &StorageSettings) -> PathBuf {
    if let Some(root) = process_storage_root() {
        return root.join(ARTIFACTS_DIRNAME);
    }

    storage
        .artifacts_dir
        .as_deref()
        .map(expand_user_path)
        .unwrap_or_else(|| preferred_storage_root(storage).join(ARTIFACTS_DIRNAME))
}

fn preferred_auth_path(storage: &StorageSettings) -> PathBuf {
    preferred_storage_root(storage).join(AUTH_FILENAME)
}

fn preferred_update_check_cache_path(storage: &StorageSettings) -> PathBuf {
    preferred_storage_root(storage).join(UPDATE_CHECK_FILENAME)
}

fn preferred_request_metrics_log_path(storage: &StorageSettings) -> PathBuf {
    preferred_storage_root(storage).join(REQUEST_METRICS_FILENAME)
}

fn preferred_tui_debug_log_path(storage: &StorageSettings) -> PathBuf {
    preferred_storage_root(storage).join(TUI_DEBUG_LOG_FILENAME)
}

fn configured_storage_root(storage: &StorageSettings) -> Option<PathBuf> {
    process_storage_root().or_else(|| storage.root_dir.as_deref().map(expand_user_path))
}

fn preferred_storage_root(storage: &StorageSettings) -> PathBuf {
    configured_storage_root(storage).unwrap_or_else(preferred_global_settings_dir)
}

fn process_storage_root() -> Option<PathBuf> {
    std::env::var_os(KORDI_STORAGE_ROOT_ENV_VAR)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(APP_DATA_DIR_ENV_VAR)
                .map(PathBuf::from)
                .map(|path| path.join(PRIMARY_PROJECT_SETTINGS_DIRNAME.trim_start_matches('.')))
        })
}

fn process_auth_path() -> Option<PathBuf> {
    std::env::var(KORDI_AUTH_PATH_ENV_VAR)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| expand_user_path(&value))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn normalize_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn unique_paths<const N: usize>(paths: [PathBuf; N]) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.iter().any(|existing| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

fn migrate_path_if_needed(preferred: &Path, legacy: &Path) -> std::io::Result<()> {
    if preferred == legacy || preferred.exists() || !legacy.exists() {
        return Ok(());
    }
    if let Some(parent) = preferred.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(legacy, preferred)
}

fn choose_existing_path(primary: PathBuf, legacy: PathBuf) -> PathBuf {
    if primary.exists() {
        primary
    } else if legacy.exists() {
        legacy
    } else {
        primary
    }
}

fn has_project_marker(dir: &Path, home: Option<&Path>) -> bool {
    if PROJECT_ROOT_MARKERS
        .iter()
        .any(|marker| dir.join(marker).exists())
    {
        return true;
    }

    for settings_path in [
        dir.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
            .join(SETTINGS_FILENAME),
        dir.join(LEGACY_PROJECT_CONFIG_DIRNAME)
            .join(SETTINGS_FILENAME),
    ] {
        if settings_path.exists() {
            if let Some(home) = home
                && dir == home
            {
                continue;
            }
            return true;
        }
    }

    false
}

fn expand_user_path(raw: &str) -> PathBuf {
    if raw == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(raw));
    }
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

/// Serializes tests that mutate process environment variables such as
/// `HOME` or `KORDI_STORAGE_ROOT`.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

#[cfg(test)]
mod tests;
