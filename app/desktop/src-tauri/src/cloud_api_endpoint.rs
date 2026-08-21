pub(crate) const DEFAULT_CLOUD_API_BASE_URL: &str = "https://kordi.ai";
const PRODUCTION_CLOUD_API_HOSTNAMES: [&str; 1] = ["kordi.ai"];

fn is_production_cloud_api_url(url: &reqwest::Url) -> bool {
    url.host_str()
        .map(|hostname| {
            let normalized = hostname.trim_end_matches('.');
            PRODUCTION_CLOUD_API_HOSTNAMES
                .iter()
                .any(|production| normalized.eq_ignore_ascii_case(production))
        })
        .unwrap_or(false)
}

fn operator_production_debug_is_allowed(
    dev_profile: Option<&str>,
    production_debug_ack: Option<&str>,
) -> bool {
    dev_profile
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("operator"))
        && production_debug_ack.map(str::trim) == Some("1")
}

fn normalize_cloud_api_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Cloud API base URL is empty".to_string());
    }

    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "Cloud API base URL must be a valid absolute HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Cloud API base URL must use http:// or https://".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Cloud API base URL must not include credentials, a query, or a fragment".to_string(),
        );
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Cloud API base URL must be an origin without a path".to_string());
    }

    Ok(url.origin().ascii_serialization())
}

fn resolve_cloud_api_base_url(
    vite_base: Option<&str>,
    native_base: Option<&str>,
    debug_build: bool,
    dev_profile: Option<&str>,
    production_debug_ack: Option<&str>,
) -> Result<String, String> {
    let configured = vite_base
        .filter(|value| !value.trim().is_empty())
        .or_else(|| native_base.filter(|value| !value.trim().is_empty()));

    let Some(configured) = configured else {
        if debug_build {
            return Err(
                "VITE_KORDI_CLOUD_API_BASE is required for development. Start the local debug server with `pnpm debug:cloud:up`, then set its loopback URL."
                    .to_string(),
            );
        }
        return Ok(DEFAULT_CLOUD_API_BASE_URL.to_string());
    };

    let origin = normalize_cloud_api_base_url(configured)?;
    let parsed_origin = reqwest::Url::parse(&origin)
        .map_err(|_| "Cloud API base URL must be a valid absolute HTTP(S) URL".to_string())?;
    if debug_build {
        let operator_profile = dev_profile
            .map(str::trim)
            .is_some_and(|value| value.eq_ignore_ascii_case("operator"));
        if operator_profile {
            if !operator_production_debug_is_allowed(dev_profile, production_debug_ack) {
                return Err(
                    "Production Cloud API is blocked in development until the operator acknowledgement is set."
                        .to_string(),
                );
            }
            if origin != DEFAULT_CLOUD_API_BASE_URL {
                return Err(
                    "Operator development may use only the approved https://kordi.ai product origin."
                        .to_string(),
                );
            }
        } else if is_production_cloud_api_url(&parsed_origin) {
            return Err(
                "Production Cloud API is blocked in development for community profiles. Use the allowlisted operator launcher for approved production debugging."
                    .to_string(),
            );
        }
    }
    Ok(origin)
}

pub(crate) fn cloud_api_base_url_from_env() -> Result<String, String> {
    let vite_base = std::env::var("VITE_KORDI_CLOUD_API_BASE").ok();
    let native_base = std::env::var("KORDI_CLOUD_API_BASE").ok();
    let dev_profile = std::env::var("VITE_KORDI_DEV_PROFILE").ok();
    let production_debug_ack = std::env::var("VITE_KORDI_PRODUCTION_DEBUG_ACK").ok();
    resolve_cloud_api_base_url(
        vite_base.as_deref(),
        native_base.as_deref(),
        cfg!(debug_assertions),
        dev_profile.as_deref(),
        production_debug_ack.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::{resolve_cloud_api_base_url, DEFAULT_CLOUD_API_BASE_URL};

    #[test]
    fn debug_build_requires_an_explicit_non_production_cloud_api() {
        assert!(resolve_cloud_api_base_url(None, None, true, None, None)
            .unwrap_err()
            .contains("required for development"));
        for origin in ["https://kordi.ai/", "http://kordi.ai", "https://kordi.ai./"] {
            assert!(
                resolve_cloud_api_base_url(Some(origin), None, true, None, None)
                    .unwrap_err()
                    .contains("blocked in development")
            );
        }
        assert_eq!(
            resolve_cloud_api_base_url(Some(" http://127.0.0.1:17081/ "), None, true, None, None,)
                .unwrap(),
            "http://127.0.0.1:17081"
        );
    }

    #[test]
    fn operator_debug_requires_profile_and_explicit_production_acknowledgement() {
        assert!(resolve_cloud_api_base_url(
            Some(DEFAULT_CLOUD_API_BASE_URL),
            None,
            true,
            Some("operator"),
            None,
        )
        .is_err());
        assert!(resolve_cloud_api_base_url(
            Some(DEFAULT_CLOUD_API_BASE_URL),
            None,
            true,
            Some("community"),
            Some("1"),
        )
        .is_err());
        assert_eq!(
            resolve_cloud_api_base_url(
                Some(DEFAULT_CLOUD_API_BASE_URL),
                None,
                true,
                Some("operator"),
                Some("1"),
            )
            .unwrap(),
            DEFAULT_CLOUD_API_BASE_URL,
        );
        assert!(resolve_cloud_api_base_url(
            Some("https://staging.example.test"),
            None,
            true,
            Some("operator"),
            Some("1"),
        )
        .unwrap_err()
        .contains("approved"));
    }

    #[test]
    fn release_build_keeps_the_product_default() {
        assert_eq!(
            resolve_cloud_api_base_url(None, None, false, None, None).unwrap(),
            DEFAULT_CLOUD_API_BASE_URL
        );
    }
}
