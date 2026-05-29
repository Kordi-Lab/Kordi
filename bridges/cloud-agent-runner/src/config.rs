pub fn canary_idle_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[cfg(test)]
mod tests {
    use super::canary_idle_enabled;

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
