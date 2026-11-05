//! Operator-trusted networks whose per-address limits are multiplied.
//!
//! Many people at one venue can share a single public address, so the
//! per-address limits that stop one abusive client would also stop a room of
//! honest ones. `KORDI_RATE_LIMIT_TRUSTED_NETWORKS` lists addresses or CIDR
//! ranges, separated by commas; a client inside one of them gets every
//! per-address limit multiplied by `KORDI_RATE_LIMIT_TRUSTED_MULTIPLIER`.
//! Per-account limits and per-email login lockouts are unchanged.
//!
//! Both settings are read once at startup and parsed strictly: an invalid
//! value stops the server with the setting's name.

use std::net::IpAddr;

use super::AccountActionLimit;
use crate::client_ip::IpNetwork;

pub const TRUSTED_NETWORKS_ENV: &str = "KORDI_RATE_LIMIT_TRUSTED_NETWORKS";
pub const TRUSTED_MULTIPLIER_ENV: &str = "KORDI_RATE_LIMIT_TRUSTED_MULTIPLIER";
pub const DEFAULT_TRUSTED_MULTIPLIER: u32 = 20;
pub const MAX_TRUSTED_MULTIPLIER: u32 = 100;

const INVALID_NETWORK: &str =
    "KORDI_RATE_LIMIT_TRUSTED_NETWORKS must list IP addresses or CIDR ranges separated by commas";
const NETWORK_TOO_BROAD: &str =
    "KORDI_RATE_LIMIT_TRUSTED_NETWORKS must not contain a /0 range that trusts every address";
const INVALID_MULTIPLIER: &str =
    "KORDI_RATE_LIMIT_TRUSTED_MULTIPLIER must be a whole number from 1 to 100";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedNetworks {
    networks: Vec<IpNetwork>,
    multiplier: u32,
}

impl Default for TrustedNetworks {
    fn default() -> Self {
        Self::none()
    }
}

impl TrustedNetworks {
    /// No trusted networks: every limit applies as written.
    pub fn none() -> Self {
        Self {
            networks: Vec::new(),
            multiplier: 1,
        }
    }

    /// Parses the two settings. An unset or blank network list trusts no
    /// address; an unset multiplier uses [`DEFAULT_TRUSTED_MULTIPLIER`].
    pub fn parse(networks: Option<&str>, multiplier: Option<&str>) -> Result<Self, &'static str> {
        let multiplier = match multiplier.map(str::trim) {
            None => DEFAULT_TRUSTED_MULTIPLIER,
            Some(value) => value
                .parse::<u32>()
                .ok()
                .filter(|value| (1..=MAX_TRUSTED_MULTIPLIER).contains(value))
                .ok_or(INVALID_MULTIPLIER)?,
        };
        let networks = match networks.map(str::trim) {
            None | Some("") => Vec::new(),
            Some(value) => value
                .split(',')
                .map(|entry| {
                    let network = IpNetwork::parse(entry.trim()).ok_or(INVALID_NETWORK)?;
                    if network.prefix == 0 {
                        return Err(NETWORK_TOO_BROAD);
                    }
                    Ok(network)
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        Ok(Self {
            networks,
            multiplier,
        })
    }

    /// Reads both settings and logs how many ranges are configured, never the
    /// ranges themselves.
    pub fn from_env() -> Result<Self, &'static str> {
        let networks = std::env::var(TRUSTED_NETWORKS_ENV).ok();
        let multiplier = std::env::var(TRUSTED_MULTIPLIER_ENV).ok();
        let trusted = Self::parse(networks.as_deref(), multiplier.as_deref())?;
        if !trusted.is_empty() {
            println!(
                "Kordi rate limits: {} trusted network range(s) get {}x per-address limits",
                trusted.len(),
                trusted.multiplier
            );
        }
        Ok(trusted)
    }

    /// How many ranges are configured. Logged at startup instead of the
    /// ranges themselves.
    pub fn len(&self) -> usize {
        self.networks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.networks.is_empty()
    }

    pub fn multiplier(&self) -> u32 {
        self.multiplier
    }

    /// Whether `client` falls inside a trusted range. Unknown clients never do.
    pub fn contains(&self, client: Option<IpAddr>) -> bool {
        client.is_some_and(|client| self.networks.iter().any(|n| n.contains(client)))
    }

    /// `limit`, multiplied when `client` is trusted.
    pub fn scale(&self, limit: u32, client: Option<IpAddr>) -> u32 {
        if self.contains(client) {
            limit.saturating_mul(self.multiplier)
        } else {
            limit
        }
    }

    /// A per-address budget, multiplied when `client` is trusted.
    pub fn scale_action(
        &self,
        limit: AccountActionLimit,
        client: Option<IpAddr>,
    ) -> AccountActionLimit {
        AccountActionLimit {
            limit: self.scale(limit.limit, client),
            ..limit
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> Option<IpAddr> {
        Some(value.parse().unwrap())
    }

    #[test]
    fn unset_settings_trust_nothing() {
        let trusted = TrustedNetworks::parse(None, None).unwrap();
        assert!(trusted.is_empty());
        assert_eq!(trusted.multiplier(), DEFAULT_TRUSTED_MULTIPLIER);
        assert_eq!(trusted.scale(50, ip("203.0.113.7")), 50);
        assert_eq!(TrustedNetworks::parse(Some("  "), None).unwrap().len(), 0);
        assert_eq!(TrustedNetworks::none().scale(50, ip("203.0.113.7")), 50);
    }

    #[test]
    fn parses_ipv4_and_ipv6_ranges() {
        let trusted =
            TrustedNetworks::parse(Some("203.0.113.0/24, 2001:db8::/32,198.51.100.9"), None)
                .unwrap();
        assert_eq!(trusted.len(), 3);
        assert!(trusted.contains(ip("203.0.113.200")));
        assert!(trusted.contains(ip("::ffff:203.0.113.5")));
        assert!(trusted.contains(ip("2001:db8:1234::1")));
        assert!(trusted.contains(ip("198.51.100.9")));
        assert!(!trusted.contains(ip("198.51.100.10")));
        assert!(!trusted.contains(ip("203.0.114.1")));
        assert!(!trusted.contains(ip("2001:db9::1")));
        assert!(!trusted.contains(None));
    }

    #[test]
    fn rejects_invalid_ranges() {
        for value in [
            "203.0.113.0/33",
            "2001:db8::/129",
            "203.0.113.0/",
            "not-an-address",
            "203.0.113.0/24,,2001:db8::/32",
            "203.0.113.0/24;198.51.100.0/24",
        ] {
            assert_eq!(
                TrustedNetworks::parse(Some(value), None),
                Err(INVALID_NETWORK),
                "{value}"
            );
        }
        for value in ["0.0.0.0/0", "::/0"] {
            assert_eq!(
                TrustedNetworks::parse(Some(value), None),
                Err(NETWORK_TOO_BROAD)
            );
        }
        // The message names the setting, never the value.
        assert!(INVALID_NETWORK.starts_with(TRUSTED_NETWORKS_ENV));
        assert!(!INVALID_NETWORK.contains("not-an-address"));
    }

    #[test]
    fn multiplier_is_bounded() {
        let parse = |value| TrustedNetworks::parse(Some("203.0.113.0/24"), Some(value));
        assert_eq!(parse("1").unwrap().multiplier(), 1);
        assert_eq!(parse(" 100 ").unwrap().multiplier(), 100);
        for value in ["0", "101", "-5", "2.5", "", "twenty"] {
            assert_eq!(parse(value), Err(INVALID_MULTIPLIER), "{value}");
        }
        assert!(INVALID_MULTIPLIER.starts_with(TRUSTED_MULTIPLIER_ENV));
        let trusted = parse("3").unwrap();
        assert_eq!(trusted.scale(60, ip("203.0.113.1")), 180);
        assert_eq!(trusted.scale(u32::MAX, ip("203.0.113.1")), u32::MAX);
    }
}
