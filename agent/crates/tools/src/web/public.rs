//! Public-only transport for shared requests. Validate literals and every redirect,
//! and validate the actual DNS answers used by the connection (no second lookup).
use kordi_core::error::{KordiError, KordiResult};
use reqwest::{
    Client, ClientBuilder, Url,
    dns::{Addrs, Name, Resolve, Resolving},
};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

const WEB_DENIAL: &str = "Shared web requests require a public HTTP(S) endpoint; local and private-network access is not authorized";
const ENDPOINT_DENIAL: &str = "The endpoint must be a public HTTP(S) address; local and private-network endpoints are not authorized";
const PRIVATE_NETWORK_ENDPOINT_DENIAL: &str = "The endpoint must be an HTTP(S) address; link-local and cloud metadata endpoints are not authorized";
const ENDPOINT_MAX_REDIRECTS: usize = 10;

/// Host names of cloud instance metadata services. Their addresses are also
/// refused, so these names only fail earlier with a clearer error.
const METADATA_HOSTS: &[&str] = &[
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
];

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
                && !(a == 192 && b == 88 && c == 99)
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

/// Addresses a self-hosted deployment may use for its own model servers:
/// loopback, private, carrier-grade NAT, unique local, and public addresses.
/// Link-local ranges (which hold cloud metadata services), other known
/// metadata addresses, and multicast or reserved ranges are refused, also
/// when embedded in an IPv4-mapped or NAT64 IPv6 address.
fn private_network_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_link_local() && ip != Ipv4Addr::new(100, 100, 100, 200) && ip.octets()[0] < 224
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return private_network_ip(IpAddr::V4(mapped));
            }
            if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let [a, b] = segments[6].to_be_bytes();
                let [c, d] = segments[7].to_be_bytes();
                return private_network_ip(IpAddr::V4(Ipv4Addr::new(a, b, c, d)));
            }
            segments[0] & 0xffc0 != 0xfe80
                && segments[0] & 0xff00 != 0xff00
                && ip != Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
        }
    }
}

/// Whether a connection may use this address: the policy that the clients
/// from [`public_endpoint_client_builder`] (and, with `allow_private`,
/// [`private_network_endpoint_client_builder`]) apply to every DNS answer.
/// Use it to check the answers for an endpoint that is handed to a transport
/// which resolves names itself and cannot apply the policy.
pub fn endpoint_address_allowed(ip: IpAddr, allow_private: bool) -> bool {
    if allow_private {
        private_network_ip(ip)
    } else {
        public_ip(ip)
    }
}

fn denied_with(message: &str) -> KordiError {
    KordiError::Tool(message.into())
}

fn denied() -> KordiError {
    denied_with(WEB_DENIAL)
}

/// Scheme, credential, and host checks shared by every public-only request:
/// HTTP(S) only, no embedded credentials, a public literal address or a
/// multi-label name that is not a local-only suffix.
fn validate_public_host(url: &Url, message: &str) -> KordiResult<()> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(denied_with(message));
    }
    let host = url.host_str().ok_or_else(|| denied_with(message))?;
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if public_ip(ip) {
            Ok(())
        } else {
            Err(denied_with(message))
        };
    }
    let host = host.trim_end_matches('.');
    if !host.contains('.') || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(denied_with(message));
    }
    Ok(())
}

pub(crate) fn validate_url(url: &Url) -> KordiResult<()> {
    validate_public_host(url, WEB_DENIAL)?;
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        return Err(denied());
    }
    Ok(())
}

/// Validates an endpoint chosen by an account owner or other shared
/// configuration, such as a model provider base URL. It applies the web
/// tools' address policy but allows any port. Connections made with
/// [`public_endpoint_client_builder`] also check every DNS answer and redirect.
pub fn validate_public_endpoint(url: &Url) -> KordiResult<()> {
    validate_public_host(url, ENDPOINT_DENIAL)
}

/// Validates an endpoint that a self-hosted deployment's operator allowed to
/// be on a private network, such as a model server beside the runner. It
/// accepts HTTP(S) on any port and any host, including single-label and
/// loopback names and private addresses, but refuses embedded credentials,
/// link-local and cloud metadata addresses, and metadata host names.
/// Connections made with [`private_network_endpoint_client_builder`] also
/// check every DNS answer and redirect.
pub fn validate_private_network_endpoint(url: &Url) -> KordiResult<()> {
    let message = PRIVATE_NETWORK_ENDPOINT_DENIAL;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(denied_with(message));
    }
    let host = url.host_str().ok_or_else(|| denied_with(message))?;
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if private_network_ip(ip) {
            Ok(())
        } else {
            Err(denied_with(message))
        };
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if METADATA_HOSTS.contains(&host.as_str()) {
        return Err(denied_with(message));
    }
    Ok(())
}

struct PolicyResolver {
    message: &'static str,
    allowed: fn(IpAddr) -> bool,
}

impl Resolve for PolicyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let message = self.message;
        let allowed = self.allowed;
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|address| !allowed(address.ip())) {
                return Err(
                    Box::new(denied_with(message)) as Box<dyn std::error::Error + Send + Sync>
                );
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn public_client_builder(
    validate: fn(&Url) -> KordiResult<()>,
    message: &'static str,
    max_redirects: usize,
) -> ClientBuilder {
    policy_client_builder(validate, message, max_redirects, public_ip)
}

fn policy_client_builder(
    validate: fn(&Url) -> KordiResult<()>,
    message: &'static str,
    max_redirects: usize,
    allowed: fn(IpAddr) -> bool,
) -> ClientBuilder {
    Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(PolicyResolver { message, allowed }))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Err(error) = validate(attempt.url()) {
                attempt.error(error)
            } else if attempt.previous().len() >= max_redirects {
                attempt.error("Too many redirects")
            } else {
                attempt.follow()
            }
        }))
}

pub(crate) fn client(timeout: Duration, max_redirects: usize) -> KordiResult<Client> {
    public_client_builder(validate_url, WEB_DENIAL, max_redirects)
        .user_agent(super::STANDARD_WEB_USER_AGENT)
        .timeout(timeout)
        .build()
        .map_err(|error| KordiError::Tool(format!("Could not create public web client: {error}")))
}

/// A client builder whose connections reach only public addresses: it
/// ignores proxy settings, refuses DNS answers that include a local,
/// private, carrier-grade NAT, or link-local address (so a name cannot be
/// rebound to one between validation and connection), and validates every
/// redirect target with [`validate_public_endpoint`]. Callers validate the
/// initial URL with [`validate_public_endpoint`], because literal addresses
/// never reach the resolver.
pub fn public_endpoint_client_builder() -> ClientBuilder {
    public_client_builder(
        validate_public_endpoint,
        ENDPOINT_DENIAL,
        ENDPOINT_MAX_REDIRECTS,
    )
}

/// A client builder for endpoints an operator allowed on a private network.
/// Like [`public_endpoint_client_builder`] it ignores proxy settings, checks
/// every DNS answer when it connects, and validates every redirect, but with
/// the [`validate_private_network_endpoint`] policy: private and loopback
/// addresses are reachable, link-local and cloud metadata addresses are not.
/// Callers validate the initial URL with
/// [`validate_private_network_endpoint`].
pub fn private_network_endpoint_client_builder() -> ClientBuilder {
    policy_client_builder(
        validate_private_network_endpoint,
        PRIVATE_NETWORK_ENDPOINT_DENIAL,
        ENDPOINT_MAX_REDIRECTS,
        private_network_ip,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_address_policy_matches_the_guarded_clients() {
        for ip in ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fe80::1"] {
            let ip = ip.parse().unwrap();
            assert!(!endpoint_address_allowed(ip, false), "{ip}");
        }
        for ip in ["127.0.0.1", "10.0.0.5", "::1"] {
            let ip = ip.parse().unwrap();
            assert!(endpoint_address_allowed(ip, true), "{ip}");
        }
        for ip in ["169.254.169.254", "100.100.100.200", "fe80::1"] {
            let ip = ip.parse().unwrap();
            assert!(!endpoint_address_allowed(ip, true), "{ip}");
        }
        for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
            let ip = ip.parse().unwrap();
            assert!(endpoint_address_allowed(ip, false), "{ip}");
            assert!(endpoint_address_allowed(ip, true), "{ip}");
        }
    }

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
            "http://example.com:8080",
            "http://[2002:7f00:1::]",
            "http://[64:ff9b::7f00:1]",
        ] {
            assert!(validate_url(&Url::parse(raw).unwrap()).is_err(), "{raw}");
        }
        assert!(validate_url(&Url::parse("https://science.nasa.gov/").unwrap()).is_ok());
    }

    #[test]
    fn endpoints_follow_the_web_address_policy_on_any_port() {
        for raw in [
            "http://127.0.0.1:11434/v1",
            "http://10.1.2.3:8000/v1",
            "http://169.254.169.254/computeMetadata/v1",
            "http://100.64.0.1/v1",
            "http://[::1]:8080/v1",
            "http://[fd00::1]/v1",
            "http://localhost:11434/v1",
            "http://postgres:5432",
            "http://kordi-cloud-server/v1",
            "http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081",
            "https://printer.local/v1",
            "https://user:pass@api.example.com/v1",
            "ftp://api.example.com/v1",
        ] {
            assert!(
                validate_public_endpoint(&Url::parse(raw).unwrap()).is_err(),
                "{raw}"
            );
        }
        for raw in [
            "https://api.openai.com/v1",
            "https://api.mistral.ai/v1",
            "https://llm.example.com:8443/v1",
            "http://8.8.8.8:8000/v1",
        ] {
            assert!(
                validate_public_endpoint(&Url::parse(raw).unwrap()).is_ok(),
                "{raw}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_private_dns_answers_at_connection_time() {
        let error = PolicyResolver {
            message: WEB_DENIAL,
            allowed: public_ip,
        }
        .resolve("localhost".parse().unwrap())
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("not authorized"));
    }

    #[test]
    fn private_network_endpoints_refuse_link_local_and_metadata_only() {
        for raw in [
            "http://169.254.169.254/computeMetadata/v1",
            "http://169.254.10.20:8000/v1",
            "http://[fe80::1]/v1",
            "http://[::ffff:169.254.169.254]/latest",
            "http://[64:ff9b::a9fe:a9fe]/latest",
            "http://[fd00:ec2::254]/latest",
            "http://100.100.100.200/latest",
            "http://metadata/computeMetadata/v1",
            "http://metadata.google.internal/computeMetadata/v1",
            "http://METADATA.google.internal./computeMetadata/v1",
            "http://instance-data/latest",
            "http://224.0.0.1/v1",
            "https://user:pass@vllm:8000/v1",
            "ftp://vllm/v1",
            "file:///tmp/model",
        ] {
            assert!(
                validate_private_network_endpoint(&Url::parse(raw).unwrap()).is_err(),
                "{raw}"
            );
        }
        for raw in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8000/v1",
            "http://10.0.0.5:8000/v1",
            "http://172.20.0.3:8000/v1",
            "http://192.168.1.20/v1",
            "http://100.64.0.1/v1",
            "http://[::1]:8080/v1",
            "http://[fd12::1]/v1",
            "http://vllm:8000/v1",
            "https://gateway.local/v1",
            "https://api.openai.com/v1",
        ] {
            assert!(
                validate_private_network_endpoint(&Url::parse(raw).unwrap()).is_ok(),
                "{raw}"
            );
        }
    }

    #[tokio::test]
    async fn private_network_resolver_refuses_link_local_answers() {
        let resolver = PolicyResolver {
            message: PRIVATE_NETWORK_ENDPOINT_DENIAL,
            allowed: private_network_ip,
        };
        let error = resolver
            .resolve("169.254.169.254".parse().unwrap())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("not authorized"));
        assert!(resolver.resolve("localhost".parse().unwrap()).await.is_ok());
    }

    #[tokio::test]
    async fn endpoint_client_refuses_names_that_resolve_to_private_addresses() {
        let client = public_endpoint_client_builder().build().unwrap();
        // The request skips URL validation on purpose: the connection-time
        // DNS check alone refuses the name, so no local listener is contacted.
        let error = client
            .get("http://localhost:9/v1/models")
            .send()
            .await
            .unwrap_err();
        let chain = std::iter::successors(
            Some(&error as &(dyn std::error::Error + 'static)),
            |error| error.source(),
        )
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(": ");
        assert!(chain.contains("not authorized"), "{chain}");
    }
}
