//! Validation for URLs the desktop UI asks the operating system to open.
//!
//! Only web and mail links, plus the specific System Settings panes the app
//! links to, are handed to the system opener. Local files go through
//! `desktop_open_local_attachment`, which applies the attachment policy.

/// System Settings deep links the app uses (notification and calendar
/// privacy panes).
const SYSTEM_SETTINGS_SCHEME: &str = "x-apple.systempreferences";
const SYSTEM_SETTINGS_PREFIX: &str = "com.apple.";

pub(crate) fn validate_external_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("This link cannot be opened.".to_string());
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("This link cannot be opened.".to_string());
    }
    let url =
        reqwest::Url::parse(trimmed).map_err(|_| "This link cannot be opened.".to_string())?;
    let allowed = match url.scheme() {
        "https" | "http" => url.host_str().is_some_and(|host| !host.is_empty()),
        "mailto" => !url.path().is_empty(),
        SYSTEM_SETTINGS_SCHEME => url.path().starts_with(SYSTEM_SETTINGS_PREFIX),
        _ => false,
    };
    if !allowed {
        return Err("Kordi opens only web, email, and System Settings links.".to_string());
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn web_mail_and_settings_links_are_allowed() {
        for url in [
            "https://kordi.ai/updates",
            " http://example.com/a?b=c#d ",
            "mailto:support@example.com",
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        ] {
            assert!(validate_external_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn local_files_apps_and_other_schemes_are_refused() {
        for url in [
            "",
            "   ",
            "/Applications/Calculator.app",
            "file:///Applications/Calculator.app",
            "FILE:///etc/hosts",
            "-a Calculator",
            "--args",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/file",
            "smb://server/share",
            "vnc://host",
            "ssh://host",
            "x-apple.systempreferences:../../evil",
            "x-apple.systempreferences:",
            "https://",
            "https://example.com/a b",
            "https://example.com/\nsecond",
            "kordi://invite/abc",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url:?} should be refused"
            );
        }
    }

    #[test]
    fn allowed_links_are_normalized_before_opening() {
        assert_eq!(
            validate_external_url("HTTPS://Kordi.AI/path").unwrap(),
            "https://kordi.ai/path"
        );
    }
}
