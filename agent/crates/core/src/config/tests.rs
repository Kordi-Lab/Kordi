use super::*;
use std::fs;
use std::sync::Mutex;
use uuid::Uuid;

fn make_temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kordi-config-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn env_lock() -> &'static Mutex<()> {
    super::test_env_lock()
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
fn app_data_dir_override_is_used_for_global_storage() {
    let _lock = env_lock().lock().unwrap();
    let home = make_temp_dir();
    let app_data_dir = make_temp_dir();
    let _home = EnvGuard::set("HOME", home.to_str().unwrap());
    let _app_data_dir = EnvGuard::set(APP_DATA_DIR_ENV_VAR, app_data_dir.to_str().unwrap());

    assert_eq!(
        preferred_global_settings_dir(),
        app_data_dir.join(PRIMARY_PROJECT_SETTINGS_DIRNAME.trim_start_matches('.'))
    );
    assert_eq!(
        global_settings_path(),
        app_data_dir
            .join(PRIMARY_PROJECT_SETTINGS_DIRNAME.trim_start_matches('.'))
            .join(SETTINGS_FILENAME)
    );
    assert_eq!(
        global_dir(),
        app_data_dir
            .join(PRIMARY_PROJECT_SETTINGS_DIRNAME.trim_start_matches('.'))
            .join(LEGACY_PROJECT_CONFIG_DIRNAME)
    );

    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(app_data_dir);
}

#[test]
fn app_data_dir_override_wins_over_explicit_storage_paths() {
    let _lock = env_lock().lock().unwrap();
    let home = make_temp_dir();
    let app_data_dir = make_temp_dir();
    let _home = EnvGuard::set("HOME", home.to_str().unwrap());
    let _app_data_dir = EnvGuard::set(APP_DATA_DIR_ENV_VAR, app_data_dir.to_str().unwrap());
    let storage = StorageSettings {
        root_dir: Some("~/custom-kordi".to_string()),
        db_path: Some("~/custom-kordi/db.sqlite".to_string()),
        artifacts_dir: Some("~/custom-kordi/artifacts-out".to_string()),
    };

    let expected_root = app_data_dir.join(PRIMARY_PROJECT_SETTINGS_DIRNAME.trim_start_matches('.'));
    assert_eq!(
        session_db_path(&storage),
        expected_root.join(SESSIONS_DB_FILENAME)
    );
    assert_eq!(
        artifacts_dir(&storage),
        expected_root.join(ARTIFACTS_DIRNAME)
    );
    assert_eq!(auth_path(&storage), expected_root.join(AUTH_FILENAME));

    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(app_data_dir);
}

#[test]
fn auth_path_env_override_only_changes_auth_store_path() {
    let _lock = env_lock().lock().unwrap();
    let home = make_temp_dir();
    let storage_root = make_temp_dir();
    let auth_dir = make_temp_dir();
    let auth_file = auth_dir.join("shared-auth.json");
    let _home = EnvGuard::set("HOME", home.to_str().unwrap());
    let _storage_root = EnvGuard::set(KORDI_STORAGE_ROOT_ENV_VAR, storage_root.to_str().unwrap());
    let _auth_path = EnvGuard::set(KORDI_AUTH_PATH_ENV_VAR, auth_file.to_str().unwrap());

    let storage = StorageSettings::default();
    assert_eq!(
        session_db_path(&storage),
        storage_root.join(SESSIONS_DB_FILENAME)
    );
    assert_eq!(
        artifacts_dir(&storage),
        storage_root.join(ARTIFACTS_DIRNAME)
    );
    assert_eq!(auth_path(&storage), auth_file);

    let _ = fs::remove_dir_all(home);
    let _ = fs::remove_dir_all(storage_root);
    let _ = fs::remove_dir_all(auth_dir);
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
