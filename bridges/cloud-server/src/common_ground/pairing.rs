//! One-to-one pairing. One person shows a short code (as a QR code or
//! text, or sends it over a phone tap); the other redeems it. A code lasts
//! two minutes and works once. Each side shares one profile: the code
//! carries the profile of the person who shows it, and pairing makes each
//! of the two profiles' cards visible to the other person.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};

use super::profiles::{self, Profile};
use super::{
    card, db_error, err, limited, people, PAIR_CODE_LIMIT, PAIR_IP_LIMIT, PAIR_REDEEM_LIMIT,
};
use crate::auth::rate_limit::{rate_limit_client_key, CloudRateLimiter, RateLimitDecision};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Crockford base32 without I, L, O and U, so codes read aloud cleanly.
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS: usize = 8;
const CODE_SECONDS: i64 = 120;

fn new_code() -> String {
    let mut rng = rand::thread_rng();
    (0..CODE_CHARS)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Upper case without separators; the commonly confused letters map to the
/// digits they look like.
pub(super) fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect()
}

fn hash(code: &str) -> String {
    hex::encode(Sha256::digest(normalize(code).as_bytes()))
}

/// `ABCD-EFGH` for display.
fn display(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

async fn observe(
    rate_limiter: &CloudRateLimiter,
    limits: &[(crate::auth::rate_limit::AccountActionLimit, &str)],
) -> Option<Response> {
    for (limit, key) in limits {
        if let RateLimitDecision::Limited { retry_after } =
            rate_limiter.observe_account_limit(*limit, key).await
        {
            return Some(limited(retry_after));
        }
    }
    None
}

/// The profile to share, chosen as [`profiles::choose`] does, with a shared
/// card; or the response to send instead.
async fn sharing_profile(
    pool: &sqlx_postgres::PgPool,
    account: &str,
    requested: Option<&str>,
    suggested_kind: Option<&str>,
) -> Result<Profile, Response> {
    let Some(profile) = profiles::choose(pool, account, requested, suggested_kind).await? else {
        return Err(card::no_card());
    };
    match profiles::require_shared_card(pool, &profile).await {
        Some(response) => Err(response),
        None => Ok(profile),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct CodeRequest {
    /// The profile to share; the default profile when omitted.
    profile_id: Option<String>,
}

/// `POST /v1/cloud/common-ground/pairings/code`: a fresh code to show.
pub(super) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    body: Option<Json<CodeRequest>>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    if let Some(response) = observe(&rate_limiter, &[(PAIR_CODE_LIMIT, account)]).await {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let profile = match sharing_profile(pool, account, body.profile_id.as_deref(), None).await {
        Ok(profile) => profile,
        Err(response) => return response,
    };
    let code = new_code();
    let result = async {
        let mut tx = pool.begin().await?;
        // Only the newest code works, and spent or expired codes are dropped.
        query(
            "DELETE FROM cloud_common_ground_pairing_codes
             WHERE account_id = $1 OR expires_at < now() - interval '1 hour'",
        )
        .bind(account)
        .execute(&mut *tx)
        .await?;
        let (expires_at,): (DateTime<Utc>,) = query_as(
            "INSERT INTO cloud_common_ground_pairing_codes
                 (code_hash, account_id, profile_id, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING expires_at",
        )
        .bind(hash(&code))
        .bind(account)
        .bind(&profile.profile_id)
        .bind(CODE_SECONDS as f64)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(expires_at)
    }
    .await;
    match result {
        Ok(expires_at) => (
            StatusCode::CREATED,
            Json(json!({
                "code": display(&code),
                "expiresAt": expires_at,
                "profileId": profile.profile_id,
            })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RedeemRequest {
    code: String,
    /// The profile to share. Without it: your built profile of the same
    /// kind as the one behind the code, else your default profile.
    #[serde(default)]
    profile_id: Option<String>,
}

fn code_not_found() -> Response {
    err(
        "common_ground_code_not_found",
        "Code not found or expired.",
        StatusCode::NOT_FOUND,
    )
}

/// `POST /v1/cloud/common-ground/pairings/redeem`: pairs you with the
/// person who showed the code and returns their card.
pub(super) async fn redeem(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<RedeemRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let client =
        crate::client_ip::resolve_client_ip(&headers, connect_info.map(|info| info.0.ip()));
    let ip_key = format!("ip:{}", rate_limit_client_key(client));
    let limits = [
        (PAIR_REDEEM_LIMIT, account),
        (PAIR_IP_LIMIT, ip_key.as_str()),
    ];
    if let Some(response) = observe(&rate_limiter, &limits).await {
        return response;
    }
    if normalize(&body.code).len() != CODE_CHARS {
        return code_not_found();
    }
    // The kind behind the code preselects the profile you share back.
    let shown: Result<Option<(String,)>, _> = query_as(
        "SELECT profile.kind FROM cloud_common_ground_pairing_codes code
         JOIN cloud_common_ground_profiles profile ON profile.profile_id = code.profile_id
         WHERE code.code_hash = $1 AND code.redeemed_at IS NULL AND code.expires_at > now()",
    )
    .bind(hash(&body.code))
    .fetch_optional(pool)
    .await;
    let kind = match shown {
        Ok(shown) => shown.map(|(kind,)| kind),
        Err(error) => return db_error(error),
    };
    let profile =
        match sharing_profile(pool, account, body.profile_id.as_deref(), kind.as_deref()).await {
            Ok(profile) => profile,
            Err(response) => return response,
        };
    let mine = profile.profile_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        let owner: Option<(String, String)> = query_as(
            "UPDATE cloud_common_ground_pairing_codes SET redeemed_at = now(), redeemed_by = $2
             WHERE code_hash = $1 AND account_id <> $2 AND redeemed_at IS NULL
               AND expires_at > now()
             RETURNING account_id, profile_id",
        )
        .bind(hash(&body.code))
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((owner, theirs)) = owner else {
            return Ok(None);
        };
        // `profile_a` belongs to the smaller account id.
        let (a, b, profile_a, profile_b) = if account < owner.as_str() {
            (account, owner.as_str(), mine, theirs.as_str())
        } else {
            (owner.as_str(), account, theirs.as_str(), mine)
        };
        query(
            "INSERT INTO cloud_common_ground_pairings (account_a, account_b, profile_a, profile_b)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        )
        .bind(a)
        .bind(b)
        .bind(profile_a)
        .bind(profile_b)
        .execute(&mut *tx)
        .await?;
        super::hint(
            &mut tx,
            &owner,
            "common_ground.paired",
            json!({ "accountId": account }),
        )
        .await?;
        super::hint(
            &mut tx,
            account,
            "common_ground.paired",
            json!({ "accountId": owner }),
        )
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(Some(owner))
    }
    .await;
    let owner = match result {
        Ok(Some(owner)) => owner,
        Ok(None) => return code_not_found(),
        Err(error) => return db_error(error),
    };
    match people::shared_view(pool, account, &owner, Some(mine)).await {
        Ok(Some(view)) => (StatusCode::OK, Json(view)).into_response(),
        // They turned sharing off a moment ago; the pairing stands.
        Ok(None) => people::not_found(),
        Err(error) => db_error(error),
    }
}

type PairedRow = (
    String,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
    String,
    String,
    String,
    String,
);

/// `GET /v1/cloud/common-ground/pairings`: people you paired with, newest
/// first, once per pair of profiles, with the profile each side shares.
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: sqlx_core::Result<Vec<PairedRow>> = query_as(
        "SELECT account.account_id, account.display_name, account.avatar_url, pairing.created_at,
                CASE WHEN pairing.account_a = $1 THEN pairing.profile_a ELSE pairing.profile_b END,
                theirs.profile_id, theirs.kind, theirs.name
         FROM cloud_common_ground_pairings pairing
         JOIN cloud_accounts account ON account.account_id =
             CASE WHEN pairing.account_a = $1 THEN pairing.account_b ELSE pairing.account_a END
         JOIN cloud_common_ground_profiles theirs ON theirs.profile_id =
             CASE WHEN pairing.account_a = $1 THEN pairing.profile_b ELSE pairing.profile_a END
         WHERE pairing.account_a = $1 OR pairing.account_b = $1
         ORDER BY pairing.created_at DESC LIMIT 200",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => {
            let people: Vec<_> = rows
                .into_iter()
                .map(
                    |(account_id, name, avatar_url, paired_at, mine, theirs, kind, label)| {
                        let mut person =
                            people::person(&account_id, name.as_deref(), avatar_url.as_deref());
                        person["pairedAt"] = json!(paired_at);
                        person["profile"] = profiles::tag(&theirs, &kind, &label);
                        person["profileId"] = json!(mine);
                        person
                    },
                )
                .collect();
            (StatusCode::OK, Json(json!({ "people": people }))).into_response()
        }
        Err(error) => db_error(error),
    }
}

#[cfg(test)]
pub(super) fn display_for_tests(code: &str) -> String {
    display(code)
}

#[cfg(test)]
pub(super) fn new_code_for_tests() -> String {
    new_code()
}
