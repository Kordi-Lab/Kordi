//! Deleted account: the server-managed stand-in for every deleted person
//! (docs/development/account-deletion.md). Messages a deleted person sent in
//! groups that other people keep are moved to it, so clients show them as
//! "Deleted account" with no name, handle, avatar or email of the person.
//! It has no email, no sign-in and no agent of its own, and it only ever
//! belongs to a conversation as a member who left. Like System it is a
//! service account: never listed, counted, invited or made an owner.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgConnection;

use crate::avatars::{AGENT_AVATAR_STYLE, AVATAR_RENDERER_VERSION, HUMAN_AVATAR_STYLE};

pub const DELETED_ACCOUNT_ID: &str = "acct_kordi_deleted";
pub const DELETED_DISPLAY_NAME: &str = "Deleted account";

/// Creates the stand-in account and the default agent profile that member
/// listings join every member to. Rewrites nothing that is already right.
pub async fn ensure_account(connection: &mut PgConnection) -> sqlx_core::Result<()> {
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
    .bind(DELETED_ACCOUNT_ID)
    .bind(DELETED_DISPLAY_NAME)
    .bind(&now)
    .bind(HUMAN_AVATAR_STYLE)
    .bind(AVATAR_RENDERER_VERSION)
    .execute(&mut *connection)
    .await?;
    query(
        "INSERT INTO cloud_default_agent_profiles (
             owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
             avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
             created_at, updated_at
         ) VALUES ($1, $2, NULL, 'generated', $3, $1, $4, 1, $5, $5, $5)
         ON CONFLICT (owner_account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
         WHERE cloud_default_agent_profiles.display_name IS DISTINCT FROM EXCLUDED.display_name",
    )
    .bind(DELETED_ACCOUNT_ID)
    .bind(DELETED_DISPLAY_NAME)
    .bind(AGENT_AVATAR_STYLE)
    .bind(AVATAR_RENDERER_VERSION)
    .bind(&now)
    .execute(&mut *connection)
    .await?;
    Ok(())
}
