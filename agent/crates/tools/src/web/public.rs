//! Public-only transport for shared requests. Validate literals and every redirect,
//! and validate the actual DNS answers used by the connection (no second lookup).
use kordi_core::error::{KordiError, KordiResult};
use reqwest::{
    Client, Url,
    dns::{Addrs, Name, Resolve, Resolving},
};
use std::{net::IpAddr, sync::Arc, time::Duration};

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && c == 0)
                && !(a == 198 && (b == 18 || b == 19))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            // Fail closed for mapped, translation, tunneling and special-use ranges.
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
                && segments[0] != 0x2002
                && segments[0] != 0x3fff
        }
    }
}

fn denied() -> KordiError {
    KordiError::Tool("Shared web requests require a public HTTP(S) endpoint; local and private-network access is not authorized".into())
}

pub(crate) fn validate_url(url: &Url) -> KordiResult<()> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(denied());
    }
    let host = url.host_str().ok_or_else(denied)?;
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if public_ip(ip) { Ok(()) } else { Err(denied()) };
    }
    let host = host.trim_end_matches('.');
    if !host.contains('.') || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(denied());
    }
    Ok(())
}

struct PublicResolver;
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
                return Err(Box::new(denied()) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

pub(crate) fn client(timeout: Duration, max_redirects: usize) -> KordiResult<Client> {
    Client::builder()
        .user_agent(super::STANDARD_WEB_USER_AGENT)
        .no_proxy()
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Err(error) = validate_url(attempt.url()) {
                attempt.error(error)
            } else if attempt.previous().len() >= max_redirects {
                attempt.error("Too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .timeout(timeout)
        .build()
        .map_err(|error| KordiError::Tool(format!("Could not create public web client: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_literals_credentials_and_non_web_endpoints() {
        for raw in [
            "http://127.1",
            "http://2130706433",
            "http://10.1.2.3",
            "http://169.254.169.254",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[fc00::1]",
            "http://100.64.0.1",
            "file:///tmp/private",
            "http://localhost",
            "http://host.local",
            "https://user:pass@example.com",
            "http://example.com:17081",
            "http://[2002:7f00:1::]",
            "http://[64:ff9b::7f00:1]",
        ] {
            assert!(validate_url(&Url::parse(raw).unwrap()).is_err(), "{raw}");
        }
        assert!(validate_url(&Url::parse("https://science.nasa.gov/").unwrap()).is_ok());
    }

    #[tokio::test]
    async fn rejects_private_dns_answers_at_connection_time() {
        let error = PublicResolver
            .resolve("localhost".parse().unwrap())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("not authorized"));
    }
}
