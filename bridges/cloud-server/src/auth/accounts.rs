//! Cloud account / identity / device DB layer (Postgres-backed).
//!
//! OAuth identity upserts, device registration, profile updates. The
//! email/password flow uses cloud_accounts directly via auth/routes.rs;
//! the OAuth path here is wired in but not yet exposed via routes.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::avatars::{
    generated_avatar_marker, new_avatar_seed, AVATAR_RENDERER_VERSION, HUMAN_AVATAR_STYLE,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OAuthProviderId {
    GitHub,
    Google,
    X,
}

impl OAuthProviderId {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" => Some(Self::GitHub),
            "google" => Some(Self::Google),
            "x" | "twitter" => Some(Self::X),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::Google => "google",
            Self::X => "x",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthProviderDescriptor {
    pub id: OAuthProviderId,
    pub display_name: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthProviderRegistry {
    providers: Vec<OAuthProviderDescriptor>,
}

impl OAuthProviderRegistry {
    pub fn new(providers: Vec<OAuthProviderDescriptor>) -> Self {
        Self { providers }
    }

    pub fn providers(&self) -> &[OAuthProviderDescriptor] {
        &self.providers
    }

    pub fn provider(&self, id: &str) -> Option<&OAuthProviderDescriptor> {
        let id = OAuthProviderId::parse(id)?;
        self.providers.iter().find(|provider| provider.id == id)
    }
}

pub fn default_oauth_provider_registry() -> OAuthProviderRegistry {
    OAuthProviderRegistry::new(vec![
        OAuthProviderDescriptor {
            id: OAuthProviderId::GitHub,
            display_name: "GitHub",
        },
        OAuthProviderDescriptor {
            id: OAuthProviderId::Google,
            display_name: "Google",
        },
        OAuthProviderDescriptor {
            id: OAuthProviderId::X,
            display_name: "X",
        },
    ])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentityUpsert {
    pub provider: OAuthProviderId,
    pub provider_subject: String,
    pub provider_username: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub email_verified: bool,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentityRecord {
    pub account_id: String,
    pub identity_id: String,
    pub created_account: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDeviceRegistration {
    pub account_id: String,
    pub device_name: Option<String>,
    pub device_public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDeviceRecord {
    pub device_id: String,
    pub account_id: String,
}

fn new_prefixed_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4().simple())
}

/// Upsert an OAuth identity. If `(provider, provider_subject)` exists, link
/// to the existing account. Otherwise create a new cloud_accounts row +
/// cloud_account_identities row in a single transaction.
pub async fn upsert_account_identity(
    pool: &PgPool,
    upsert: AccountIdentityUpsert,
) -> Result<AccountIdentityRecord, sqlx_core::Error> {
    let mut tx = pool.begin().await?;

    let existing: Option<(String, String)> = query_as(
        "SELECT account_id, identity_id FROM cloud_account_identities \
         WHERE provider = $1 AND provider_subject = $2",
    )
    .bind(upsert.provider.as_str())
    .bind(&upsert.provider_subject)
    .fetch_optional(&mut *tx)
    .await?;

    let now = Utc::now().to_rfc3339();

    if let Some((account_id, identity_id)) = existing {
        query(
            "UPDATE cloud_account_identities SET \
             provider_username = $1, email = $2, email_verified = $3, \
             avatar_url = $4, updated_at = $5 \
             WHERE identity_id = $6",
        )
        .bind(upsert.provider_username.as_deref())
        .bind(upsert.email.as_deref())
        .bind(upsert.email_verified)
        .bind(upsert.avatar_url.as_deref())
        .bind(&now)
        .bind(&identity_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(AccountIdentityRecord {
            account_id,
            identity_id,
            created_account: false,
        });
    }

    let account_id = new_prefixed_id("acct");
    let identity_id = new_prefixed_id("ident");
    let avatar_seed = new_avatar_seed();
    let provider_avatar = upsert
        .avatar_url
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let avatar_url = provider_avatar
        .map(ToString::to_string)
        .unwrap_or_else(|| generated_avatar_marker(HUMAN_AVATAR_STYLE, &avatar_seed, 1));

    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, avatar_url, created_at, updated_at, \
          avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, 1, $5)",
    )
    .bind(&account_id)
    .bind(upsert.display_name.as_deref())
    .bind(upsert.email.as_deref())
    .bind(&avatar_url)
    .bind(&now)
    .bind(if provider_avatar.is_some() { "uploaded" } else { "generated" })
    .bind(HUMAN_AVATAR_STYLE)
    .bind(&avatar_seed)
    .bind(AVATAR_RENDERER_VERSION)
    .execute(&mut *tx)
    .await?;

    query(
        "INSERT INTO cloud_account_identities \
         (identity_id, account_id, provider, provider_subject, provider_username, \
          email, email_verified, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)",
    )
    .bind(&identity_id)
    .bind(&account_id)
    .bind(upsert.provider.as_str())
    .bind(&upsert.provider_subject)
    .bind(upsert.provider_username.as_deref())
    .bind(upsert.email.as_deref())
    .bind(upsert.email_verified)
    .bind(upsert.avatar_url.as_deref())
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(AccountIdentityRecord {
        account_id,
        identity_id,
        created_account: true,
    })
}

/// Register a device for an existing cloud account.
pub async fn register_cloud_device(
    pool: &PgPool,
    registration: CloudDeviceRegistration,
) -> Result<CloudDeviceRecord, sqlx_core::Error> {
    let device_id = new_prefixed_id("dev");
    let now = Utc::now().to_rfc3339();

    query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&registration.account_id)
    .bind(registration.device_name.as_deref())
    .bind(&registration.device_public_key)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(CloudDeviceRecord {
        device_id,
        account_id: registration.account_id,
    })
}

/// Check whether `device_id` belongs to `account_id` (and is non-revoked).
pub async fn cloud_device_belongs_to_account(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_devices \
         WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}
