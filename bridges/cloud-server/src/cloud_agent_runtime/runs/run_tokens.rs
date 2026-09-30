//! Run-scoped runner credentials.
//!
//! The shared runner token identifies a runner and lets it lease work. Each
//! lease also issues a random token that is bound to that one run: only its
//! SHA-256 hash is stored with the lease, a later lease replaces it, and it is
//! accepted only while the lease that issued it is current. Run-specific
//! runner endpoints require both credentials.

use rand::RngCore;
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::RunResult;

/// Header that carries the run-scoped token on run-specific runner requests.
pub const RUN_TOKEN_HEADER: &str = "x-kordi-run-token";

/// A freshly issued run token. It is returned once in the lease response and
/// never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct IssuedRunToken(String);

impl IssuedRunToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for IssuedRunToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("IssuedRunToken(..)")
    }
}

impl Serialize for IssuedRunToken {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// Issues a new run token and the hash to store with the lease.
pub(crate) fn issue_run_token() -> (IssuedRunToken, String) {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let hash = hash_run_token(&token);
    (IssuedRunToken(token), hash)
}

pub fn hash_run_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Compares two secrets without an early exit on the first differing byte.
/// Both inputs are hashed first so the comparison length does not depend on
/// the presented value.
pub(crate) fn secrets_match(presented: &str, expected: &str) -> bool {
    let presented = Sha256::digest(presented.as_bytes());
    let expected = Sha256::digest(expected.as_bytes());
    presented
        .iter()
        .zip(expected.iter())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

/// Whether `presented` is the token issued with the current cloud lease of
/// `run_id`. A missing token, another run's token, a replaced token, or an
/// expired lease is rejected.
pub(crate) async fn run_token_matches(
    pool: &PgPool,
    run_id: &str,
    presented: Option<&str>,
) -> RunResult<bool> {
    let Some(presented) = presented.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    let stored: Option<(Option<String>,)> = query_as(
        "SELECT runner_run_token_hash FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND execution_backend = 'cloud' \
           AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((Some(stored_hash),)) = stored else {
        return Ok(false);
    };
    Ok(secrets_match(&hash_run_token(presented), &stored_hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_tokens_are_random_and_only_their_hash_is_stored() {
        let (first, first_hash) = issue_run_token();
        let (second, second_hash) = issue_run_token();
        assert_ne!(first, second);
        assert_ne!(first_hash, second_hash);
        assert_eq!(first.as_str().len(), 64);
        assert_eq!(first_hash, hash_run_token(first.as_str()));
        assert_ne!(first_hash, first.as_str());
    }

    #[test]
    fn issued_tokens_are_redacted_from_debug_output() {
        let (token, _) = issue_run_token();
        assert!(!format!("{token:?}").contains(token.as_str()));
        assert_eq!(
            serde_json::to_value(&token).unwrap(),
            serde_json::json!(token.as_str())
        );
    }

    #[test]
    fn secrets_match_only_identical_values() {
        assert!(secrets_match("runner-secret", "runner-secret"));
        assert!(!secrets_match("runner-secret", "runner-secreT"));
        assert!(!secrets_match("runner-secret", "runner-secret "));
        assert!(!secrets_match("", "runner-secret"));
        assert!(!secrets_match("runner-secret-longer", "runner-secret"));
    }
}
