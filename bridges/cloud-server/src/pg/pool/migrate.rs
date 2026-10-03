use super::*;

fn pending_migration_sql(migration: &EmbeddedMigration) -> &str {
    // Released SQL is immutable. Guard only the known destructive or
    // incompatible pending versions; already-applied versions still skip.
    match migration.version {
        77 => "SELECT 1;",
        79 => include_str!("compatibility/0079_default_group_channel_titles.sql"),
        80 => include_str!("compatibility/0080_enforce_direct_conversation_identity.sql"),
        81 => include_str!("compatibility/0081_agent_execution_ownership.sql"),
        _ => migration.sql,
    }
}

/// Versions from here on must be recorded with the description embedded in
/// this build. Earlier versions predate the check and are matched by number
/// only, because their recorded descriptions were never compared.
const FIRST_DESCRIPTION_CHECKED_VERSION: i64 = 106;

/// Refuses a database that recorded `migration.version` for a different
/// migration, for example when two changes were assigned the same number.
/// Skipping it would leave this build's schema change unapplied.
pub(super) fn check_recorded_migration(
    migration: &EmbeddedMigration,
    recorded_description: &str,
) -> Result<(), PgPoolError> {
    if migration.version < FIRST_DESCRIPTION_CHECKED_VERSION
        || recorded_description == migration.description
    {
        return Ok(());
    }
    Err(PgPoolError::Migrate(sqlx_core::Error::Protocol(format!(
        "schema version {} is recorded as {:?}, but this build expects {:?}; \
         resolve the migration numbering before starting this build",
        migration.version, recorded_description, migration.description
    ))))
}

pub(crate) async fn apply_migrations(pool: &PgPool) -> Result<(), PgPoolError> {
    // Serialize the version check with its DDL across API replicas. Separate
    // transactions still preserve the existing per-migration recovery boundary.
    let mut tx = pool.begin().await.map_err(PgPoolError::Migrate)?;
    query("SELECT pg_advisory_xact_lock(hashtextextended('kordi-schema-migrations',0))")
        .execute(&mut *tx)
        .await
        .map_err(PgPoolError::Migrate)?;
    query("CREATE TABLE IF NOT EXISTS cloud_schema_versions (version BIGINT PRIMARY KEY, description TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        .execute(&mut *tx).await.map_err(PgPoolError::Migrate)?;
    tx.commit().await.map_err(PgPoolError::Migrate)?;
    for migration in EMBEDDED_MIGRATIONS {
        let mut tx = pool.begin().await.map_err(PgPoolError::Migrate)?;
        query("SELECT pg_advisory_xact_lock(hashtextextended('kordi-schema-migrations',0))")
            .execute(&mut *tx)
            .await
            .map_err(PgPoolError::Migrate)?;
        let already: Option<(String,)> =
            query_as("SELECT description FROM cloud_schema_versions WHERE version=$1")
                .bind(migration.version)
                .fetch_optional(&mut *tx)
                .await
                .map_err(PgPoolError::Migrate)?;
        if let Some((recorded_description,)) = &already {
            check_recorded_migration(migration, recorded_description)?;
        } else {
            sqlx_core::raw_sql::raw_sql(pending_migration_sql(migration))
                .execute(&mut *tx)
                .await
                .map_err(PgPoolError::Migrate)?;
            query("INSERT INTO cloud_schema_versions (version, description) VALUES ($1,$2)")
                .bind(migration.version)
                .bind(migration.description)
                .execute(&mut *tx)
                .await
                .map_err(PgPoolError::Migrate)?;
        }
        tx.commit().await.map_err(PgPoolError::Migrate)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn released_compatibility_migrations_remain_immutable() {
        for (version, checksum) in [
            (
                77,
                "c0b4e1115a125c7689b9b887da1d1e71d8d0bccb9f02232cda15d5be0559b1f0",
            ),
            (
                79,
                "3b8d824c7d4f690788873e8ee80d4fe685eb6e24210d1bc2745513cc3da6c705",
            ),
            (
                80,
                "098d271ebac306f207ff9b9173f6385bfff64936e63b2b66e659d93090211ab3",
            ),
            (
                81,
                "a4033bdee44a524ba67fd99ba892a262793aea13288caf1e64e95cbaf9008a67",
            ),
        ] {
            let migration = EMBEDDED_MIGRATIONS
                .iter()
                .find(|m| m.version == version)
                .unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(migration.sql.as_bytes())),
                checksum
            );
        }
    }

    #[test]
    fn embedded_migration_versions_strictly_increase() {
        for pair in EMBEDDED_MIGRATIONS.windows(2) {
            assert!(
                pair[0].version < pair[1].version,
                "migration {} must come before {}",
                pair[0].version,
                pair[1].version
            );
        }
        let descriptions = EMBEDDED_MIGRATIONS
            .iter()
            .filter(|m| m.version >= FIRST_DESCRIPTION_CHECKED_VERSION)
            .map(|m| m.description)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            descriptions.len(),
            EMBEDDED_MIGRATIONS
                .iter()
                .filter(|m| m.version >= FIRST_DESCRIPTION_CHECKED_VERSION)
                .count(),
            "checked migrations need distinct descriptions"
        );
    }

    #[test]
    fn recorded_versions_must_match_this_build_from_the_checked_version() {
        let checked = EMBEDDED_MIGRATIONS
            .iter()
            .find(|m| m.version >= FIRST_DESCRIPTION_CHECKED_VERSION)
            .expect("at least one checked migration");
        assert!(check_recorded_migration(checked, checked.description).is_ok());
        let error = check_recorded_migration(checked, "a different change")
            .expect_err("a reused version must stop startup");
        assert!(error.to_string().contains(&checked.version.to_string()));

        let legacy = EMBEDDED_MIGRATIONS
            .iter()
            .rev()
            .find(|m| m.version < FIRST_DESCRIPTION_CHECKED_VERSION)
            .unwrap();
        assert!(
            check_recorded_migration(legacy, "any recorded text").is_ok(),
            "released versions are matched by number only"
        );
    }

    #[test]
    fn embedded_versions_are_unique_and_increasing() {
        for pair in EMBEDDED_MIGRATIONS.windows(2) {
            assert!(
                pair[0].version < pair[1].version,
                "migration version {} must be greater than {}",
                pair[1].version,
                pair[0].version
            );
        }
        let mut descriptions = std::collections::HashSet::new();
        for migration in EMBEDDED_MIGRATIONS {
            assert!(
                descriptions.insert(migration.description),
                "migration description {:?} is used twice",
                migration.description
            );
        }
    }

    #[test]
    fn embedded_versions_match_their_file_names() {
        // Every quoted `.sql` literal in the table is a migration file name.
        let names = include_str!("embedded.rs")
            .split('"')
            .filter(|token| token.ends_with(".sql"))
            .filter_map(|file| file.split('_').next())
            .map(|number| number.parse::<i64>().unwrap())
            .collect::<Vec<_>>();
        let versions = EMBEDDED_MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>();
        assert_eq!(names, versions);
    }

    #[test]
    fn pending_compatibility_guards_are_narrowly_scoped() {
        for migration in EMBEDDED_MIGRATIONS {
            let sql = pending_migration_sql(migration);
            match migration.version {
                77 => assert_eq!(sql, "SELECT 1;"),
                79 => {
                    assert!(sql.contains("conversation.shared_title IS NULL"));
                    assert!(!sql.contains("lower(btrim"));
                }
                80 => {
                    assert!(sql.contains("CREATE TRIGGER cloud_chat_direct_session_identity"));
                    assert!(!sql.contains("DELETE FROM"));
                }
                81 => assert!(sql.contains("WHERE NOT legacy_duplicate")),
                _ => assert_eq!(sql, migration.sql),
            }
        }
    }
}
