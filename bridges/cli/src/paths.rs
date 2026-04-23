use std::path::PathBuf;

const APP_DATA_DIR_ENV_VAR: &str = "APP_DATA_DIR";
const BRIDGES_HOME_ENV_VAR: &str = "BRIDGES_HOME";
const BRIDGES_PROJECTS_DIR_ENV_VAR: &str = "BRIDGES_PROJECTS_DIR";

pub fn bridges_home_dir() -> Option<PathBuf> {
    std::env::var_os(BRIDGES_HOME_ENV_VAR)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(APP_DATA_DIR_ENV_VAR)
                .map(PathBuf::from)
                .map(|path| path.join("bridges"))
        })
        .or_else(|| directories::BaseDirs::new().map(|base| base.home_dir().join(".bridges")))
}

pub fn bridges_projects_root() -> Option<PathBuf> {
    std::env::var_os(BRIDGES_PROJECTS_DIR_ENV_VAR)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(APP_DATA_DIR_ENV_VAR)
                .map(PathBuf::from)
                .map(|path| path.join("bridges-projects"))
        })
        .or_else(|| {
            directories::BaseDirs::new().map(|base| base.home_dir().join("bridges-projects"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Mutex, OnceLock};
    use uuid::Uuid;

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

    fn make_temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bridges-paths-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn app_data_dir_overrides_bridges_home_and_projects_root() {
        let _lock = env_lock().lock().unwrap();
        let app_data_dir = make_temp_dir();
        let _app_data_dir = EnvGuard::set(APP_DATA_DIR_ENV_VAR, app_data_dir.to_str().unwrap());

        assert_eq!(bridges_home_dir(), Some(app_data_dir.join("bridges")));
        assert_eq!(
            bridges_projects_root(),
            Some(app_data_dir.join("bridges-projects"))
        );

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn explicit_bridges_home_override_wins() {
        let _lock = env_lock().lock().unwrap();
        let app_data_dir = make_temp_dir();
        let bridges_home = make_temp_dir();
        let _app_data_dir = EnvGuard::set(APP_DATA_DIR_ENV_VAR, app_data_dir.to_str().unwrap());
        let _bridges_home = EnvGuard::set(BRIDGES_HOME_ENV_VAR, bridges_home.to_str().unwrap());

        assert_eq!(bridges_home_dir(), Some(bridges_home.clone()));

        let _ = fs::remove_dir_all(app_data_dir);
        let _ = fs::remove_dir_all(bridges_home);
    }
}
