// Keep this numeric contract aligned with the desktop client and release publisher.
// A missing patch component is zero; ambiguous, unbounded, and noncanonical input fails closed.
pub(super) fn parse_system_version(value: &str) -> Option<[u16; 3]> {
    if value.len() > 17 {
        return None;
    }
    let mut version = [0; 3];
    let mut count = 0;
    for component in value.split('.') {
        if count == 3
            || component.is_empty()
            || !component.bytes().all(|byte| byte.is_ascii_digit())
            || (component.len() > 1 && component.starts_with('0'))
        {
            return None;
        }
        version[count] = component.parse().ok()?;
        count += 1;
    }
    (count >= 2 && version[0] > 0).then_some(version)
}

#[cfg(test)]
mod tests {
    use super::parse_system_version;

    #[test]
    fn parses_only_bounded_canonical_system_versions() {
        for (input, expected) in [
            ("13.0", [13, 0, 0]),
            ("13.2.1", [13, 2, 1]),
            ("65535.65535.65535", [65535; 3]),
        ] {
            assert_eq!(parse_system_version(input), Some(expected));
        }
        for invalid in [
            "",
            "13",
            "13.",
            "0.0",
            "013.0",
            "13.00",
            "13.0.0.0",
            "13.0-beta",
            "13.0+1",
            "13.0 ",
            " 13.0",
            "+13.0",
            "65536.0",
            "13.65536",
            "13.0.65536",
            "13.０",
            "13.0,14.0",
            "unknown",
        ] {
            assert_eq!(parse_system_version(invalid), None, "{invalid}");
        }
    }
}
