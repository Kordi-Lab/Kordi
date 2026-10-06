//! Client address resolution for per-client rate limits and audit metadata.
//!
//! The TCP peer address is authoritative unless the peer is a configured
//! trusted reverse proxy. Only then does the server read `X-Real-IP` and, when
//! that is absent or malformed, the nearest untrusted `X-Forwarded-For` hop.
//! Headers from any other peer are ignored so clients cannot pick their own
//! rate-limit bucket.
//!
//! `KORDI_CLOUD_TRUSTED_PROXIES` lists trusted proxy addresses or CIDR ranges,
//! separated by commas. When unset, only loopback peers are trusted. An empty
//! value trusts no peer. Invalid entries are ignored with a warning.

use std::net::IpAddr;
use std::sync::OnceLock;

use axum::http::HeaderMap;

pub const TRUSTED_PROXIES_ENV: &str = "KORDI_CLOUD_TRUSTED_PROXIES";
const DEFAULT_TRUSTED_PROXIES: &str = "127.0.0.0/8,::1/128";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IpNetwork {
    address: IpAddr,
    prefix: u8,
}

impl IpNetwork {
    fn parse(value: &str) -> Option<Self> {
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address.trim(), Some(prefix.trim())),
            None => (value.trim(), None),
        };
        let address = address.parse::<IpAddr>().ok()?.to_canonical();
        let max_prefix = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix.parse::<u8>().ok().filter(|p| *p <= max_prefix)?,
            None => max_prefix,
        };
        Some(Self { address, prefix })
    }

    fn contains(&self, candidate: IpAddr) -> bool {
        match (self.address, candidate.to_canonical()) {
            (IpAddr::V4(network), IpAddr::V4(candidate)) => {
                prefix_matches(&network.octets(), &candidate.octets(), self.prefix)
            }
            (IpAddr::V6(network), IpAddr::V6(candidate)) => {
                prefix_matches(&network.octets(), &candidate.octets(), self.prefix)
            }
            _ => false,
        }
    }
}

fn prefix_matches(network: &[u8], candidate: &[u8], prefix: u8) -> bool {
    let full_bytes = usize::from(prefix / 8);
    let remaining_bits = prefix % 8;
    if network[..full_bytes] != candidate[..full_bytes] {
        return false;
    }
    if remaining_bits == 0 {
        return true;
    }
    let mask = u8::MAX << (8 - remaining_bits);
    network[full_bytes] & mask == candidate[full_bytes] & mask
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedProxies {
    networks: Vec<IpNetwork>,
}

impl TrustedProxies {
    /// Parses a comma-separated list of addresses or CIDR ranges. Returns the
    /// valid networks and the entries that could not be parsed.
    pub fn parse(value: &str) -> (Self, Vec<String>) {
        let mut networks = Vec::new();
        let mut invalid = Vec::new();
        for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            match IpNetwork::parse(entry) {
                Some(network) => networks.push(network),
                None => invalid.push(entry.to_string()),
            }
        }
        (Self { networks }, invalid)
    }

    /// Loopback-only trust, the default when no configuration is present.
    pub fn loopback() -> Self {
        Self::parse(DEFAULT_TRUSTED_PROXIES).0
    }

    pub fn from_env() -> Self {
        let Ok(value) = std::env::var(TRUSTED_PROXIES_ENV) else {
            return Self::loopback();
        };
        let (proxies, invalid) = Self::parse(&value);
        if !invalid.is_empty() {
            eprintln!(
                "[client-ip] ignoring invalid {TRUSTED_PROXIES_ENV} entries: {}",
                invalid.join(", ")
            );
        }
        proxies
    }

    pub fn contains(&self, address: IpAddr) -> bool {
        self.networks
            .iter()
            .any(|network| network.contains(address))
    }

    /// Resolves the client address for a request that arrived from `peer`.
    pub fn client_ip(&self, headers: &HeaderMap, peer: Option<IpAddr>) -> Option<IpAddr> {
        let peer = peer?.to_canonical();
        if !self.contains(peer) {
            return Some(peer);
        }
        real_ip_header(headers)
            .or_else(|| self.forwarded_for_client(headers))
            .or(Some(peer))
    }

    /// Walks `X-Forwarded-For` from the nearest hop outward and returns the
    /// first address that is not a trusted proxy. A malformed hop stops the
    /// walk, because anything farther out cannot be attributed reliably.
    fn forwarded_for_client(&self, headers: &HeaderMap) -> Option<IpAddr> {
        let hops = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .filter(|hop| !hop.is_empty())
            .collect::<Vec<_>>();
        for hop in hops.into_iter().rev() {
            let address = parse_header_address(hop)?;
            if !self.contains(address) {
                return Some(address);
            }
        }
        None
    }
}

fn real_ip_header(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_header_address)
}

fn parse_header_address(value: &str) -> Option<IpAddr> {
    let value = value.trim();
    value
        .parse::<IpAddr>()
        .or_else(|_| {
            value
                .parse::<std::net::SocketAddr>()
                .map(|socket| socket.ip())
        })
        .ok()
        .map(|address| address.to_canonical())
}

/// Process-wide trusted proxy configuration, read once from the environment.
pub fn trusted_proxies() -> &'static TrustedProxies {
    static TRUSTED: OnceLock<TrustedProxies> = OnceLock::new();
    TRUSTED.get_or_init(TrustedProxies::from_env)
}

/// Resolves the client address using the process-wide configuration.
pub fn resolve_client_ip(headers: &HeaderMap, peer: Option<IpAddr>) -> Option<IpAddr> {
    trusted_proxies().client_ip(headers, peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        headers
    }

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn default_trusts_only_loopback_peers() {
        let trusted = TrustedProxies::loopback();
        let forwarded = headers(&[("x-real-ip", "203.0.113.8")]);

        assert_eq!(
            trusted.client_ip(&forwarded, Some(ip("127.0.0.1"))),
            Some(ip("203.0.113.8"))
        );
        assert_eq!(
            trusted.client_ip(&forwarded, Some(ip("::1"))),
            Some(ip("203.0.113.8"))
        );
        assert_eq!(
            trusted.client_ip(&forwarded, Some(ip("10.42.0.1"))),
            Some(ip("10.42.0.1")),
            "private peers are not trusted unless configured"
        );
        assert_eq!(
            trusted.client_ip(&forwarded, Some(ip("198.51.100.2"))),
            Some(ip("198.51.100.2"))
        );
        assert_eq!(trusted.client_ip(&forwarded, None), None);
    }

    #[test]
    fn configured_networks_accept_addresses_and_cidr_ranges() {
        let (trusted, invalid) =
            TrustedProxies::parse(" 10.42.0.1 , 172.16.0.0/12, fd00::/8, nonsense, 10.0.0.0/33");
        assert_eq!(
            invalid,
            vec!["nonsense".to_string(), "10.0.0.0/33".to_string()]
        );
        assert!(trusted.contains(ip("10.42.0.1")));
        assert!(!trusted.contains(ip("10.42.0.2")));
        assert!(trusted.contains(ip("172.31.255.1")));
        assert!(!trusted.contains(ip("172.32.0.1")));
        assert!(trusted.contains(ip("fd12::1")));
        assert!(trusted.contains(ip("::ffff:10.42.0.1")));
        assert!(!trusted.contains(ip("127.0.0.1")));

        let (none, _) = TrustedProxies::parse("");
        let forwarded = headers(&[("x-real-ip", "203.0.113.8")]);
        assert_eq!(
            none.client_ip(&forwarded, Some(ip("127.0.0.1"))),
            Some(ip("127.0.0.1"))
        );
    }

    #[test]
    fn forwarded_for_uses_nearest_untrusted_hop() {
        let (trusted, _) = TrustedProxies::parse("127.0.0.1,10.0.0.0/8");
        let peer = Some(ip("127.0.0.1"));

        let chain = headers(&[("x-forwarded-for", "192.0.2.1, 203.0.113.9, 10.1.2.3")]);
        assert_eq!(trusted.client_ip(&chain, peer), Some(ip("203.0.113.9")));

        let split = headers(&[
            ("x-forwarded-for", "192.0.2.1"),
            ("x-forwarded-for", "203.0.113.10"),
        ]);
        assert_eq!(trusted.client_ip(&split, peer), Some(ip("203.0.113.10")));

        let preferred = headers(&[
            ("x-real-ip", "198.51.100.7"),
            ("x-forwarded-for", "203.0.113.9"),
        ]);
        assert_eq!(
            trusted.client_ip(&preferred, peer),
            Some(ip("198.51.100.7"))
        );

        let malformed = headers(&[("x-real-ip", "not-an-ip"), ("x-forwarded-for", "garbage")]);
        assert_eq!(trusted.client_ip(&malformed, peer), peer);

        let internal_only = headers(&[("x-forwarded-for", "10.0.0.5")]);
        assert_eq!(trusted.client_ip(&internal_only, peer), peer);
    }

    #[test]
    fn untrusted_peers_cannot_choose_their_address() {
        let (trusted, _) = TrustedProxies::parse("10.42.0.1");
        let claimed = headers(&[
            ("x-real-ip", "203.0.113.8"),
            ("x-forwarded-for", "203.0.113.9"),
        ]);
        assert_eq!(
            trusted.client_ip(&claimed, Some(ip("10.42.0.7"))),
            Some(ip("10.42.0.7"))
        );
    }
}
