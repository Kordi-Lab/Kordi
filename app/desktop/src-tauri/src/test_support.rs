#[cfg(test)]
use std::ffi::OsString;
#[cfg(test)]
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Mutex, MutexGuard};

#[cfg(test)]
static PROCESS_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_process_environment() -> MutexGuard<'static, ()> {
    PROCESS_ENV_LOCK
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

#[cfg(test)]
pub(crate) struct ScopedKordiStorageRoot {
    root: PathBuf,
    previous: Option<OsString>,
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl ScopedKordiStorageRoot {
    pub(crate) fn new(label: &str) -> Self {
        let guard = lock_process_environment();
        let root = std::env::temp_dir().join(format!(
            "{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let previous = std::env::var_os("KORDI_STORAGE_ROOT");
        std::env::set_var("KORDI_STORAGE_ROOT", &root);
        Self {
            root,
            previous,
            _guard: guard,
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
impl Drop for ScopedKordiStorageRoot {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("KORDI_STORAGE_ROOT", previous);
        } else {
            std::env::remove_var("KORDI_STORAGE_ROOT");
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Points `APP_DATA_DIR` at a fresh temporary directory for the lifetime of the
/// guard, so attachment storage and its access registry are isolated.
#[cfg(test)]
pub(crate) struct ScopedAppDataDir {
    root: PathBuf,
    previous: Option<OsString>,
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl ScopedAppDataDir {
    pub(crate) fn new(label: &str) -> Self {
        let guard = lock_process_environment();
        let root = std::env::temp_dir().join(format!(
            "{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create scoped app data dir");
        let previous = std::env::var_os("APP_DATA_DIR");
        std::env::set_var("APP_DATA_DIR", &root);
        Self {
            root,
            previous,
            _guard: guard,
        }
    }
}

#[cfg(test)]
impl Drop for ScopedAppDataDir {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("APP_DATA_DIR", previous);
        } else {
            std::env::remove_var("APP_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
