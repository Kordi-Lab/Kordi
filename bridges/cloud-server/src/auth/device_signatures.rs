//! Text that a device signs with its registered P-256 installation key.
//!
//! Version 2 of the signed text names the server the signature is for (its
//! public origin) and the signing device, so a signature made for one server
//! or device is refused by any other. Each request kind adds its own fields
//! and a single-use, server-issued nonce.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use url::{Host, Url};

/// The version of the signed text this server accepts.
pub(crate) const PROOF_VERSION: u32 = 2;
/// ECDSA over P-256 with SHA-256, as WebCrypto and CryptoKit produce it.
pub(crate) const PROOF_ALGORITHM: &str = "ecdsa-p256-sha256";
const DEFAULT_AUDIENCE: &str = "https://kordi.ai";
const MAX_AUDIENCE_CHARS: usize = 256;
const MAX_SIGNATURE_CHARS: usize = 256;

/// This server's audience: the origin of its configured public base URL,
/// serialized as the desktop serializes the API origin it uses.
pub(crate) fn server_audience() -> String {
    std::env::var("KORDI_CLOUD_PUBLIC_BASE_URL")
        .ok()
        .and_then(|value| http_origin(&value))
        .unwrap_or_else(|| DEFAULT_AUDIENCE.to_string())
}

fn http_origin(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host().is_some())
        .then(|| url.origin().ascii_serialization())
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

/// Whether a signed audience names `server`. The audience must be a
/// serialized origin. A loopback development server is the same audience
/// under any loopback host name, on the same scheme and port.
pub(crate) fn audience_matches(claimed: &str, server: &str) -> bool {
    if claimed.len() > MAX_AUDIENCE_CHARS || http_origin(claimed).as_deref() != Some(claimed) {
        return false;
    }
    if claimed == server {
        return true;
    }
    let (Ok(claimed), Ok(server)) = (Url::parse(claimed), Url::parse(server)) else {
        return false;
    };
    is_loopback(&claimed)
        && is_loopback(&server)
        && claimed.scheme() == server.scheme()
        && claimed.port_or_known_default() == server.port_or_known_default()
}

/// The exact text a device signs: the version and purpose, then one
/// `name:value` field per line, ending with the nonce.
pub(crate) fn proof_message(
    purpose: &str,
    audience: &str,
    account_id: &str,
    device_id: &str,
    fields: &[(&str, &str)],
    nonce: &str,
) -> String {
    let mut message = format!(
        "kordi-device-proof-v{PROOF_VERSION}\npurpose:{purpose}\naudience:{audience}\n\
         account:{account_id}\ndevice:{device_id}\n"
    );
    for (name, value) in fields {
        message.push_str(name);
        message.push(':');
        message.push_str(value);
        message.push('\n');
    }
    message.push_str("nonce:");
    message.push_str(nonce);
    message
}

/// Accepts a base64url signature in the fixed 64-byte form or in DER.
pub(crate) fn signature_matches(key: &VerifyingKey, message: &[u8], encoded: &str) -> bool {
    if encoded.len() > MAX_SIGNATURE_CHARS {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded.trim()) else {
        return false;
    };
    Signature::from_slice(&bytes)
        .or_else(|_| Signature::from_der(&bytes))
        .is_ok_and(|signature| key.verify(message, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_slice(&[seed; 32]).unwrap()
    }

    #[test]
    fn message_names_the_audience_and_device_on_their_own_lines() {
        assert_eq!(
            proof_message(
                "desktop-provider-auth",
                "https://kordi.ai",
                "acct_a",
                "dev_b",
                &[("run", "car_c"), ("claim", "claim-d")],
                "nonce-e"
            ),
            "kordi-device-proof-v2\npurpose:desktop-provider-auth\naudience:https://kordi.ai\n\
             account:acct_a\ndevice:dev_b\nrun:car_c\nclaim:claim-d\nnonce:nonce-e"
        );
    }

    #[test]
    fn only_this_servers_origin_is_its_audience() {
        let server = "https://kordi.ai";
        assert!(audience_matches("https://kordi.ai", server));
        for claimed in [
            "https://example.test",
            "http://kordi.ai",
            "https://kordi.ai:8443",
            "https://kordi.ai/",
            "https://kordi.ai/v1",
            "https://KORDI.ai",
            "https://kordi.ai\nnonce:x",
            "",
            "kordi.ai",
        ] {
            assert!(!audience_matches(claimed, server), "{claimed:?}");
        }
    }

    #[test]
    fn a_loopback_server_accepts_any_loopback_name_on_its_port() {
        let server = "http://127.0.0.1:17081";
        assert!(audience_matches("http://127.0.0.1:17081", server));
        assert!(audience_matches("http://localhost:17081", server));
        assert!(audience_matches("http://[::1]:17081", server));
        assert!(!audience_matches("http://localhost:17082", server));
        assert!(!audience_matches("https://localhost:17081", server));
        assert!(!audience_matches(
            "http://localhost:17081",
            "https://kordi.ai"
        ));
    }

    #[test]
    fn the_configured_public_base_url_is_normalized_to_an_origin() {
        assert_eq!(
            http_origin(" https://Kordi.AI/ ").as_deref(),
            Some("https://kordi.ai")
        );
        assert_eq!(
            http_origin("http://127.0.0.1:17083").as_deref(),
            Some("http://127.0.0.1:17083")
        );
        assert_eq!(
            http_origin("https://kordi.ai:443").as_deref(),
            Some("https://kordi.ai")
        );
        assert!(http_origin("ftp://kordi.ai").is_none());
        assert!(http_origin("not a url").is_none());
    }

    #[test]
    fn signatures_verify_only_for_the_signed_message_and_key() {
        let key = signing_key(7);
        let message = b"signed message";
        let signature: Signature = key.sign(message);
        let fixed = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let der = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
        let verifying = VerifyingKey::from(&key);

        assert!(signature_matches(&verifying, message, &fixed));
        assert!(signature_matches(&verifying, message, &der));
        assert!(!signature_matches(&verifying, b"other message", &fixed));
        assert!(!signature_matches(
            &VerifyingKey::from(&signing_key(8)),
            message,
            &fixed
        ));
        assert!(!signature_matches(&verifying, message, "not base64!"));
        assert!(!signature_matches(&verifying, message, ""));
        assert!(!signature_matches(&verifying, message, &"A".repeat(300)));
    }
}
