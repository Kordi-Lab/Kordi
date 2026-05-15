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
