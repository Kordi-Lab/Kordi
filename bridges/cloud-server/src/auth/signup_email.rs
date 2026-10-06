//! Signup email delivery and keyed code digests. Codes never enter logs or API responses.

use std::sync::Arc;

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, Rng};
use sha2::Sha256;

mod smtp;
mod store;

pub use store::SignupCodeChallenge;
pub(crate) use store::{
    consume_account_email_code, consume_signup_code, request_account_email_code,
    request_signup_code, SignupCodeError,
};

/// Injectable delivery boundary; production uses SMTP, tests use a private inbox.
#[async_trait]
pub trait SignupCodeSender: Send + Sync {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str>;
}

pub struct SignupEmailService {
    sender: Arc<dyn SignupCodeSender>,
    mac_key: Vec<u8>,
}

impl SignupEmailService {
    pub fn new(sender: Arc<dyn SignupCodeSender>, mac_key: Vec<u8>) -> Result<Self, &'static str> {
        if mac_key.len() < 32 {
            return Err("Signup email code key must contain at least 32 bytes.");
        }
        Ok(Self { sender, mac_key })
    }

    pub fn from_env() -> Option<Self> {
        let key = std::env::var("KORDI_AUTH_EMAIL_CODE_SECRET").ok()?;
        Self::new(
            Arc::new(smtp::SmtpSignupCodeSender::from_env()?),
            key.into_bytes(),
        )
        .ok()
    }

    fn code_mac(&self, id: &str, email: &str, code: &str) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.mac_key).expect("valid HMAC key");
        for part in [id, email, code] {
            mac.update(part.as_bytes());
            mac.update(&[0]);
        }
        mac
    }

    fn digest(&self, id: &str, email: &str, code: &str) -> Vec<u8> {
        self.code_mac(id, email, code)
            .finalize()
            .into_bytes()
            .to_vec()
    }

    fn matches(&self, id: &str, email: &str, code: &str, digest: &[u8]) -> bool {
        self.code_mac(id, email, code).verify_slice(digest).is_ok()
    }
}

fn new_code() -> String {
    format!("{:06}", OsRng.gen_range(0..1_000_000_u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct UnavailableSender;
    #[async_trait]
    impl SignupCodeSender for UnavailableSender {
        async fn send_code(&self, _: &str, _: &str) -> Result<(), &'static str> {
            Err("Unavailable")
        }
    }

    #[test]
    fn codes_are_six_ascii_digits_and_mac_is_bound_to_challenge_and_email() {
        let service = SignupEmailService::new(Arc::new(UnavailableSender), vec![7; 32]).unwrap();
        for _ in 0..100 {
            let code = new_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
            let digest = service.digest("challenge", "owner@example.com", &code);
            assert!(service.matches("challenge", "owner@example.com", &code, &digest));
            assert!(!service.matches("other", "owner@example.com", &code, &digest));
            assert!(!service.matches("challenge", "other@example.com", &code, &digest));
            assert!(!service.matches("challenge", "owner@example.com", "wrong", &digest));
        }
    }
}
