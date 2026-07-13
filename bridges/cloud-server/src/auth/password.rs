//! Pure password and email handling for the Cloud Edition email/password flow.
//!
//! Stays free of any DB or HTTP code — call sites in `cloud_auth` compose this
//! with the existing `rusqlite` connection helpers and the axum router.

use std::fmt;

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use password_hash::{PasswordHash, SaltString};
use rand::rngs::OsRng;

pub const PASSWORD_ALGORITHM_ID: &str = "argon2id-v19-m65536-t3-p4";
pub const PASSWORD_MIN_LENGTH: usize = 8;
pub const PASSWORD_MAX_LENGTH: usize = 128;

/// Tunable cost knobs so tests can use cheap params and production uses OWASP-grade ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordHasherConfig {
    pub memory_cost_kib: u32,
    pub time_cost: u32,
    pub parallelism: u32,
}

impl PasswordHasherConfig {
    /// OWASP-recommended argon2id baseline (m=64MiB, t=3, p=4).
    pub const fn production() -> Self {
        Self {
            memory_cost_kib: 64 * 1024,
            time_cost: 3,
            parallelism: 4,
        }
    }

    /// Cheap params for unit/integration tests so the suite stays fast.
    pub const fn for_tests() -> Self {
        Self {
            memory_cost_kib: 8,
            time_cost: 1,
            parallelism: 1,
        }
    }
}

impl Default for PasswordHasherConfig {
    fn default() -> Self {
        Self::production()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordPolicyError {
    Empty,
    TooShort,
    TooLong,
    ContainsControlChar,
}

impl fmt::Display for PasswordPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "password must contain printable characters"),
            Self::TooShort => write!(
                f,
                "password must be at least {PASSWORD_MIN_LENGTH} characters"
            ),
            Self::TooLong => write!(
                f,
                "password must be at most {PASSWORD_MAX_LENGTH} characters"
            ),
            Self::ContainsControlChar => write!(f, "password must not contain control characters"),
        }
    }
}

impl std::error::Error for PasswordPolicyError {}

#[derive(Debug)]
pub enum PasswordHashError {
    Params(String),
    Hash(String),
    Parse(String),
}

impl fmt::Display for PasswordHashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Params(msg) => write!(f, "invalid argon2 parameters: {msg}"),
            Self::Hash(msg) => write!(f, "could not hash password: {msg}"),
            Self::Parse(msg) => write!(f, "could not parse stored password hash: {msg}"),
        }
    }
}

impl std::error::Error for PasswordHashError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmailFormatError {
    Empty,
    Malformed,
    TooLong,
}

impl fmt::Display for EmailFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "email must not be empty"),
            Self::Malformed => write!(f, "email must contain a single @ and a domain with a dot"),
            Self::TooLong => write!(f, "email must be at most 320 characters"),
        }
    }
}

impl std::error::Error for EmailFormatError {}

/// Validate a password against the in-house policy. Returns the trimmed-pass-through
/// for symmetry with `validate_email`, even though we don't trim spaces from passwords
/// (a leading/trailing space is part of the password).
pub fn validate_password_strength(plaintext: &str) -> Result<&str, PasswordPolicyError> {
    if plaintext.is_empty() {
        return Err(PasswordPolicyError::Empty);
    }
    if plaintext.chars().count() < PASSWORD_MIN_LENGTH {
        return Err(PasswordPolicyError::TooShort);
    }
    if plaintext.chars().count() > PASSWORD_MAX_LENGTH {
        return Err(PasswordPolicyError::TooLong);
    }
    if plaintext.chars().any(char::is_control) {
        return Err(PasswordPolicyError::ContainsControlChar);
    }
    Ok(plaintext)
}

/// Trim, lowercase, and shape-check an email address. Returns the normalized form
/// callers should persist and use for unique lookups.
pub fn validate_email(input: &str) -> Result<String, EmailFormatError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(EmailFormatError::Empty);
    }
    if trimmed.len() > 320 {
        return Err(EmailFormatError::TooLong);
    }
    let normalized = trimmed.to_ascii_lowercase();
    let mut parts = normalized.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return Err(EmailFormatError::Malformed); // multiple @
    }
    if local.is_empty() || domain.is_empty() {
        return Err(EmailFormatError::Malformed);
    }
    if !domain.contains('.') {
        return Err(EmailFormatError::Malformed);
    }
    if local.chars().any(|c| c.is_whitespace()) || domain.chars().any(|c| c.is_whitespace()) {
        return Err(EmailFormatError::Malformed);
    }
    Ok(normalized)
}

fn build_argon2(config: PasswordHasherConfig) -> Result<Argon2<'static>, PasswordHashError> {
    let params = Params::new(
        config.memory_cost_kib,
        config.time_cost,
        config.parallelism,
        None,
    )
    .map_err(|err| PasswordHashError::Params(err.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hash a password with argon2id. Returns the PHC-encoded string ready to store.
pub fn hash_password(
    plaintext: &str,
    config: PasswordHasherConfig,
) -> Result<String, PasswordHashError> {
    let argon2 = build_argon2(config)?;
    let salt = SaltString::generate(&mut OsRng);
    argon2
        .hash_password(plaintext.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| PasswordHashError::Hash(err.to_string()))
}

/// Verify a plaintext against a stored PHC hash. Constant-time inside argon2.
pub fn verify_password(stored_hash: &str, plaintext: &str) -> Result<bool, PasswordHashError> {
    let parsed =
        PasswordHash::new(stored_hash).map_err(|err| PasswordHashError::Parse(err.to_string()))?;
    Ok(Argon2::default()
        .verify_password(plaintext.as_bytes(), &parsed)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cheap() -> PasswordHasherConfig {
        PasswordHasherConfig::for_tests()
    }

    #[test]
    fn hash_round_trips_for_correct_password() {
        let hash = hash_password("correct horse", cheap()).expect("hash");
        assert!(verify_password(&hash, "correct horse").expect("verify"));
    }

    #[test]
    fn hash_rejects_wrong_password() {
        let hash = hash_password("correct horse", cheap()).expect("hash");
        assert!(!verify_password(&hash, "battery staple").expect("verify"));
    }

    #[test]
    fn hash_rejects_malformed_phc_string() {
        let result = verify_password("not-a-real-hash", "anything");
        assert!(matches!(result, Err(PasswordHashError::Parse(_))));
    }

    #[test]
    fn password_policy_blocks_short_long_and_control_chars() {
        assert!(matches!(
            validate_password_strength(""),
            Err(PasswordPolicyError::Empty)
        ));
        assert!(matches!(
            validate_password_strength("short"),
            Err(PasswordPolicyError::TooShort)
        ));
        assert!(matches!(
            validate_password_strength(&"a".repeat(PASSWORD_MAX_LENGTH + 1)),
            Err(PasswordPolicyError::TooLong)
        ));
        assert!(matches!(
            validate_password_strength("password\u{0007}"),
            Err(PasswordPolicyError::ContainsControlChar)
        ));
        assert_eq!(
            validate_password_strength("acceptable-password").unwrap(),
            "acceptable-password"
        );
    }

    #[test]
    fn email_validation_normalizes_and_rejects_obvious_garbage() {
        assert_eq!(
            validate_email("  Alice@Example.COM ").unwrap(),
            "alice@example.com"
        );
        assert!(matches!(validate_email(""), Err(EmailFormatError::Empty)));
        assert!(matches!(
            validate_email("noatsign"),
            Err(EmailFormatError::Malformed)
        ));
        assert!(matches!(
            validate_email("a@b"),
            Err(EmailFormatError::Malformed)
        ));
        assert!(matches!(
            validate_email("a@@b.c"),
            Err(EmailFormatError::Malformed)
        ));
        assert!(matches!(
            validate_email("a b@c.d"),
            Err(EmailFormatError::Malformed)
        ));
    }
}
