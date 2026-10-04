//! The renumbering statements in the migrations README, run as written, let
//! a development database that recorded an earlier numbering start this
//! build.

use super::*;

const OMP: &str = "private OMP runtime replay state";
const PROJECTS: &str = "account-scoped desktop projects";
const PINS: &str = "session pin stacks";
const TICKETS: &str = "session-bound realtime tickets";
const RUNNER: &str = "runner run token hash";
const PROOFS: &str = "desktop device proofs";
const EMAIL: &str = "account email verification";
const CONTENT_REMOVAL: &str = "content removal jobs and deletion indexes";
const FILES_PANEL: &str = "keep removed files-panel entries archived";
const CONSENT: &str = "contact consent and blocks";
const ABUSE_REPORTS: &str = "abuse reports";

/// Every numbering from version 106 on that a database could have recorded:
/// earlier states of this change, the changes still in review, a database
/// that ran the main branch and then one of those changes, and this change
/// before account email verification left version 117.
const EARLIER_NUMBERINGS: &[&[(i64, &str)]] = &[
    &[(106, RUNNER)],
    &[(106, EMAIL), (107, TICKETS)],
    &[(107, EMAIL), (108, TICKETS)],
    &[(109, RUNNER)],
    &[(107, EMAIL), (108, TICKETS), (109, RUNNER)],
    &[(106, OMP), (107, EMAIL), (108, TICKETS)],
    &[
        (106, OMP),
        (107, PROJECTS),
        (108, EMAIL),
        (109, TICKETS),
        (110, RUNNER),
    ],
    &[
        (106, OMP),
        (107, PROJECTS),
        (108, EMAIL),
        (109, TICKETS),
        (113, RUNNER),
        (114, PROOFS),
    ],
    &[
        (106, OMP),
        (107, PROJECTS),
        (108, PINS),
        (109, TICKETS),
        (113, RUNNER),
        (114, PROOFS),
        (117, EMAIL),
        (118, "OMP state replay flag"),
        (119, "device key rotation"),
    ],
    &[
        (107, EMAIL),
        (108, TICKETS),
        (109, RUNNER),
        (110, CONSENT),
        (111, ABUSE_REPORTS),
    ],
    &[
        (107, EMAIL),
        (108, TICKETS),
        (109, RUNNER),
        (
            112,
            "agent trust: AI access, opt-outs, pending actions, run disclosure",
        ),
    ],
    &[
        (107, EMAIL),
        (108, TICKETS),
        (109, RUNNER),
        (116, CONTENT_REMOVAL),
        (117, FILES_PANEL),
    ],
];

/// The renumbering statements exactly as the migrations README gives them.
fn readme_renumbering() -> &'static str {
    include_str!("../../../../migrations/README.md")
        .split("## Version numbers")
        .nth(1)
        .and_then(|section| section.split("```sql\n").nth(1))
        .and_then(|block| block.split("```").next())
        .expect("the README gives the renumbering statements")
}

/// The version this build records for `description`, if it embeds it.
fn embedded_version(description: &str) -> Option<i64> {
    EMBEDDED_MIGRATIONS
        .iter()
        .find(|migration| migration.description == description)
        .map(|migration| migration.version)
}

async fn recorded(pool: &PgPool) -> Vec<(i64, String)> {
    query_as("SELECT version, description FROM cloud_schema_versions ORDER BY version")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// A fresh fixture database holding only the version table.
async fn version_table() -> PgPool {
    let url = std::env::var("KORDI_MIGRATION_TEST_DATABASE_URL")
        .expect("set a dedicated, empty migration fixture database");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let (name, existing): (String, Option<String>) =
        query_as("SELECT current_database(),to_regclass('public.cloud_schema_versions')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        name.starts_with("kordi_migration_test_") && existing.is_none(),
        "only a fresh migration fixture is allowed"
    );
    execute(&pool, "CREATE TABLE cloud_schema_versions(version BIGINT PRIMARY KEY,description TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())").await;
    pool
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn readme_renumbering_resolves_every_earlier_numbering() {
    let pool = version_table().await;
    for numbering in EARLIER_NUMBERINGS {
        execute(&pool, "DELETE FROM cloud_schema_versions").await;
        for (version, description) in *numbering {
            query("INSERT INTO cloud_schema_versions(version,description) VALUES($1,$2)")
                .bind(version)
                .bind(description)
                .execute(&pool)
                .await
                .unwrap();
        }
        execute(&pool, readme_renumbering()).await;

        let rows = recorded(&pool).await;
        assert_eq!(rows.len(), numbering.len(), "{numbering:?} lost a record");
        for (version, description) in &rows {
            // Every migration this build embeds sits at its version, and the
            // versions held by changes still in review keep theirs.
            let expected = embedded_version(description).unwrap_or_else(|| {
                numbering
                    .iter()
                    .find(|(_, held)| held == description)
                    .map(|(held_version, _)| *held_version)
                    .unwrap()
            });
            assert_eq!(*version, expected, "{numbering:?}: {description}");
            if let Some(migration) = EMBEDDED_MIGRATIONS.iter().find(|m| m.version == *version) {
                assert!(
                    super::super::migrate::check_recorded_migration(migration, description).is_ok(),
                    "{numbering:?}: version {version} is still refused"
                );
            }
        }
    }
}

/// Builds a database that ran a change before it merged: every version up to
/// 105, then `records` with the SQL this build embeds for each description.
/// It checks that startup refuses that numbering, runs the README statements,
/// and upgrades twice concurrently to exactly this build's records.
async fn upgrade_after_renumbering(records: &[(i64, &str)]) -> PgPool {
    let pool = fixture(105).await;
    for (version, description) in records {
        let migration = EMBEDDED_MIGRATIONS
            .iter()
            .find(|migration| migration.description == *description)
            .unwrap();
        execute(&pool, migration.sql).await;
        query("INSERT INTO cloud_schema_versions(version,description) VALUES($1,$2)")
            .bind(version)
            .bind(description)
            .execute(&pool)
            .await
            .unwrap();
    }

    let refused = apply_migrations(&pool)
        .await
        .expect_err("an earlier numbering is refused");
    assert!(refused.to_string().contains("107"), "{refused}");

    execute(&pool, readme_renumbering()).await;
    let (first, second) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    first.unwrap();
    second.unwrap();
    latest_version(&pool).await;

    let expected = EMBEDDED_MIGRATIONS
        .iter()
        .map(|migration| (migration.version, migration.description.to_string()))
        .collect::<Vec<_>>();
    assert_eq!(recorded(&pool).await, expected);
    let (columns,): (i64,) = query_as(
        "SELECT count(*) FROM information_schema.columns \
         WHERE table_name='cloud_accounts' AND column_name='primary_email_verified_at'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(columns, 1, "email verification stays applied");
    pool
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn a_database_from_the_deletion_change_upgrades_after_renumbering() {
    // Before it merged, the content removal change recorded email
    // verification, realtime tickets, and the runner token hash at 107 to
    // 109, then its own migrations at 116 and 117, without versions 106 to
    // 108 of the main branch.
    let pool = upgrade_after_renumbering(&[
        (107, EMAIL),
        (108, TICKETS),
        (109, RUNNER),
        (116, CONTENT_REMOVAL),
        (117, FILES_PANEL),
    ])
    .await;
    let (state_rows,): (i64,) = query_as("SELECT count(*) FROM cloud_content_removal_state")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state_rows, 1, "content removal stays applied");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn a_database_from_the_consent_change_upgrades_after_renumbering() {
    // Before it merged, the contact consent change recorded the same three
    // migrations at 107 to 109 and its own at 110 and 111, so versions 106 to
    // 108 of the main branch apply after contact consent.
    let pool = upgrade_after_renumbering(&[
        (107, EMAIL),
        (108, TICKETS),
        (109, RUNNER),
        (110, CONSENT),
        (111, ABUSE_REPORTS),
    ])
    .await;
    let (blocks, reports, projects): (Option<String>, Option<String>, Option<String>) = query_as(
        "SELECT to_regclass('public.cloud_account_blocks')::text, \
                to_regclass('public.cloud_abuse_reports')::text, \
                to_regclass('public.cloud_project_devices')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(blocks.is_some(), "contact consent stays applied");
    assert!(reports.is_some(), "abuse reports stay applied");
    assert!(projects.is_some(), "chat projects apply after them");
}
