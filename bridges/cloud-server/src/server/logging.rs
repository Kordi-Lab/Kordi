pub(super) fn redact_url_credentials(value: &str) -> String {
    let Some(scheme_end) = value.find("://") else {
        return value.to_string();
    };
    let scheme_prefix_end = scheme_end + 3;
    let after_scheme = &value[scheme_prefix_end..];
    let Some(at_index) = after_scheme.find('@') else {
        return value.to_string();
    };
    let credentials = &after_scheme[..at_index];
    let Some(password_separator) = credentials.find(':') else {
        return value.to_string();
    };

    format!(
        "{}{}:***@{}",
        &value[..scheme_prefix_end],
        &credentials[..password_separator],
        &after_scheme[at_index + 1..]
    )
}

#[cfg(test)]
mod tests {
    use super::redact_url_credentials;

    #[test]
    fn redacts_credentials_from_logged_urls() {
        assert_eq!(
            redact_url_credentials(
                "redis://default:secret-password@redis.kordi-cloud.svc.cluster.local:6379/0"
            ),
            "redis://default:***@redis.kordi-cloud.svc.cluster.local:6379/0"
        );
        assert_eq!(
            redact_url_credentials(
                "redis://default:secret/with+reserved=chars@redis.kordi-cloud.svc.cluster.local:6379/0"
            ),
            "redis://default:***@redis.kordi-cloud.svc.cluster.local:6379/0"
        );
        assert_eq!(
            redact_url_credentials("nats://nats.kordi-cloud.svc.cluster.local:4222"),
            "nats://nats.kordi-cloud.svc.cluster.local:4222"
        );
    }
}
