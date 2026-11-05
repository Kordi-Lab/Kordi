//! Device code sign-in (RFC 8628) for hosts without a usable browser.
//!
//! The device asks for a code pair and shows the short user code. A person
//! signed in on the web types it on the approval page, checks the device
//! details, and approves or denies. Meanwhile the device polls with the long
//! device code; after approval the first poll starts an ordinary app sign-in
//! on a newly registered device, so it shows up and revokes in Settings like
//! any other. Only SHA-256 hashes of both codes are stored, and each code
//! pair is used once and lasts 15 minutes.
//!
//! See `docs/development/device-code-sign-in.md` for the endpoint contract.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::{Rng, RngCore};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use crate::auth::app_sign_in::codes::hash_code;

pub const DEVICE_CODE_PREFIX: &str = "kordi_dc_";
pub const DEVICE_CODE_LIFETIME_SECS: i64 = 15 * 60;
pub const POLL_INTERVAL_SECS: i32 = 5;
/// RFC 8628, section 3.5: every early poll adds five seconds.
const SLOW_DOWN_STEP_SECS: i32 = 5;
const MAX_POLL_INTERVAL_SECS: i32 = 60;
/// The path of the approval page on the public origin.
pub const VERIFICATION_PATH: &str = "/device";
/// The grant type the device polls with.
pub const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Consonants without look-alikes (RFC 8628, section 6.1): no vowels, so no
/// words, and none of 0/O, 1/I/L, 2/Z, 5/S, 8/B.
pub const USER_CODE_ALPHABET: &[u8] = b"CDFGHJKMNPQRTVWX";
pub const USER_CODE_LENGTH: usize = 8;
/// The warning the approval page shows above the device details.
pub const APPROVAL_WARNING: &str =
    "Only continue if you started this sign-in yourself. Never enter a code someone sent you.";

/// Why a device code was denied.
pub mod denied_reason {
    pub const USER_DENIED: &str = "user_denied";
    pub const ORGANIZATION_POLICY: &str = "organization_policy";
    pub const ACCOUNT_NOT_ADMITTED: &str = "account_not_admitted";
}

/// What the device reported about itself and where the request came from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceDetails {
    pub device_name: Option<String>,
    pub device_platform: Option<String>,
    pub device_os_version: Option<String>,
    pub device_app_version: Option<String>,
    pub device_public_key: Option<String>,
    pub device_key_algorithm: Option<String>,
    pub requester_ip: Option<String>,
    pub approximate_location: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedDeviceCode {
    pub device_code: String,
    /// Formatted for display, `XXXX-XXXX`.
    pub user_code: String,
    pub expires_at: DateTime<Utc>,
    pub interval_secs: i32,
}

/// A pending code as the approval page shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDeviceCode {
    pub client_id: String,
    pub details: DeviceDetails,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// The person has not decided yet.
    Pending,
    /// The device polled before its interval passed; the interval grew.
    SlowDown {
        interval_secs: i32,
    },
    Denied {
        reason: String,
    },
    Expired,
    /// Unknown code, or a code issued to another app.
    Invalid,
    /// The code was already redeemed; the sign-in it started, if any.
    AlreadyUsed {
        sign_in_id: Option<String>,
    },
    /// Approved: the code is now consumed and the caller starts the sign-in
    /// in the same transaction.
    Approved {
        account_id: String,
        details: DeviceDetails,
    },
}

fn random_device_code() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{DEVICE_CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn random_user_code() -> String {
    let mut rng = rand::thread_rng();
    (0..USER_CODE_LENGTH)
        .map(|_| char::from(USER_CODE_ALPHABET[rng.gen_range(0..USER_CODE_ALPHABET.len())]))
        .collect()
}

/// `ABCDEFGH` as `ABCD-EFGH`.
pub fn format_user_code(code: &str) -> String {
    let (left, right) = code.split_at(code.len() / 2);
    format!("{left}-{right}")
}

/// The canonical form of a typed user code: case, spaces and dashes do not
/// matter. `None` when it cannot be a user code.
pub fn normalize_user_code(input: &str) -> Option<String> {
    let code: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (code.len() == USER_CODE_LENGTH && code.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)))
        .then_some(code)
}

/// Issue a code pair for `client_id`. Expired rows older than a day are
/// removed first, which also keeps the user code space free.
pub async fn issue_device_code(
    pool: &PgPool,
    client_id: &str,
    details: &DeviceDetails,
) -> Result<IssuedDeviceCode, sqlx_core::Error> {
    let now = Utc::now();
    query("DELETE FROM cloud_device_authorizations WHERE expires_at < $1")
        .bind(now - Duration::days(1))
        .execute(pool)
        .await?;
    let expires_at = now + Duration::seconds(DEVICE_CODE_LIFETIME_SECS);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let device_code = random_device_code();
        let user_code = random_user_code();
        let inserted = query(
            "INSERT INTO cloud_device_authorizations \
             (device_code_hash, user_code_hash, client_id, device_name, device_platform, \
              device_os_version, device_app_version, device_public_key, device_key_algorithm, \
              requester_ip, approximate_location, created_at, expires_at, poll_interval_secs) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
             ON CONFLICT DO NOTHING",
        )
        .bind(hash_code(&device_code))
        .bind(hash_code(&user_code))
        .bind(client_id)
        .bind(&details.device_name)
        .bind(&details.device_platform)
        .bind(&details.device_os_version)
        .bind(&details.device_app_version)
        .bind(&details.device_public_key)
        .bind(&details.device_key_algorithm)
        .bind(&details.requester_ip)
        .bind(&details.approximate_location)
        .bind(now)
        .bind(expires_at)
        .bind(POLL_INTERVAL_SECS)
        .execute(pool)
        .await?
        .rows_affected();
        if inserted == 1 {
            return Ok(IssuedDeviceCode {
                device_code,
                user_code: format_user_code(&user_code),
                expires_at,
                interval_secs: POLL_INTERVAL_SECS,
            });
        }
        if attempt >= 5 {
            return Err(sqlx_core::Error::Protocol(
                "could not allocate a unique user code".into(),
            ));
        }
    }
}

type DetailsRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

const DETAILS_COLUMNS: &str = "device_name, device_platform, device_os_version, \
     device_app_version, device_public_key, device_key_algorithm, requester_ip, \
     approximate_location";

fn details(row: DetailsRow) -> DeviceDetails {
    let (name, platform, os, app, key, algorithm, ip, location) = row;
    DeviceDetails {
        device_name: name,
        device_platform: platform,
        device_os_version: os,
        device_app_version: app,
        device_public_key: key,
        device_key_algorithm: algorithm,
        requester_ip: ip,
        approximate_location: location,
    }
}

/// The pending, unexpired code a typed user code names.
pub async fn find_pending(
    pool: &PgPool,
    user_code: &str,
) -> Result<Option<PendingDeviceCode>, sqlx_core::Error> {
    let row: Option<(String, DateTime<Utc>, DateTime<Utc>, DetailsRow)> = query_as::<
        _,
        (
            String,
            DateTime<Utc>,
            DateTime<Utc>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(&format!(
        "SELECT client_id, created_at, expires_at, {DETAILS_COLUMNS} \
         FROM cloud_device_authorizations \
         WHERE user_code_hash = $1 AND status = 'pending' AND expires_at > $2"
    ))
    .bind(hash_code(user_code))
    .bind(Utc::now())
    .fetch_optional(pool)
    .await?
    .map(|(client, created, expires, a, b, c, d, e, f, g, h)| {
        (client, created, expires, (a, b, c, d, e, f, g, h))
    });
    Ok(row.map(
        |(client_id, created_at, expires_at, row)| PendingDeviceCode {
            client_id,
            details: details(row),
            created_at,
            expires_at,
        },
    ))
}

/// Record the signed-in person's decision on a pending code. Returns false
/// when the code is unknown, expired or already decided.
pub async fn decide(
    pool: &PgPool,
    user_code: &str,
    account_id: &str,
    approved: bool,
    denied: Option<&str>,
) -> Result<bool, sqlx_core::Error> {
    let now = Utc::now();
    let status = if approved { "approved" } else { "denied" };
    let reason = if approved {
        None
    } else {
        Some(denied.unwrap_or(denied_reason::USER_DENIED))
    };
    let updated = query(
        "UPDATE cloud_device_authorizations \
         SET status = $1, denied_reason = $2, account_id = $3, decided_at = $4 \
         WHERE user_code_hash = $5 AND status = 'pending' AND expires_at > $4",
    )
    .bind(status)
    .bind(reason)
    .bind(account_id)
    .bind(now)
    .bind(hash_code(user_code))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(updated == 1)
}

/// Deny an approved code at redemption, for example when the account's
/// organization turned device sign-in off after the approval.
pub async fn deny_at_redemption(
    transaction: &mut Transaction<'_, Postgres>,
    device_code: &str,
    reason: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_device_authorizations SET status = 'denied', denied_reason = $1 \
         WHERE device_code_hash = $2",
    )
    .bind(reason)
    .bind(hash_code(device_code))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// One poll of the token endpoint. Locks the row, enforces the interval
/// while the code is pending, and consumes an approved code.
pub async fn poll(
    transaction: &mut Transaction<'_, Postgres>,
    device_code: &str,
    client_id: &str,
) -> Result<PollOutcome, sqlx_core::Error> {
    if !device_code.starts_with(DEVICE_CODE_PREFIX) {
        return Ok(PollOutcome::Invalid);
    }
    let code_hash = hash_code(device_code);
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
        i32,
        Option<DateTime<Utc>>,
        Option<String>,
    );
    let row: Option<(Row, DetailsRow)> = query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<String>,
            DateTime<Utc>,
            i32,
            Option<DateTime<Utc>>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(&format!(
        "SELECT client_id, status, denied_reason, account_id, expires_at, poll_interval_secs, \
                last_polled_at, sign_in_id, {DETAILS_COLUMNS} \
         FROM cloud_device_authorizations WHERE device_code_hash = $1 FOR UPDATE"
    ))
    .bind(&code_hash)
    .fetch_optional(&mut **transaction)
    .await?
    .map(
        |(c, s, r, acct, exp, int, last, sid, a, b, cc, d, e, f, g, h)| {
            (
                (c, s, r, acct, exp, int, last, sid),
                (a, b, cc, d, e, f, g, h),
            )
        },
    );
    let Some((
        (owner, status, reason, account_id, expires_at, interval, last_polled_at, sign_in_id),
        details_row,
    )) = row
    else {
        return Ok(PollOutcome::Invalid);
    };
    if owner != client_id {
        return Ok(PollOutcome::Invalid);
    }
    let now = Utc::now();
    match status.as_str() {
        "consumed" => return Ok(PollOutcome::AlreadyUsed { sign_in_id }),
        "denied" => {
            return Ok(PollOutcome::Denied {
                reason: reason.unwrap_or_else(|| denied_reason::USER_DENIED.to_string()),
            })
        }
        _ => {}
    }
    if expires_at <= now {
        return Ok(PollOutcome::Expired);
    }
    if status == "approved" {
        let Some(account_id) = account_id else {
            return Ok(PollOutcome::Invalid);
        };
        query(
            "UPDATE cloud_device_authorizations \
             SET status = 'consumed', consumed_at = $1, last_polled_at = $1 \
             WHERE device_code_hash = $2",
        )
        .bind(now)
        .bind(&code_hash)
        .execute(&mut **transaction)
        .await?;
        return Ok(PollOutcome::Approved {
            account_id,
            details: details(details_row),
        });
    }
    let too_early =
        last_polled_at.is_some_and(|last| now - last < Duration::seconds(i64::from(interval)));
    let next_interval = if too_early {
        (interval + SLOW_DOWN_STEP_SECS).min(MAX_POLL_INTERVAL_SECS)
    } else {
        interval
    };
    query(
        "UPDATE cloud_device_authorizations SET last_polled_at = $1, poll_interval_secs = $2 \
         WHERE device_code_hash = $3",
    )
    .bind(now)
    .bind(next_interval)
    .bind(&code_hash)
    .execute(&mut **transaction)
    .await?;
    Ok(if too_early {
        PollOutcome::SlowDown {
            interval_secs: next_interval,
        }
    } else {
        PollOutcome::Pending
    })
}

/// Record the sign-in a redeemed code started, so a replay can revoke it.
pub async fn link_sign_in(
    transaction: &mut Transaction<'_, Postgres>,
    device_code: &str,
    sign_in_id: &str,
) -> Result<(), sqlx_core::Error> {
    query("UPDATE cloud_device_authorizations SET sign_in_id = $1 WHERE device_code_hash = $2")
        .bind(sign_in_id)
        .bind(hash_code(device_code))
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_codes_use_the_unambiguous_alphabet() {
        for _ in 0..200 {
            let code = random_user_code();
            assert_eq!(code.len(), USER_CODE_LENGTH);
            assert!(code.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)));
            let shown = format_user_code(&code);
            assert_eq!(shown.len(), 9);
            assert_eq!(&shown[4..5], "-");
            assert_eq!(normalize_user_code(&shown).as_deref(), Some(code.as_str()));
        }
        for ambiguous in b"AEIOU0125678BLSZY" {
            assert!(!USER_CODE_ALPHABET.contains(ambiguous));
        }
    }

    #[test]
    fn typed_codes_ignore_case_spaces_and_dashes() {
        assert_eq!(
            normalize_user_code(" cdfg-hjkm ").as_deref(),
            Some("CDFGHJKM")
        );
        assert_eq!(
            normalize_user_code("cd fg hj km").as_deref(),
            Some("CDFGHJKM")
        );
        assert_eq!(normalize_user_code("CDFG-HJK"), None);
        assert_eq!(normalize_user_code("CDFG-HJKA"), None);
        assert_eq!(normalize_user_code("CDFG-HJKMN"), None);
    }

    #[test]
    fn device_codes_are_long_and_prefixed() {
        let code = random_device_code();
        assert!(code.starts_with(DEVICE_CODE_PREFIX));
        assert!(code.len() >= DEVICE_CODE_PREFIX.len() + 43);
        assert_ne!(code, random_device_code());
        assert_eq!(DEVICE_CODE_LIFETIME_SECS, 900);
    }
}
