//! Encryption for provider-auth snapshot payloads at rest.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};

const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum ProviderAuthCipherError {
    #[error("provider auth encryption key is not configured")]
    MissingKey,
    #[error("provider auth ciphertext is invalid")]
    InvalidCiphertext,
    #[error("provider auth encryption failed")]
    Encrypt,
    #[error("provider auth decryption failed")]
    Decrypt,
}

pub trait ProviderAuthCipher: Send + Sync {
    fn key_id(&self) -> &str;
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
}

pub struct EnvProviderAuthCipher {
    key_id: String,
    cipher: Aes256Gcm,
}

impl EnvProviderAuthCipher {
    pub fn from_env() -> Result<Self, ProviderAuthCipherError> {
        let raw_key = std::env::var("KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY")
            .map_err(|_| ProviderAuthCipherError::MissingKey)?;
        if raw_key.trim().len() < 24 {
            return Err(ProviderAuthCipherError::MissingKey);
        }
        let key_id = std::env::var("KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "env:v1".to_string());
        let digest = Sha256::digest(raw_key.as_bytes());
        let key = Key::<Aes256Gcm>::from_slice(&digest);
        Ok(Self {
            key_id,
            cipher: Aes256Gcm::new(key),
        })
    }
}

impl ProviderAuthCipher for EnvProviderAuthCipher {
    fn key_id(&self) -> &str {
        &self.key_id
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        let mut nonce_bytes = [0_u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| ProviderAuthCipherError::Encrypt)?;
        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        if ciphertext.len() <= NONCE_LEN {
            return Err(ProviderAuthCipherError::InvalidCiphertext);
        }
        let (nonce_bytes, payload) = ciphertext.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        self.cipher
            .decrypt(nonce, payload)
            .map_err(|_| ProviderAuthCipherError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_cipher_round_trips_without_plaintext_ciphertext() {
        std::env::set_var(
            "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
            "unit-test-provider-auth-key-that-is-long-enough",
        );
        let cipher = EnvProviderAuthCipher::from_env().unwrap();
        let plaintext = br#"{"accessToken":"secret"}"#;
        let encrypted = cipher.encrypt(plaintext).unwrap();

        assert_ne!(encrypted, plaintext);
        assert!(!String::from_utf8_lossy(&encrypted).contains("secret"));
        assert_eq!(cipher.decrypt(&encrypted).unwrap(), plaintext);
    }
}
