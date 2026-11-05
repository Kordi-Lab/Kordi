use crate::client::CloudAgentRun;
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendMode {
    Local,
    K8s,
    Fly,
    Invalid,
}

/// True for release images compiled for the isolated development stack with
/// `KORDI_DEVELOPMENT_BUILD=1`. Hosted release images never set it, so they
/// keep refusing the local sandbox backend.
fn development_build_marker() -> bool {
    matches!(option_env!("KORDI_DEVELOPMENT_BUILD"), Some("1"))
}

pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode {
    sandbox_backend_mode(
        std::env::var("KORDI_CLOUD_SANDBOX_BACKEND").ok().as_deref(),
        cfg!(debug_assertions),
        development_build_marker(),
    )
}

/// An explicit `local` value runs host-local sandboxes only in debug builds or
/// development-marked release builds. An empty or unset value selects `local`
/// only in debug builds.
fn sandbox_backend_mode(
    value: Option<&str>,
    debug_build: bool,
    development_build: bool,
) -> SandboxBackendMode {
    match value.map(str::trim).unwrap_or_default() {
        value if value.eq_ignore_ascii_case("k8s") => SandboxBackendMode::K8s,
        value if value.eq_ignore_ascii_case("fly") => SandboxBackendMode::Fly,
        value if value.eq_ignore_ascii_case("local") && (debug_build || development_build) => {
            SandboxBackendMode::Local
        }
        "" if debug_build => SandboxBackendMode::Local,
        _ => SandboxBackendMode::Invalid,
    }
}

pub fn sandbox_backend_for_run(
    run: &CloudAgentRun,
    local_root: PathBuf,
) -> Result<SandboxBackendHandle, &'static str> {
    match sandbox_backend_mode_from_env() {
        SandboxBackendMode::Invalid => Err("invalid_sandbox_backend"),
        SandboxBackendMode::Fly => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            crate::fly_sandbox::FlySandboxBackend::from_env(sandbox_id)
                .map(|backend| std::sync::Arc::new(backend) as SandboxBackendHandle)
                .map_err(|_| "invalid_fly_sandbox_configuration")
        }
        SandboxBackendMode::Local => {
            let id = run.sandbox_id.as_deref().unwrap_or(&run.run_id);
            if id.is_empty()
                || !id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
            {
                return Err("invalid_sandbox_id");
            }
            Ok(std::sync::Arc::new(LocalSandboxBackend::new(
                local_root.join(id),
            )))
        }
        SandboxBackendMode::K8s => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            Ok(std::sync::Arc::new(K8sSandboxBackend::from_env(
                sandbox_id.to_string(),
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_sandbox_requires_a_debug_or_development_build() {
        use SandboxBackendMode::{Fly, Invalid, K8s, Local};
        let cases = [
            (Some(" Local "), false, true, Local),
            (Some("local"), true, false, Local),
            (Some("local"), false, false, Invalid),
            (None, false, true, Invalid),
            (Some(" "), false, false, Invalid),
            (Some("k8s"), false, false, K8s),
            (Some("FLY"), false, true, Fly),
            (Some("docker"), true, true, Invalid),
        ];
        for (value, debug, development, expected) in cases {
            assert_eq!(sandbox_backend_mode(value, debug, development), expected);
        }
    }
}
