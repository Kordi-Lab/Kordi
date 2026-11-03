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

pub fn public_origin() -> String {
    let configured = std::env::var("KORDI_CLOUD_PUBLIC_BASE_URL").ok();
    let value = configured
        .as_deref()
        .or(development_origin())
        .expect("An ops public origin is required");
    let url = url::Url::parse(value).expect("Invalid public origin");
    assert!(
        url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.path().is_empty() || url.path() == "/"),
        "Invalid public origin"
    );
    assert!(
        url.scheme() == "https" || (cfg!(debug_assertions) && url.scheme() == "http"),
        "Public origin requires HTTPS"
    );
    url.origin().ascii_serialization()
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
    match std::env::var("KORDI_CLIENT_CALLBACK_SCHEME") {
        Ok(value)
            if !value.is_empty()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') =>
        {
            value
        }
        Err(_) if cfg!(debug_assertions) => "kordi".to_string(),
        _ => panic!("An ops client callback scheme is required"),
    }
}

#[cfg(test)]
mod tests {
    use super::agent_persona;
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

/// Preserve existing debug/Beta defaults without assigning a release deployment policy.
pub(crate) const fn development_default(value: &'static str) -> &'static str {
    if cfg!(debug_assertions) {
        value
    } else {
        ""
    }
}
