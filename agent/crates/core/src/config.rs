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

/// Resolve the legacy global agent resource directory.
///
/// This remains the default root for older prompt/package/extension lookup
/// call sites until those are migrated to explicit Kordi-branded helpers.
pub fn global_dir() -> PathBuf {
    if let Some(home) = home_dir() {
        home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
    } else {
        PathBuf::from(LEGACY_PROJECT_CONFIG_DIRNAME)
    }
}

/// Resolve the preferred Kordi global settings/storage directory.
pub fn preferred_global_settings_dir() -> PathBuf {
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
    storage
        .db_path
        .as_deref()
        .map(expand_user_path)
        .unwrap_or_else(|| preferred_storage_root(storage).join(SESSIONS_DB_FILENAME))
}

fn preferred_artifacts_dir(storage: &StorageSettings) -> PathBuf {
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
    storage.root_dir.as_deref().map(expand_user_path)
}

fn preferred_storage_root(storage: &StorageSettings) -> PathBuf {
    configured_storage_root(storage).unwrap_or_else(preferred_global_settings_dir)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Mutex, OnceLock};
    use uuid::Uuid;

    fn make_temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kordi-config-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard {
        key: &'static str,
        old: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old = std::env::var(key).ok();
            unsafe { std::env::set_var(key, value) };
            Self { key, old }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old {
                unsafe { std::env::set_var(self.key, value) };
            } else {
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    #[test]
    fn project_root_finds_repo_marker_in_ancestor() {
        let root = make_temp_dir();
        fs::write(root.join("Cargo.toml"), "[package]\nname='demo'\n").unwrap();
        let nested = root.join("src").join("deep");
        fs::create_dir_all(&nested).unwrap();
        let normalized_root = normalize_path(&root);

        assert_eq!(
            project_root(&nested).as_deref(),
            Some(normalized_root.as_path())
        );
        assert_eq!(
            project_dir(&nested),
            normalized_root.join(LEGACY_PROJECT_CONFIG_DIRNAME)
        );
        assert_eq!(
            preferred_project_settings_dir(&nested),
            normalized_root.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_root_finds_kordi_settings_in_ancestor() {
        let root = make_temp_dir();
        fs::create_dir_all(root.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)).unwrap();
        fs::write(
            root.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME),
            "{}\n",
        )
        .unwrap();
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        let normalized_root = normalize_path(&root);

        assert_eq!(
            project_root(&nested).as_deref(),
            Some(normalized_root.as_path())
        );
        assert_eq!(
            project_settings_path(&nested),
            normalized_root
                .join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_root_finds_legacy_settings_in_ancestor() {
        let root = make_temp_dir();
        fs::create_dir_all(root.join(LEGACY_PROJECT_CONFIG_DIRNAME)).unwrap();
        fs::write(
            root.join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SETTINGS_FILENAME),
            "{}\n",
        )
        .unwrap();
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        let normalized_root = normalize_path(&root);

        assert_eq!(
            project_root(&nested).as_deref(),
            Some(normalized_root.as_path())
        );
        assert_eq!(
            project_settings_path(&nested),
            normalized_root
                .join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SETTINGS_FILENAME)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_settings_path_prefers_kordi_default_when_no_legacy_exists() {
        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());

        assert_eq!(
            preferred_global_settings_path(),
            home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME)
        );
        assert_eq!(
            global_settings_path(),
            home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME)
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn global_settings_path_falls_back_to_legacy_when_needed() {
        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());
        fs::create_dir_all(home.join(LEGACY_PROJECT_CONFIG_DIRNAME)).unwrap();
        fs::write(
            home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SETTINGS_FILENAME),
            "{}\n",
        )
        .unwrap();

        assert_eq!(
            global_settings_path(),
            home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SETTINGS_FILENAME)
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn storage_helpers_respect_explicit_overrides() {
        let storage = StorageSettings {
            root_dir: Some("~/custom-kordi".to_string()),
            db_path: Some("~/custom-kordi/db.sqlite".to_string()),
            artifacts_dir: Some("~/custom-kordi/artifacts-out".to_string()),
        };

        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());

        assert_eq!(
            session_db_path(&storage),
            home.join("custom-kordi").join("db.sqlite")
        );
        assert_eq!(
            artifacts_dir(&storage),
            home.join("custom-kordi").join("artifacts-out")
        );
        assert_eq!(
            auth_path(&storage),
            home.join("custom-kordi").join(AUTH_FILENAME)
        );
        assert_eq!(
            update_check_cache_path(&storage),
            home.join("custom-kordi").join(UPDATE_CHECK_FILENAME)
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn session_db_path_falls_back_to_legacy_db_when_present() {
        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());
        fs::create_dir_all(home.join(LEGACY_PROJECT_CONFIG_DIRNAME)).unwrap();
        fs::write(
            home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SESSIONS_DB_FILENAME),
            "db",
        )
        .unwrap();

        assert_eq!(
            session_db_path(&StorageSettings::default()),
            home.join(LEGACY_PROJECT_CONFIG_DIRNAME)
                .join(SESSIONS_DB_FILENAME)
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn migrate_legacy_global_config_moves_known_resources() {
        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());
        let legacy_dir = home.join(LEGACY_PROJECT_CONFIG_DIRNAME);
        fs::create_dir_all(legacy_dir.join(SKILLS_DIRNAME)).unwrap();
        fs::write(legacy_dir.join(SETTINGS_FILENAME), "{}\n").unwrap();
        fs::write(legacy_dir.join(AGENTS_MD_FILENAME), "# Global\n").unwrap();
        fs::write(legacy_dir.join(SKILLS_DIRNAME).join("demo.md"), "skill\n").unwrap();

        migrate_legacy_global_config().unwrap();

        assert!(
            home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME)
                .exists()
        );
        assert!(
            home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(AGENTS_MD_FILENAME)
                .exists()
        );
        assert!(
            home.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SKILLS_DIRNAME)
                .join("demo.md")
                .exists()
        );
        assert!(!legacy_dir.join(SETTINGS_FILENAME).exists());
        assert!(!legacy_dir.join(AGENTS_MD_FILENAME).exists());
        assert!(!legacy_dir.join(SKILLS_DIRNAME).exists());

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn migrate_legacy_project_config_moves_project_resources() {
        let root = make_temp_dir();
        fs::write(root.join("Cargo.toml"), "[package]\nname='demo'\n").unwrap();
        let nested = root.join("src").join("inner");
        fs::create_dir_all(&nested).unwrap();
        let legacy_dir = root.join(LEGACY_PROJECT_CONFIG_DIRNAME);
        fs::create_dir_all(legacy_dir.join(EXTENSIONS_DIRNAME)).unwrap();
        fs::write(legacy_dir.join(SETTINGS_FILENAME), "{}\n").unwrap();
        fs::write(
            legacy_dir.join(EXTENSIONS_DIRNAME).join("index.js"),
            "export default {};\n",
        )
        .unwrap();

        migrate_legacy_project_config(&nested).unwrap();

        assert!(
            root.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(SETTINGS_FILENAME)
                .exists()
        );
        assert!(
            root.join(PRIMARY_PROJECT_SETTINGS_DIRNAME)
                .join(EXTENSIONS_DIRNAME)
                .join("index.js")
                .exists()
        );
        assert!(!legacy_dir.join(SETTINGS_FILENAME).exists());
        assert!(!legacy_dir.join(EXTENSIONS_DIRNAME).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_legacy_global_storage_uses_configured_root() {
        let _lock = env_lock().lock().unwrap();
        let home = make_temp_dir();
        let _home = EnvGuard::set("HOME", home.to_str().unwrap());
        let legacy_dir = home.join(LEGACY_PROJECT_CONFIG_DIRNAME);
        fs::create_dir_all(legacy_dir.join(ARTIFACTS_DIRNAME)).unwrap();
        fs::write(legacy_dir.join(SESSIONS_DB_FILENAME), "db").unwrap();
        fs::write(legacy_dir.join(AUTH_FILENAME), "{}\n").unwrap();
        fs::write(
            legacy_dir.join(ARTIFACTS_DIRNAME).join("artifact.txt"),
            "hello\n",
        )
        .unwrap();
        fs::write(legacy_dir.join(UPDATE_CHECK_FILENAME), "{}\n").unwrap();
        fs::write(legacy_dir.join(REQUEST_METRICS_FILENAME), "metrics\n").unwrap();
        fs::write(legacy_dir.join(TUI_DEBUG_LOG_FILENAME), "debug\n").unwrap();

        let storage = StorageSettings {
            root_dir: Some("~/custom-kordi".to_string()),
            db_path: None,
            artifacts_dir: None,
        };
        migrate_legacy_global_storage(&storage).unwrap();

        let preferred_root = home.join("custom-kordi");
        assert!(preferred_root.join(SESSIONS_DB_FILENAME).exists());
        assert!(preferred_root.join(AUTH_FILENAME).exists());
        assert!(
            preferred_root
                .join(ARTIFACTS_DIRNAME)
                .join("artifact.txt")
                .exists()
        );
        assert!(preferred_root.join(UPDATE_CHECK_FILENAME).exists());
        assert!(preferred_root.join(REQUEST_METRICS_FILENAME).exists());
        assert!(preferred_root.join(TUI_DEBUG_LOG_FILENAME).exists());
        assert!(!legacy_dir.join(SESSIONS_DB_FILENAME).exists());
        assert!(!legacy_dir.join(AUTH_FILENAME).exists());
        assert!(!legacy_dir.join(ARTIFACTS_DIRNAME).exists());

        let _ = fs::remove_dir_all(home);
    }
}
