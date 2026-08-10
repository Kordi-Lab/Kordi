pub fn canary_idle_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendMode {
    Local,
    K8s,
}

pub fn sandbox_backend_mode(value: Option<&str>) -> SandboxBackendMode {
    match value {
        Some(value) if value.trim().eq_ignore_ascii_case("k8s") => SandboxBackendMode::K8s,
        _ => SandboxBackendMode::Local,
    }
}

pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode {
    sandbox_backend_mode(std::env::var("KORDI_CLOUD_SANDBOX_BACKEND").ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::{canary_idle_enabled, sandbox_backend_mode, SandboxBackendMode};

    #[test]
    fn canary_idle_is_disabled_by_default() {
        assert!(!canary_idle_enabled(None));
        assert!(!canary_idle_enabled(Some("")));
        assert!(!canary_idle_enabled(Some("0")));
        assert!(!canary_idle_enabled(Some("false")));
    }

    #[test]
    fn canary_idle_accepts_operator_truthy_values() {
        assert!(canary_idle_enabled(Some("1")));
        assert!(canary_idle_enabled(Some("true")));
        assert!(canary_idle_enabled(Some("YES")));
        assert!(canary_idle_enabled(Some(" on ")));
    }

    #[test]
    fn sandbox_backend_selection_defaults_to_local() {
        assert_eq!(sandbox_backend_mode(None), SandboxBackendMode::Local);
        assert_eq!(
            sandbox_backend_mode(Some("local")),
            SandboxBackendMode::Local
        );
        assert_eq!(sandbox_backend_mode(Some(" k8s ")), SandboxBackendMode::K8s);
    }
}
