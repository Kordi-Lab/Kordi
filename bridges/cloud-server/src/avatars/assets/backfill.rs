use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::*;

pub async fn backfill_inline_avatars(
    pool: &PgPool,
    s3: &S3Config,
) -> Result<AvatarBackfillSummary, AvatarAssetError> {
    let mut summary = AvatarBackfillSummary::default();
    let accounts: Vec<(String, String)> = query_as(
        "SELECT account_id, avatar_url FROM cloud_accounts \
         WHERE avatar_source = 'uploaded' AND avatar_url LIKE 'data:image/%'",
    )
    .fetch_all(pool)
    .await?;
    for (account_id, legacy) in accounts {
        match migrate_one(pool, s3, &account_id, "human", &account_id, &legacy).await {
            Ok(true) => summary.migrated += 1,
            Ok(false) => summary.skipped += 1,
            Err(_) => summary.failed += 1,
        }
    }
    let agents: Vec<(String, String, String)> = query_as(
        "SELECT owner_account_id, agent_id, avatar_url FROM cloud_agent_definitions \
         WHERE avatar_source = 'uploaded' AND avatar_url LIKE 'data:image/%'",
    )
    .fetch_all(pool)
    .await?;
    for (owner_account_id, agent_id, legacy) in agents {
        match migrate_one(pool, s3, &owner_account_id, "agent", &agent_id, &legacy).await {
            Ok(true) => summary.migrated += 1,
            Ok(false) => summary.skipped += 1,
            Err(_) => summary.failed += 1,
        }
    }
    Ok(summary)
}

async fn migrate_one(
    pool: &PgPool,
    s3: &S3Config,
    owner_account_id: &str,
    entity_type: &str,
    entity_id: &str,
    legacy: &str,
) -> Result<bool, AvatarAssetError> {
    let Some(bytes) = legacy_avatar_data(legacy)? else {
        return Ok(false);
    };
    let marker =
        store_avatar_asset(pool, s3, owner_account_id, entity_type, entity_id, bytes).await?;
    let mut transaction = pool.begin().await?;
    let result = if entity_type == "human" {
        query(
            "UPDATE cloud_accounts SET avatar_url = $1, avatar_version = avatar_version + 1, \
             avatar_updated_at = $2, updated_at = $2 WHERE account_id = $3 AND avatar_url = $4",
        )
        .bind(&marker)
        .bind(Utc::now().to_rfc3339())
        .bind(entity_id)
        .bind(legacy)
        .execute(&mut *transaction)
        .await?
    } else {
        query(
            "UPDATE cloud_agent_definitions SET avatar_url = $1, avatar_version = avatar_version + 1, \
             avatar_updated_at = $2, updated_at = $2 \
             WHERE agent_id = $3 AND owner_account_id = $4 AND avatar_url = $5",
        )
        .bind(&marker)
        .bind(Utc::now().to_rfc3339())
        .bind(entity_id)
        .bind(owner_account_id)
        .bind(legacy)
        .execute(&mut *transaction)
        .await?
    };
    if result.rows_affected() == 1 {
        activate_avatar_asset(
            &mut transaction,
            owner_account_id,
            entity_type,
            entity_id,
            &marker,
        )
        .await?;
        transaction.commit().await?;
        return Ok(true);
    }
    transaction.rollback().await?;
    Ok(false)
}
