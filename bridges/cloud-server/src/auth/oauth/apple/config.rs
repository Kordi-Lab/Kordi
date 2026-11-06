//! Sign in with Apple server configuration.
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `KORDI_OAUTH_APPLE_CLIENT_ID` | The Services ID used by the browser flow. |
//! | `KORDI_OAUTH_APPLE_TEAM_ID` | The Apple Developer team ID. |
//! | `KORDI_OAUTH_APPLE_KEY_ID` | The ID of the Sign in with Apple key. |
//! | `KORDI_OAUTH_APPLE_PRIVATE_KEY` | That key: the `.p8` PEM text, with real or `\n` line breaks, or the PEM base64-encoded. |
//!
//! Apple is offered only when all four are set and the key parses.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

pub(crate) const CLIENT_ID_ENV: &str = "KORDI_OAUTH_APPLE_CLIENT_ID";
pub(crate) const TEAM_ID_ENV: &str = "KORDI_OAUTH_APPLE_TEAM_ID";
pub(crate) const KEY_ID_ENV: &str = "KORDI_OAUTH_APPLE_KEY_ID";
pub(crate) const PRIVATE_KEY_ENV: &str = "KORDI_OAUTH_APPLE_PRIVATE_KEY";

const MAX_ID_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleConfigError {
    Incomplete,
    InvalidIdentifier,
    InvalidPrivateKey,
}

/// A complete Apple configuration. The private key is kept as PKCS#8 DER
/// and has been checked to be a P-256 signing key.
#[derive(Clone)]
pub(crate) struct AppleConfig {
    pub(crate) client_id: String,
    pub(crate) team_id: String,
    pub(crate) key_id: String,
    pub(crate) private_key_pkcs8: Vec<u8>,
}

impl std::fmt::Debug for AppleConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppleConfig")
            .field("client_id", &self.client_id)
            .field("team_id", &self.team_id)
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

impl AppleConfig {
    pub(crate) fn from_env() -> Result<Self, AppleConfigError> {
        Self::from_values(
            &env(CLIENT_ID_ENV),
            &env(TEAM_ID_ENV),
            &env(KEY_ID_ENV),
            &env(PRIVATE_KEY_ENV),
        )
    }

    pub(crate) fn from_values(
        client_id: &str,
        team_id: &str,
        key_id: &str,
        private_key: &str,
    ) -> Result<Self, AppleConfigError> {
        let (client_id, team_id, key_id) = (client_id.trim(), team_id.trim(), key_id.trim());
        if client_id.is_empty()
            || team_id.is_empty()
            || key_id.is_empty()
            || private_key.trim().is_empty()
        {
            return Err(AppleConfigError::Incomplete);
        }
        if ![client_id, team_id, key_id]
            .into_iter()
            .all(valid_identifier)
        {
            return Err(AppleConfigError::InvalidIdentifier);
        }
        let private_key_pkcs8 =
            parse_private_key(private_key).ok_or(AppleConfigError::InvalidPrivateKey)?;
        Ok(Self {
            client_id: client_id.to_string(),
            team_id: team_id.to_string(),
            key_id: key_id.to_string(),
            private_key_pkcs8,
        })
    }
}

/// Whether the environment holds a complete, usable Apple configuration.
pub(crate) fn apple_is_configured() -> bool {
    AppleConfig::from_env().is_ok()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ID_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// PKCS#8 DER from the `.p8` PEM, the PEM with escaped line breaks, or the
/// PEM base64-encoded. `None` unless it is a P-256 signing key.
fn parse_private_key(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    let pem = if trimmed.starts_with("-----BEGIN") {
        trimmed.replace("\\n", "\n")
    } else {
        let decoded = STANDARD
            .decode(trimmed.split_whitespace().collect::<String>())
            .ok()?;
        String::from_utf8(decoded).ok()?
    };
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("-----"))
        .collect();
    let der = STANDARD.decode(body).ok()?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new()).ok()?;
    Some(der)
}
