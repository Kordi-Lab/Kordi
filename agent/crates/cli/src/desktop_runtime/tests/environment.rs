fn env_lock() -> &'static Mutex<()> {
    crate::login::auth_test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set_value(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn unset(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::remove_var(key) };
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old {
            unsafe { std::env::set_var(self.key, value) };
        } else {
            unsafe { std::env::remove_var(self.key) };
        }
    }
}
