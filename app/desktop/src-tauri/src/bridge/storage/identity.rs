use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

use super::super::constants::BRIDGE_NODE_ID_PREFIX;
use super::config::{
    desktop_bridge_agent_identity_path, desktop_bridge_identity_path,
    ensure_owner_only_permissions, load_json_file, write_owner_only_json_file,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeIdentity {
    public_key: String,
    secret_key: String,
}

pub(in crate::bridge) fn derive_node_id(public_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key.as_bytes());
    let hash = hasher.finalize();
    format!(
        "{}{}",
        BRIDGE_NODE_ID_PREFIX,
        bs58::encode(&hash[..20]).into_string()
    )
}

pub(in crate::bridge) fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    let point = curve25519_dalek::edwards::CompressedEdwardsY(*ed_pub)
        .decompress()
        .ok_or_else(|| "invalid Ed25519 public key".to_string())?;
    Ok(point.to_montgomery().to_bytes())
}

fn decode_bridge_identity(
    existing: DesktopBridgeIdentity,
) -> Result<(SigningKey, VerifyingKey), String> {
    let secret = bs58::decode(existing.secret_key)
        .into_vec()
        .map_err(|err| err.to_string())?;
    let secret_bytes: [u8; 32] = secret.try_into().map_err(|bytes: Vec<u8>| {
        format!("Invalid bridge identity secret key length: {}", bytes.len())
    })?;
    let signing = SigningKey::from_bytes(&secret_bytes);
    let verifying = signing.verifying_key();
    Ok((signing, verifying))
}

fn write_bridge_identity(
    path: &Path,
    signing: &SigningKey,
    verifying: &VerifyingKey,
) -> Result<(), String> {
    let stored = DesktopBridgeIdentity {
        public_key: bs58::encode(verifying.as_bytes()).into_string(),
        secret_key: bs58::encode(signing.to_bytes()).into_string(),
    };
    write_owner_only_json_file(path, &stored)
}

pub(in crate::bridge) fn load_or_create_bridge_identity_for_agent(
    agent_id: &str,
) -> Result<(SigningKey, VerifyingKey), String> {
    let path = desktop_bridge_agent_identity_path(agent_id)?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&path) {
        let _ = ensure_owner_only_permissions(&path);
        return decode_bridge_identity(existing);
    }

    let legacy_identity_path = desktop_bridge_identity_path()?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&legacy_identity_path) {
        let _ = ensure_owner_only_permissions(&legacy_identity_path);
        let decoded = decode_bridge_identity(existing)?;
        write_bridge_identity(&path, &decoded.0, &decoded.1)?;
        return Ok(decoded);
    }

    let signing = SigningKey::generate(&mut OsRng);
    let verifying = signing.verifying_key();
    write_bridge_identity(&path, &signing, &verifying)?;
    Ok((signing, verifying))
}
