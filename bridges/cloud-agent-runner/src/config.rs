pub fn canary_idle_enabled(value: Option<&str>) -> bool {
    env_flag_enabled(value)
}

/// Parses an operator on/off switch. Anything other than an explicit truthy
/// value, including an unset variable, is off.
pub fn env_flag_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Marks the runner process as not dumpable, so other processes, including
/// ones that run as the same user, need `CAP_SYS_PTRACE` to read its
/// environment or memory through `/proc`. Container runtimes do not grant that
/// capability by default. It also disables core dumps of the runner.
#[cfg(target_os = "linux")]
pub fn keep_process_memory_private() -> std::io::Result<()> {
    // SAFETY: `PR_SET_DUMPABLE` takes one integer argument and changes only
    // this process's dumpable flag.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Only Linux exposes another process's environment through `/proc` in a
/// way this switch controls; elsewhere there is nothing to change.
#[cfg(not(target_os = "linux"))]
pub fn keep_process_memory_private() -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::canary_idle_enabled;

    #[cfg(target_os = "linux")]
    #[test]
    fn the_runner_process_is_not_dumpable() {
        super::keep_process_memory_private().unwrap();
        // SAFETY: `PR_GET_DUMPABLE` only reads this process's flag.
        assert_eq!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) }, 0);
    }

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
}
