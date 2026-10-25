//! System: the server-managed account that posts notices, such as the
//! Grounding intro and the line when someone joins a Grounding group.
//! Clients show its messages as "System". It has no email, no sign-in and no
//! agent of its own. Like PiP it is a service member: it belongs to the
//! conversations it posts in, but is never listed, counted or removable as a
//! person.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::avatars::{
    generated_avatar_marker, random_bird_seed, AVATAR_RENDERER_VERSION, BIRD_AVATAR_STYLE,
    HUMAN_AVATAR_STYLE,
};
use crate::chat_sync::store::StoreError;

pub const SYSTEM_ACCOUNT_ID: &str = "acct_kordi_system";
pub const SYSTEM_DISPLAY_NAME: &str = "System";

/// Conversation kinds System may join.
const SYSTEM_CONVERSATION_KINDS: &[&str] = &["group"];

/// Whether `account_id` is a server-managed account: System, or PiP when it
/// runs on this server.
pub fn is_service_account(account_id: &str) -> bool {
    account_id == SYSTEM_ACCOUNT_ID || crate::pip::service_account_id() == Some(account_id)
}

/// Every server-managed account id, System first.
pub fn service_account_ids() -> Vec<String> {
    std::iter::once(SYSTEM_ACCOUNT_ID)
        .chain(crate::pip::service_account_id())
        .map(str::to_string)
        .collect()
}

/// Creates System's account and the default agent profile that member
/// listings join every member to. Rewrites nothing that is already right.
pub async fn ensure_account(pool: &PgPool) -> sqlx_core::Result<()> {
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts (
             account_id, display_name, primary_email, avatar_url, created_at, updated_at,
             avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version,
             avatar_updated_at
         ) VALUES ($1, $2, NULL, NULL, $3, $3, 'generated', $4, $1, $5, 1, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
         WHERE cloud_accounts.display_name IS DISTINCT FROM EXCLUDED.display_name",
    )
    .bind(SYSTEM_ACCOUNT_ID)
    .bind(SYSTEM_DISPLAY_NAME)
    .bind(&now)
    .bind(HUMAN_AVATAR_STYLE)
    .bind(AVATAR_RENDERER_VERSION)
    .execute(pool)
    .await?;
    let agent_seed = random_bird_seed();
    query(
        "INSERT INTO cloud_default_agent_profiles (
             owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
             avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
             created_at, updated_at
         ) VALUES ($1, $2, $3, 'generated', $4, $5, $6, 1, $7, $7, $7)
         ON CONFLICT (owner_account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
         WHERE cloud_default_agent_profiles.display_name IS DISTINCT FROM EXCLUDED.display_name",
    )
    .bind(SYSTEM_ACCOUNT_ID)
    .bind(SYSTEM_DISPLAY_NAME)
    .bind(generated_avatar_marker(BIRD_AVATAR_STYLE, &agent_seed, 1))
    .bind(BIRD_AVATAR_STYLE)
    .bind(&agent_seed)
    .bind(AVATAR_RENDERER_VERSION)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Sets up System's account at startup. A failure is logged; posting a
/// notice sets the account up again before it joins a group.
pub async fn bootstrap(pool: &PgPool) {
    if let Err(error) = ensure_account(pool).await {
        eprintln!("[system] Could not set up the System account: {error}");
    }
}

/// Adds System to a group so it can post notices there, telling members'
/// devices as any service member's join does. Returns whether it joined now.
pub async fn join(pool: &PgPool, conversation_id: Uuid) -> Result<bool, StoreError> {
    ensure_account(pool).await?;
    crate::chat_sync::store::join_service_member(
        pool,
        conversation_id,
        SYSTEM_ACCOUNT_ID,
        SYSTEM_CONVERSATION_KINDS,
    )
    .await
}
