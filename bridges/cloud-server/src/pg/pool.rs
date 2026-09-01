//! Postgres pool + migration runner.
//!
//! `init_pool` opens a `sqlx::PgPool` against the supplied connection
//! string and applies every embedded migration exactly once. Applied
//! versions are tracked in `cloud_schema_versions` (independent of the
//! legacy `schema_versions` table the rusqlite path uses, so the two
//! paths never share state).
//!
//! Uses `sqlx-postgres` and `sqlx-core` directly (no `sqlx` umbrella) so
//! that the workspace dep graph doesn't pull `sqlx-sqlite`, which would
//! conflict with `bridges/cli`'s `rusqlite` at the `libsqlite3-sys`
//! `links` layer. SQL is embedded via `include_str!()` so the runtime
//! image doesn't need the `migrations/` directory shipped alongside.

use std::fmt;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};

#[derive(Debug)]
pub enum PgPoolError {
    Connect(sqlx_core::Error),
    Migrate(sqlx_core::Error),
}

impl fmt::Display for PgPoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(err) => write!(f, "connect to postgres: {err}"),
            Self::Migrate(err) => write!(f, "apply migrations: {err}"),
        }
    }
}

impl std::error::Error for PgPoolError {}

struct EmbeddedMigration {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

const EMBEDDED_MIGRATIONS: &[EmbeddedMigration] = &[
    EmbeddedMigration {
        version: 1,
        description: "initial cloud schema",
        sql: include_str!("../../migrations/0001_initial.sql"),
    },
    EmbeddedMigration {
        version: 2,
        description: "cloud_attachments table",
        sql: include_str!("../../migrations/0002_attachments.sql"),
    },
    EmbeddedMigration {
        version: 3,
        description: "cloud_contact_requests + approval flow",
        sql: include_str!("../../migrations/0003_contact_requests.sql"),
    },
    EmbeddedMigration {
        version: 4,
        description: "cloud_messages table",
        sql: include_str!("../../migrations/0004_cloud_messages.sql"),
    },
    EmbeddedMigration {
        version: 5,
        description: "cloud OAuth state table",
        sql: include_str!("../../migrations/0005_oauth_states.sql"),
    },
    EmbeddedMigration {
        version: 6,
        description: "allow self cloud messages",
        sql: include_str!("../../migrations/0006_allow_self_cloud_messages.sql"),
    },
    EmbeddedMigration {
        version: 7,
        description: "cloud message session ids",
        sql: include_str!("../../migrations/0007_cloud_message_session_ids.sql"),
    },
    EmbeddedMigration {
        version: 8,
        description: "cloud message attachment links",
        sql: include_str!("../../migrations/0008_cloud_message_attachments.sql"),
    },
    EmbeddedMigration {
        version: 9,
        description: "cloud sync events",
        sql: include_str!("../../migrations/0009_cloud_sync_events.sql"),
    },
    EmbeddedMigration {
        version: 10,
        description: "cloud session forks lineage",
        sql: include_str!("../../migrations/0010_cloud_session_forks.sql"),
    },
    EmbeddedMigration {
        version: 11,
        description: "direct person cloud session ids",
        sql: include_str!("../../migrations/0011_direct_person_session_ids.sql"),
    },
    EmbeddedMigration {
        version: 12,
        description: "cloud sync event session payloads",
        sql: include_str!("../../migrations/0012_cloud_sync_event_session_payloads.sql"),
    },
    EmbeddedMigration {
        version: 13,
        description: "cloud session activity",
        sql: include_str!("../../migrations/0013_cloud_session_activity.sql"),
    },
    EmbeddedMigration {
        version: 14,
        description: "cloud session visibility",
        sql: include_str!("../../migrations/0014_cloud_session_visibility.sql"),
    },
    EmbeddedMigration {
        version: 17,
        description: "cloud device presence",
        sql: include_str!("../../migrations/0017_cloud_device_presence.sql"),
    },
    EmbeddedMigration {
        version: 18,
        description: "cloud agent fallback runs",
        sql: include_str!("../../migrations/0018_cloud_agent_fallback_runs.sql"),
    },
    EmbeddedMigration {
        version: 19,
        description: "cloud agent provider auth snapshots",
        sql: include_str!("../../migrations/0019_cloud_agent_provider_auth_snapshots.sql"),
    },
    EmbeddedMigration {
        version: 20,
        description: "cloud agent sandboxes",
        sql: include_str!("../../migrations/0020_cloud_agent_sandboxes.sql"),
    },
    EmbeddedMigration {
        version: 21,
        description: "cloud agent run artifacts",
        sql: include_str!("../../migrations/0021_cloud_agent_run_artifacts.sql"),
    },
    EmbeddedMigration {
        version: 22,
        description: "scheduled task tool",
        sql: include_str!("../../migrations/0022_scheduled_task_tool.sql"),
    },
    EmbeddedMigration {
        version: 23,
        description: "cloud session pinned messages",
        sql: include_str!("../../migrations/0023_cloud_session_pins.sql"),
    },
    EmbeddedMigration {
        version: 24,
        description: "backfill stranded scheduled tasks",
        sql: include_str!("../../migrations/0024_backfill_stranded_scheduled_tasks.sql"),
    },
    EmbeddedMigration {
        version: 25,
        description: "cloud agent definitions",
        sql: include_str!("../../migrations/0025_cloud_agent_definitions.sql"),
    },
    EmbeddedMigration {
        version: 26,
        description: "cloud agent participant sharing",
        sql: include_str!("../../migrations/0026_cloud_agent_participant_sharing.sql"),
    },
    EmbeddedMigration {
        version: 28,
        description: "cloud read cursors",
        sql: include_str!("../../migrations/0028_cloud_read_cursors.sql"),
    },
    EmbeddedMigration {
        version: 29,
        description: "backfill cloud read cursors",
        sql: include_str!("../../migrations/0029_backfill_cloud_read_cursors.sql"),
    },
    EmbeddedMigration {
        version: 30,
        description: "mark self cloud messages read",
        sql: include_str!("../../migrations/0030_mark_self_cloud_messages_read.sql"),
    },
    EmbeddedMigration {
        version: 31,
        description: "cloud message attachment previews",
        sql: include_str!("../../migrations/0031_cloud_message_attachment_previews.sql"),
    },
    EmbeddedMigration {
        version: 32,
        description: "cloud message idempotency",
        sql: include_str!("../../migrations/0032_cloud_message_idempotency.sql"),
    },
    EmbeddedMigration {
        version: 33,
        description: "cloud session titles",
        sql: include_str!("../../migrations/0033_cloud_session_titles.sql"),
    },
    EmbeddedMigration {
        version: 35,
        description: "global support",
        sql: include_str!("../../migrations/0035_global_support.sql"),
    },
    EmbeddedMigration {
        version: 36,
        description: "public Kordi ids and app invitations",
        sql: include_str!("../../migrations/0036_public_kordi_ids_and_app_invitations.sql"),
    },
    EmbeddedMigration {
        version: 44,
        description: "group invitations",
        sql: include_str!("../../migrations/0044_group_invitations.sql"),
    },
    EmbeddedMigration {
        version: 45,
        description: "cloud message server receive order",
        sql: include_str!("../../migrations/0045_cloud_message_server_received_at.sql"),
    },
    EmbeddedMigration {
        version: 46,
        description: "cloud agent runtime routes",
        sql: include_str!("../../migrations/0046_cloud_agent_runtime_routes.sql"),
    },
    EmbeddedMigration {
        version: 47,
        description: "create reliable canonical chat sync",
        sql: include_str!("../../migrations/0047_reliable_chat_sync_v2.sql"),
    },
    EmbeddedMigration {
        version: 48,
        description: "backfill retained chat into canonical chat sync",
        sql: include_str!("../../migrations/0048_backfill_reliable_chat_sync_v2.sql"),
    },
    EmbeddedMigration {
        version: 49,
        description: "relink migrated agent responses to canonical requests",
        sql: include_str!("../../migrations/0049_relink_legacy_agent_responses.sql"),
    },
    EmbeddedMigration {
        version: 50,
        description: "canonical Cloud-agent artifact links",
        sql: include_str!("../../migrations/0050_chat_v2_artifact_links.sql"),
    },
    EmbeddedMigration {
        version: 51,
        description: "retire superseded chat storage and compatibility bridges",
        sql: include_str!("../../migrations/0051_retire_chat_sync_v1.sql"),
    },
    EmbeddedMigration {
        version: 52,
        description: "device authorizations and idempotent management operations",
        sql: include_str!("../../migrations/0052_device_authorizations.sql"),
    },
    EmbeddedMigration {
        version: 53,
        description: "coarse device location metadata",
        sql: include_str!("../../migrations/0053_device_approximate_location.sql"),
    },
    EmbeddedMigration {
        version: 54,
        description: "coarse OAuth device location metadata",
        sql: include_str!("../../migrations/0054_oauth_device_approximate_location.sql"),
    },
    EmbeddedMigration {
        version: 55,
        description: "call state and Apple notification tokens",
        sql: include_str!("../../migrations/0055_calls.sql"),
    },
    EmbeddedMigration {
        version: 56,
        description: "deduplicated message notification events",
        sql: include_str!("../../migrations/0056_message_notification_events.sql"),
    },
    EmbeddedMigration {
        version: 57,
        description: "durable per-device message notification delivery",
        sql: include_str!("../../migrations/0057_message_notification_deliveries.sql"),
    },
    EmbeddedMigration {
        version: 58,
        description: "verified meme media metadata",
        sql: include_str!("../../migrations/0058_meme_media_metadata.sql"),
    },
    EmbeddedMigration {
        version: 59,
        description: "account expressive media library",
        sql: include_str!("../../migrations/0059_expressive_media_library.sql"),
    },
    EmbeddedMigration {
        version: 60,
        description: "resumable attachment uploads",
        sql: include_str!("../../migrations/0060_resumable_attachment_uploads.sql"),
    },
    EmbeddedMigration {
        version: 61,
        description: "canonical generated and uploaded avatars",
        sql: include_str!("../../migrations/0061_canonical_avatars.sql"),
    },
    EmbeddedMigration {
        version: 62,
        description: "monotonic call revisions",
        sql: include_str!("../../migrations/0062_call_revisions.sql"),
    },
    EmbeddedMigration {
        version: 63,
        description: "account-scoped default self-agent sessions",
        sql: include_str!("../../migrations/0063_account_scoped_default_self_agent_sessions.sql"),
    },
    EmbeddedMigration {
        version: 64,
        description: "reference-backed uploaded avatar assets",
        sql: include_str!("../../migrations/0064_avatar_assets.sql"),
    },
    EmbeddedMigration {
        version: 65,
        description: "repair resumable attachment uploads",
        sql: include_str!("../../migrations/0065_repair_resumable_attachment_uploads.sql"),
    },
    EmbeddedMigration {
        version: 66,
        description: "quarantine legacy support conversations",
        sql: include_str!("../../migrations/0066_quarantine_legacy_support_conversations.sql"),
    },
    EmbeddedMigration {
        version: 67,
        description: "quarantine invalid support conversations",
        sql: include_str!("../../migrations/0067_quarantine_invalid_support_conversations.sql"),
    },
    EmbeddedMigration {
        version: 70,
        description: "expressive media deletion tombstones",
        sql: include_str!("../../migrations/0070_expressive_media_deletions.sql"),
    },
    EmbeddedMigration {
        version: 71,
        description: "chat message edit and deletion",
        sql: include_str!("../../migrations/0071_chat_message_mutations.sql"),
    },
    EmbeddedMigration {
        version: 72,
        description: "chat list preferences",
        sql: include_str!("../../migrations/0072_chat_list_preferences.sql"),
    },
    EmbeddedMigration {
        version: 73,
        description: "chat manual unread preference",
        sql: include_str!("../../migrations/0073_chat_manual_unread.sql"),
    },
    EmbeddedMigration {
        version: 74,
        description: "group space preferences",
        sql: include_str!("../../migrations/0074_group_space_preferences.sql"),
    },
];

/// Open a `PgPool` against `database_url`, configure conservative defaults,
/// and apply every embedded migration exactly once. Returns the pool ready
/// for handler use.
///
/// `database_url` is a standard libpq connection string, e.g.
/// `postgresql://kordi:<password>@postgres.kordi-cloud.svc.cluster.local:5432/kordi_cloud`.
pub async fn init_pool(database_url: &str) -> Result<PgPool, PgPoolError> {
    let options: PgConnectOptions = database_url.parse().map_err(PgPoolError::Connect)?;

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .idle_timeout(std::time::Duration::from_secs(60))
        .connect_with(options)
        .await
        .map_err(PgPoolError::Connect)?;

    apply_migrations(&pool).await?;
    Ok(pool)
}

async fn apply_migrations(pool: &PgPool) -> Result<(), PgPoolError> {
    query(
        "CREATE TABLE IF NOT EXISTS cloud_schema_versions (\n             version     BIGINT PRIMARY KEY,\n             description TEXT NOT NULL,\n             applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()\n         );",
    )
    .execute(pool)
    .await
    .map_err(PgPoolError::Migrate)?;

    for migration in EMBEDDED_MIGRATIONS {
        let already: Option<(i64,)> =
            query_as("SELECT version FROM cloud_schema_versions WHERE version = $1")
                .bind(migration.version)
                .fetch_optional(pool)
                .await
                .map_err(PgPoolError::Migrate)?;

        if already.is_some() {
            continue;
        }

        // Each migration runs in its own transaction so a partial failure
        // doesn't leave the schema in an inconsistent state. The migration
        // body uses the simple-query protocol (no prepare) so multi-statement
        // SQL is allowed; the version-tracking insert below is parameterised.
        let mut tx = pool.begin().await.map_err(PgPoolError::Migrate)?;
        sqlx_core::raw_sql::raw_sql(migration.sql)
            .execute(&mut *tx)
            .await
            .map_err(PgPoolError::Migrate)?;
        query("INSERT INTO cloud_schema_versions (version, description) VALUES ($1, $2)")
            .bind(migration.version)
            .bind(migration.description)
            .execute(&mut *tx)
            .await
            .map_err(PgPoolError::Migrate)?;
        tx.commit().await.map_err(PgPoolError::Migrate)?;
    }

    Ok(())
}
