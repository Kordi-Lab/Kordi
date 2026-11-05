//! Narrow runtime configuration adapters. Authorization remains in the service implementations.

pub(crate) fn agent_persona<'a>(
    configured: Option<&'a str>,
    development: Option<&'a str>,
) -> Result<&'a str, &'static str> {
    let persona = configured
        .or(development)
        .ok_or("An ops agent persona is required")?;
    if persona.trim().is_empty() || persona.len() > 12_000 || persona.contains('\0') {
        return Err("Agent persona must contain between 1 and 12000 bytes of text");
    }
    Ok(persona)
}

/// True for debug builds and for release images compiled for the isolated
/// development stack with `KORDI_DEVELOPMENT_BUILD=1`. Hosted release images
/// never set it, so development-only options fail closed there.
pub(crate) fn development_build() -> bool {
    cfg!(debug_assertions) || matches!(option_env!("KORDI_DEVELOPMENT_BUILD"), Some("1"))
}

pub fn public_origin() -> String {
    let configured = std::env::var("KORDI_CLOUD_PUBLIC_BASE_URL").ok();
    let value = configured
        .as_deref()
        .or(development_origin())
        .expect("An ops public origin is required");
    validate_public_origin(value, cfg!(debug_assertions)).unwrap_or_else(|err| panic!("{err}"))
}

/// Check a configured public origin and return its serialized form.
///
/// Plain `http` is accepted for a loopback host (`127.0.0.1`, `localhost`,
/// `[::1]`), so a local release build behind no TLS proxy can start. Every
/// other host requires HTTPS, except in debug builds when `allow_any_http`
/// keeps existing development fixtures working.
pub(crate) fn validate_public_origin(
    value: &str,
    allow_any_http: bool,
) -> Result<String, &'static str> {
    let url = url::Url::parse(value).map_err(|_| "Invalid public origin")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return Err("Invalid public origin");
    }
    let secure = match url.scheme() {
        "https" => true,
        "http" => allow_any_http || is_loopback_host(&url),
        _ => false,
    };
    if !secure {
        return Err("Public origin requires HTTPS");
    }
    Ok(url.origin().ascii_serialization())
}

fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn development_origin() -> Option<&'static str> {
    // Compatibility for existing development fixtures only. Releases have no implicit assignment.
    #[cfg(debug_assertions)]
    {
        Some("https://kordi.ai")
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

pub fn callback_scheme() -> String {
    let configured = std::env::var("KORDI_CLIENT_CALLBACK_SCHEME").ok();
    match (configured.as_deref(), cfg!(debug_assertions)) {
        (None, true) => "kordi".to_string(),
        (value, _) => validate_callback_scheme(value).unwrap_or_else(|err| panic!("{err}")),
    }
}

fn validate_callback_scheme(value: Option<&str>) -> Result<String, &'static str> {
    match value {
        Some(value)
            if !value.is_empty()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') =>
        {
            Ok(value.to_string())
        }
        _ => Err("An ops client callback scheme is required"),
    }
}

/// The settings a release build needs before it serves anything, checked
/// with release rules regardless of how this binary was built. The binary
/// runs it at startup in release builds, and a test runs it against the
/// development compose environment.
pub fn check_release_startup(get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let mut problems = Vec::new();
    match get("KORDI_CLOUD_PUBLIC_BASE_URL") {
        Some(value) => {
            if let Err(err) = validate_public_origin(&value, false) {
                problems.push(format!("KORDI_CLOUD_PUBLIC_BASE_URL: {err}"));
            }
        }
        None => {
            problems.push("KORDI_CLOUD_PUBLIC_BASE_URL: An ops public origin is required".into())
        }
    }
    if let Err(err) = validate_callback_scheme(get("KORDI_CLIENT_CALLBACK_SCHEME").as_deref()) {
        problems.push(format!("KORDI_CLIENT_CALLBACK_SCHEME: {err}"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// Preserve existing debug/Beta defaults without assigning a release deployment policy.
pub(crate) const fn development_default(value: &'static str) -> &'static str {
    if cfg!(debug_assertions) {
        value
    } else {
        ""
    }
}

#[cfg(test)]
mod dev_compose_tests;

#[cfg(test)]
mod tests {
    use super::{agent_persona, validate_public_origin};

    #[test]
    fn release_origin_allows_http_only_on_loopback() {
        for origin in [
            "http://127.0.0.1:17081",
            "http://localhost:17081/",
            "http://LOCALHOST",
            "http://[::1]:8080",
        ] {
            assert!(validate_public_origin(origin, false).is_ok(), "{origin}");
        }
        assert_eq!(
            validate_public_origin("http://127.0.0.1:17081/", false).unwrap(),
            "http://127.0.0.1:17081"
        );
        for origin in [
            "http://example.test",
            "http://127.0.0.2:17081",
            "http://10.0.0.1",
            "http://localhost.example.test",
            "http://[::2]",
            "ftp://127.0.0.1",
            "ws://localhost",
        ] {
            assert_eq!(
                validate_public_origin(origin, false),
                Err("Public origin requires HTTPS"),
                "{origin}"
            );
        }
        assert_eq!(
            validate_public_origin("https://example.test", false).unwrap(),
            "https://example.test"
        );
    }

    #[test]
    fn origin_rejects_paths_credentials_and_queries() {
        for origin in [
            "https://example.test/app",
            "https://user@example.test",
            "https://example.test/?a=1",
            "https://example.test/#x",
            "http://user:pass@127.0.0.1",
            "not a url",
        ] {
            assert_eq!(
                validate_public_origin(origin, false),
                Err("Invalid public origin"),
                "{origin}"
            );
        }
    }

    #[test]
    fn release_startup_names_every_missing_setting() {
        use super::check_release_startup;
        let err = check_release_startup(|_| None).unwrap_err();
        assert!(err.contains("KORDI_CLOUD_PUBLIC_BASE_URL"), "{err}");
        assert!(err.contains("KORDI_CLIENT_CALLBACK_SCHEME"), "{err}");
        let err = check_release_startup(|key| match key {
            "KORDI_CLOUD_PUBLIC_BASE_URL" => Some("http://example.test".into()),
            _ => Some("Kordi Beta".into()),
        })
        .unwrap_err();
        assert!(err.contains("requires HTTPS"), "{err}");
        assert!(err.contains("callback scheme"), "{err}");
        assert!(check_release_startup(|key| match key {
            "KORDI_CLOUD_PUBLIC_BASE_URL" => Some("https://example.test".into()),
            _ => Some("kordi-beta".into()),
        })
        .is_ok());
    }

    #[test]
    fn debug_builds_keep_accepting_any_http_origin() {
        assert!(validate_public_origin("http://example.test", true).is_ok());
    }

    #[test]
    fn persona_requires_explicit_release_content() {
        assert!(agent_persona(None, None).is_err());
        assert!(agent_persona(Some(" "), None).is_err());
        assert!(agent_persona(Some("bad\0text"), None).is_err());
        assert_eq!(
            agent_persona(Some("Research persona"), Some("Development persona")).unwrap(),
            "Research persona"
        );
    }
}
