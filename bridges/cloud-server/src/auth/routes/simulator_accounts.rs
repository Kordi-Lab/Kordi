//! Opt-in, operator-only creation of new synthetic accounts from a display name.
//! The generated login identifier is not a mailbox or a claim of email ownership.
use super::*;
use crate::auth::rate_limit::AccountActionLimit;
use rand::RngCore;
use sha2::{Digest, Sha256};

#[cfg(test)]
#[path = "simulator_accounts_tests.rs"]
mod tests;

const PATH: &str = "/v1/cloud/simulator/accounts";
const CREATE_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "simulator-account-create",
    limit: 20,
    window: std::time::Duration::from_secs(3600),
};

#[derive(Clone)]
struct Provisioner {
    pool: PgPool,
    operator_hash: [u8; 32],
    hasher: PasswordHasherConfig,
    limiter: Arc<CloudRateLimiter>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    display_name: String,
}

pub(super) fn routes(
    state: &ServerState,
    hasher: PasswordHasherConfig,
    limiter: Arc<CloudRateLimiter>,
) -> Router {
    configured(
        state.db_pool().clone(),
        hasher,
        limiter,
        std::env::var("KORDI_SIM_ACCOUNT_OPERATOR_TOKEN")
            .ok()
            .as_deref(),
    )
}
fn configured(
    pool: PgPool,
    hasher: PasswordHasherConfig,
    limiter: Arc<CloudRateLimiter>,
    token: Option<&str>,
) -> Router {
    let Some(token) = token.filter(|token| token.len() >= 32 && token.len() <= 1024) else {
        return Router::new();
    };
    let service = Provisioner {
        pool,
        operator_hash: Sha256::digest(token.as_bytes()).into(),
        hasher,
        limiter,
    };
    Router::new()
        .route(
            PATH,
            post(create).layer::<_, Infallible>(ConcurrencyLimitLayer::new(2)),
        )
        .layer(DefaultBodyLimit::max(1024))
        .with_state(service)
}
fn authorized(headers: &HeaderMap, expected: &[u8; 32]) -> bool {
    let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| token.len() >= 32 && token.len() <= 1024)
    else {
        return false;
    };
    let actual = Sha256::digest(token.as_bytes());
    actual
        .iter()
        .zip(expected)
        .fold(0u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}
fn unavailable() -> Response {
    err(
        "account_provisioning_unavailable",
        "Could not create simulator account.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}
async fn create(
    State(service): State<Provisioner>,
    headers: HeaderMap,
    Json(request): Json<CreateRequest>,
) -> Response {
    if !authorized(&headers, &service.operator_hash) {
        return err(
            "unauthorized",
            "Operator authorization required.",
            StatusCode::UNAUTHORIZED,
        );
    }
    let display_name = request.display_name.trim();
    if display_name.is_empty()
        || display_name.chars().count() > 80
        || display_name.chars().any(char::is_control)
    {
        return err(
            "invalid_display_name",
            "Display name must contain 1 to 80 characters without control characters.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let RateLimitDecision::Limited { retry_after } = service
        .limiter
        .observe_account_limit(CREATE_LIMIT, "simulator-account-operator")
        .await
    {
        return limited_response(retry_after);
    }
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let password = URL_SAFE_NO_PAD.encode(random);
    let hash = match tokio::task::spawn_blocking({
        let password = password.clone();
        move || hash_password(&password, service.hasher)
    })
    .await
    {
        Ok(Ok(hash)) => hash,
        _ => return unavailable(),
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_{id}");
    let login_id = format!("simulator-{id}@example.invalid");
    let seed = new_avatar_seed();
    let now = Utc::now().to_rfc3339();
    let avatar = crate::avatars::generated_avatar_marker(HUMAN_AVATAR_STYLE, &seed, 1);
    let Ok(mut tx) = service.pool.begin().await else {
        return unavailable();
    };
    // Plain INSERT only: this endpoint cannot select or overwrite an existing identity.
    let inserted = query("INSERT INTO cloud_accounts (account_id,display_name,primary_email,avatar_url,created_at,updated_at,password_hash,password_algorithm,password_updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,primary_email_verified_at) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$5,'generated',$8,$9,$10,1,$5,NULL)")
        .bind(&account_id).bind(display_name).bind(&login_id).bind(avatar).bind(&now)
        .bind(hash).bind(PASSWORD_ALGORITHM_ID).bind(HUMAN_AVATAR_STYLE).bind(seed).bind(AVATAR_RENDERER_VERSION)
        .execute(&mut *tx).await;
    if inserted.is_err() {
        return unavailable();
    }
    // Durable synthetic provenance, committed atomically with the account.
    let audited = query("INSERT INTO cloud_audit_events (event_id,account_id,event_type,metadata_json,created_at) VALUES ($1,$2,'simulator.account_created',$3,$4)")
        .bind(format!("audit_{}", uuid::Uuid::new_v4().simple())).bind(&account_id)
        .bind(r#"{"synthetic":true,"method":"operator"}"#).bind(&now)
        .execute(&mut *tx).await;
    if audited.is_err() || tx.commit().await.is_err() {
        return unavailable();
    }
    let mut response = (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "accountId":account_id,"displayName":display_name,"loginId":login_id,"password":password
        })),
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
