//! Memory settings parsing, merge, and global save regressions.

use super::*;
use std::fs;
use std::path::Path;
use uuid::Uuid;

fn make_temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kordi-settings-memory-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn test_memory_settings_round_trip() {
    let json = r#"{"memory":{"memory_enabled":false,"exclude_sensitive":true}}"#;
    let parsed = Settings::parse_result(json).expect("parse memory block");
    assert_eq!(
        parsed.memory,
        MemorySettings {
            memory_enabled: false,
            exclude_sensitive: true,
        }
    );
    let serialized = serde_json::to_value(&parsed).expect("serialize");
    assert_eq!(
        serialized["memory"],
        serde_json::json!({"memory_enabled": false, "exclude_sensitive": true})
    );
    let reparsed = Settings::parse_result(&serialized.to_string()).expect("reparse");
    assert_eq!(reparsed.memory, parsed.memory);

    let camel = Settings::parse_result(r#"{"memory":{"memoryEnabled":false}}"#).expect("camel");
    assert!(!camel.memory.memory_enabled);
    assert!(camel.memory.exclude_sensitive);
}

#[test]
fn test_memory_settings_default_when_absent() {
    let parsed = Settings::parse_result("{}").expect("parse empty");
    assert_eq!(parsed.memory, MemorySettings::default());
    assert!(parsed.memory.memory_enabled);
    assert!(parsed.memory.exclude_sensitive);
    assert!(Settings::default().memory.memory_enabled);
}

#[test]
fn test_memory_settings_merge_keeps_global_unless_project_sets_it() {
    let global = Settings {
        memory: MemorySettings {
            memory_enabled: false,
            exclude_sensitive: true,
        },
        ..Default::default()
    };
    let project = Settings::default();
    assert_eq!(Settings::merge(&global, &project).memory, global.memory);

    let project = Settings {
        memory: MemorySettings {
            memory_enabled: true,
            exclude_sensitive: false,
        },
        ..Default::default()
    };
    assert_eq!(Settings::merge(&global, &project).memory, project.memory);
}

struct StorageRootGuard {
    old: Option<std::ffi::OsString>,
}

impl StorageRootGuard {
    fn set(path: &Path) -> Self {
        let old = std::env::var_os("KORDI_STORAGE_ROOT");
        unsafe { std::env::set_var("KORDI_STORAGE_ROOT", path) };
        Self { old }
    }
}

impl Drop for StorageRootGuard {
    fn drop(&mut self) {
        match &self.old {
            Some(value) => unsafe { std::env::set_var("KORDI_STORAGE_ROOT", value) },
            None => unsafe { std::env::remove_var("KORDI_STORAGE_ROOT") },
        }
    }
}

#[test]
fn test_save_global_round_trip_and_update_memory() {
    let _lock = crate::config::test_env_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = make_temp_dir();
    let _storage = StorageRootGuard::set(&root);
    let path = crate::config::preferred_global_settings_path();
    assert!(path.starts_with(&root));

    let settings = Settings {
        default_provider: Some("anthropic".into()),
        ..Default::default()
    };
    settings.save_global().expect("save global");
    let loaded = Settings::load_from_file_result(&path).expect("load saved");
    assert_eq!(loaded.default_provider.as_deref(), Some("anthropic"));
    assert_eq!(loaded.memory, MemorySettings::default());

    let updated = Settings::update_global_memory(|memory| memory.memory_enabled = false)
        .expect("update memory");
    assert_eq!(
        updated,
        MemorySettings {
            memory_enabled: false,
            exclude_sensitive: true,
        }
    );
    let reloaded = Settings::load_from_file_result(&path).expect("reload");
    assert_eq!(reloaded.memory, updated);
    assert_eq!(reloaded.default_provider.as_deref(), Some("anthropic"));

    let leftovers = fs::read_dir(&root)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0);

    let _ = fs::remove_dir_all(root);
}
