use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

use crate::crypto;
use crate::error::IdentityError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKeypair {
    pub public_key: String,
    pub secret_key: String,
}

/// Wrapper around Ed25519 keypair with convenience accessors.
pub struct NodeKeypair {
    pub signing: SigningKey,
}

/// Derive X25519 private key from an Ed25519 keypair (for key agreement).
pub fn x25519_private_key(keypair: &NodeKeypair) -> [u8; 32] {
    let secret_bytes: [u8; 32] = keypair.signing.to_bytes();
    crypto::ed25519_to_x25519_private(&secret_bytes)
}

/// Directory where identity files live: ~/.bridges/identity/
fn identity_dir() -> Result<PathBuf, IdentityError> {
    let base = directories::BaseDirs::new().ok_or(IdentityError::HomeDirUnavailable)?;
    Ok(base.home_dir().join(".bridges").join("identity"))
}

fn keypair_path() -> Result<PathBuf, IdentityError> {
    Ok(identity_dir()?.join("keypair.json"))
}

pub fn replace_keypair(signing: &SigningKey) -> Result<PathBuf, IdentityError> {
    save_keypair(signing)?;
    keypair_path()
}

fn generate_signing_key() -> SigningKey {
    SigningKey::generate(&mut OsRng)
}

/// Generate a fresh Ed25519 keypair and persist it.
pub fn generate_keypair() -> Result<(SigningKey, VerifyingKey), IdentityError> {
    let signing = generate_signing_key();
    let verifying = signing.verifying_key();
    save_keypair(&signing)?;
    Ok((signing, verifying))
}

/// Generate a fresh Ed25519 keypair without persisting it.
pub fn generate_ephemeral_keypair() -> (SigningKey, VerifyingKey) {
    let signing = generate_signing_key();
    let verifying = signing.verifying_key();
    (signing, verifying)
}

fn load_keypair() -> Result<(SigningKey, VerifyingKey), IdentityError> {
    let path = keypair_path()?;
    let data = fs::read_to_string(&path).map_err(|source| IdentityError::Read {
        path: path.clone(),
        source,
    })?;
    let stored: StoredKeypair =
        serde_json::from_str(&data).map_err(|source| IdentityError::Parse {
            path: path.clone(),
            source,
        })?;
    let secret_bytes = bs58::decode(&stored.secret_key)
        .into_vec()
        .map_err(|source| IdentityError::DecodeSecretKey {
            source: source.to_string(),
        })?;
    let secret: [u8; 32] = secret_bytes.try_into().map_err(|bytes: Vec<u8>| {
        IdentityError::InvalidSecretKeyLength {
            actual: bytes.len(),
        }
    })?;
    let signing = SigningKey::from_bytes(&secret);
    let verifying = signing.verifying_key();
    Ok((signing, verifying))
}

pub fn load_existing_keypair() -> Result<Option<(SigningKey, VerifyingKey)>, IdentityError> {
    match load_keypair() {
        Ok(keys) => Ok(Some(keys)),
        Err(IdentityError::Read { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

/// Load existing keypair or generate a new one.
pub fn load_or_create_keypair() -> Result<(SigningKey, VerifyingKey), IdentityError> {
    match load_existing_keypair()? {
        Some(keys) => Ok(keys),
        None => generate_keypair(),
    }
}

fn save_keypair(signing: &SigningKey) -> Result<(), IdentityError> {
    let dir = identity_dir()?;
    fs::create_dir_all(&dir).map_err(|source| IdentityError::CreateDir {
        path: dir.clone(),
        source,
    })?;
    let stored = StoredKeypair {
        public_key: bs58::encode(signing.verifying_key().as_bytes()).into_string(),
        secret_key: bs58::encode(signing.to_bytes()).into_string(),
    };
    let json = serde_json::to_string_pretty(&stored).map_err(IdentityError::Serialize)?;
    let path = keypair_path()?;
    fs::write(&path, json).map_err(|source| IdentityError::Write { path, source })
}

/// Derive a node ID: `kd_` + base58(sha256(pubkey)[:20])
pub fn derive_node_id(public_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key.as_bytes());
    let hash = hasher.finalize();
    let truncated = &hash[..20];
    format!("kd_{}", bs58::encode(truncated).into_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_prefix() {
        let signing = SigningKey::generate(&mut OsRng);
        let id = derive_node_id(&signing.verifying_key());
        assert!(id.starts_with("kd_"));
    }
}
