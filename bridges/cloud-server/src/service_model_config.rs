//! Operator-owned defaults for service models, independent of cloud hosting.

pub(crate) fn shared_setting(
    get: &mut impl FnMut(&str) -> Option<String>,
    suffix: &str,
) -> Option<String> {
    let suffix = match suffix {
        "PROVIDER" => "PROVIDER",
        "OPENAI_API_KEY" => "API_KEY",
        "OPENAI_BASE_URL" => "BASE_URL",
        "OPENAI_MODEL" => "MODEL",
        _ => return None,
    };
    get(&format!("KORDI_SERVICE_MODEL_{suffix}"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// An operator may select an HTTPS gateway or a loopback test server. Credentials
/// belong in the key setting, never in an endpoint that might appear in logs.
pub(crate) fn validate_base_url(raw: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "Invalid service model base URL")?;
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Service model base URL must use HTTPS without credentials, query, or fragment",
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_validation_rejects_embedded_secrets_and_lookalike_loopback() {
        for url in [
            "https://user:secret@example.test/v1",
            "https://example.test/v1?key=secret",
            "https://example.test/#secret",
            "http://localhost.evil.test/v1",
            "file:///tmp/model",
        ] {
            assert!(validate_base_url(url).is_err());
        }
        assert_eq!(
            validate_base_url(" https://gateway.example.test/v1/ ").unwrap(),
            "https://gateway.example.test/v1"
        );
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
    }
}
