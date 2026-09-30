use super::super::tests::with_isolated_app_data_dir;
use super::super::{DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME};
use super::*;

#[derive(Default)]
struct MemoryKeychain {
    values: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
    fail_writes: bool,
}

impl MemoryKeychain {
    fn value(&self, service: &str, account_id: &str) -> Option<String> {
        self.values
            .lock()
            .unwrap()
            .get(&(service.to_string(), account_id.to_string()))
            .cloned()
    }
}

impl SecretKeychain for MemoryKeychain {
    fn get(&self, service: &str, account_id: &str) -> Result<Option<String>, String> {
        Ok(self.value(service, account_id))
    }

    fn set(&self, service: &str, account_id: &str, value: &str) -> Result<(), String> {
        if self.fail_writes {
            return Err("keychain_write_failed: locked".to_string());
        }
        self.values.lock().unwrap().insert(
            (service.to_string(), account_id.to_string()),
            value.to_string(),
        );
        Ok(())
    }

    fn delete(&self, service: &str, account_id: &str) -> Result<(), String> {
        self.values
            .lock()
            .unwrap()
            .remove(&(service.to_string(), account_id.to_string()));
        Ok(())
    }
}

fn write_legacy_plaintext_secret(path: &Path, value: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}

fn legacy_file_of(location: &SecretLocation) -> &Path {
    match location {
        SecretLocation::Keychain {
            legacy_file: Some(legacy_file),
        } => legacy_file,
        other => panic!("expected a keychain location with a legacy file: {other:?}"),
    }
}

#[test]
fn isolated_profiles_use_their_own_keychain_items() {
    assert_eq!(keychain_profile_scope("io.kordi.cloud"), None);
    assert_eq!(keychain_profile_scope("io.kordi.desktop"), None);
    assert_eq!(keychain_profile_scope("io.kordi.cloud."), None);
    assert_eq!(
        keychain_profile_scope("io.kordi.cloud.feature-b").as_deref(),
        Some("profile.feature-b")
    );
    with_isolated_app_data_dir(|_| {
        // The helper sets APP_INSTANCE_ID=user2.
        assert_eq!(
            keychain_service_name(KEYCHAIN_SERVICE, None),
            "com.kordi.cloud-session.user2"
        );
        assert_eq!(
            keychain_service_name(KEYCHAIN_SERVICE, Some("profile.feature-b")),
            "com.kordi.cloud-session.user2.profile.feature-b"
        );
    });
}

#[test]
fn release_builds_select_the_keychain_even_when_app_data_dir_is_set() {
    with_isolated_app_data_dir(|dir| {
        let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
        let legacy_file = legacy_file_of(&location);
        assert!(legacy_file.starts_with(dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME)));

        assert!(matches!(
            secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, true),
            SecretLocation::DevFile(_)
        ));
    });
}

#[test]
fn release_store_writes_only_to_the_keychain() {
    with_isolated_app_data_dir(|dir| {
        let keychain = MemoryKeychain::default();
        let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);

        secret_store_at(
            &keychain,
            &location,
            KEYCHAIN_SERVICE,
            KEYCHAIN_USERNAME,
            "session-json",
        )
        .unwrap();

        assert_eq!(
            keychain
                .value(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                .as_deref(),
            Some("session-json")
        );
        assert!(!dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME).exists());
    });
}

#[test]
fn release_load_moves_a_legacy_plaintext_secret_into_the_keychain() {
    with_isolated_app_data_dir(|_| {
        let keychain = MemoryKeychain::default();
        keychain
            .set(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, "older-keychain-value")
            .unwrap();
        let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
        let legacy_file = legacy_file_of(&location);
        write_legacy_plaintext_secret(legacy_file, "file-session-json");

        let loaded =
            secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();

        assert_eq!(loaded.as_deref(), Some("file-session-json"));
        assert_eq!(
            keychain
                .value(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                .as_deref(),
            Some("file-session-json")
        );
        assert!(!legacy_file.exists(), "plaintext secret must be removed");

        let reloaded =
            secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();
        assert_eq!(reloaded.as_deref(), Some("file-session-json"));
    });
}

#[test]
fn release_load_keeps_the_plaintext_secret_when_the_keychain_is_unavailable() {
    with_isolated_app_data_dir(|_| {
        let keychain = MemoryKeychain {
            fail_writes: true,
            ..MemoryKeychain::default()
        };
        let location = secret_location(DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
        let legacy_file = legacy_file_of(&location);
        write_legacy_plaintext_secret(legacy_file, "device-identity-json");

        let loaded = secret_load_at(
            &keychain,
            &location,
            DEVICE_IDENTITY_KEYCHAIN_SERVICE,
            KEYCHAIN_USERNAME,
        )
        .unwrap();

        assert_eq!(loaded.as_deref(), Some("device-identity-json"));
        assert!(legacy_file.exists(), "the only copy must not be deleted");
    });
}

#[test]
fn release_store_and_delete_remove_legacy_plaintext_secrets() {
    with_isolated_app_data_dir(|_| {
        let keychain = MemoryKeychain::default();
        let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
        let legacy_file = legacy_file_of(&location);

        write_legacy_plaintext_secret(legacy_file, "stale");
        secret_store_at(
            &keychain,
            &location,
            KEYCHAIN_SERVICE,
            KEYCHAIN_USERNAME,
            "fresh",
        )
        .unwrap();
        assert!(!legacy_file.exists());
        assert_eq!(
            secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                .unwrap()
                .as_deref(),
            Some("fresh")
        );

        write_legacy_plaintext_secret(legacy_file, "stale");
        secret_delete_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();
        assert!(!legacy_file.exists());
        assert_eq!(
            secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap(),
            None
        );
    });
}

#[cfg(unix)]
#[test]
fn development_secret_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    with_isolated_app_data_dir(|_| {
        let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, true);
        let SecretLocation::DevFile(path) = &location else {
            panic!("expected development file location");
        };
        // A file left by an earlier development build with default permissions.
        write_legacy_plaintext_secret(path, "old");
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();

        secret_store_at(
            &MemoryKeychain::default(),
            &location,
            KEYCHAIN_SERVICE,
            KEYCHAIN_USERNAME,
            "session-json",
        )
        .unwrap();

        let file_mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
        assert_eq!(dir_mode, 0o700);
        assert_eq!(fs::read_to_string(path).unwrap(), "session-json");
    });
}
