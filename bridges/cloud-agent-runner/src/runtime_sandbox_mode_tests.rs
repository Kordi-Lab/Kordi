//! Which sandbox backend a runner may use.

use super::*;

#[test]
fn local_sandbox_requires_the_development_opt_in() {
    for backend in [None, Some(""), Some("local"), Some(" LOCAL ")] {
        for opt_in in [None, Some(""), Some("0"), Some("false"), Some("no")] {
            assert_eq!(
                sandbox_backend_mode(backend, opt_in),
                Err("local_sandbox_not_enabled"),
                "{backend:?} {opt_in:?}"
            );
        }
        for opt_in in [Some("1"), Some("true"), Some(" yes ")] {
            assert_eq!(
                sandbox_backend_mode(backend, opt_in),
                Ok(SandboxBackendMode::Local),
                "{backend:?} {opt_in:?}"
            );
        }
    }
}

#[test]
fn k8s_sandbox_needs_no_opt_in_and_unknown_backends_fail_closed() {
    assert_eq!(
        sandbox_backend_mode(Some("k8s"), None),
        Ok(SandboxBackendMode::K8s)
    );
    assert_eq!(
        sandbox_backend_mode(Some(" K8S "), Some("1")),
        Ok(SandboxBackendMode::K8s)
    );
    for backend in ["docker", "host", "none"] {
        assert_eq!(
            sandbox_backend_mode(Some(backend), Some("1")),
            Err("unsupported_sandbox_backend")
        );
    }
}

#[test]
fn a_refused_local_backend_selects_no_sandbox_for_a_run() {
    let run = leased_run("car_local_refused", true);
    let refused = sandbox_backend_for_mode(sandbox_backend_mode(None, None), &run, temp_sandbox());
    assert_eq!(refused.err(), Some("local_sandbox_not_enabled"));

    let root = std::env::temp_dir().join(format!(
        "kordi-runtime-local-opt-in-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let allowed = sandbox_backend_for_mode(
        sandbox_backend_mode(Some("local"), Some("1")),
        &run,
        root.clone(),
    )
    .unwrap();
    assert_eq!(
        allowed.root_for_tests(),
        Some(root.join("cas_test").as_path())
    );
}
