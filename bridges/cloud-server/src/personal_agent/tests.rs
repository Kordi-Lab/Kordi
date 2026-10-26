//! Personal agent database tests. They run against `$DATABASE_URL` under
//! the connector tests' rule: outside CI they return early when it is unset,
//! in CI a missing `DATABASE_URL` fails them unless
//! `KORDI_CONNECTOR_DB_TESTS=skip`. `scripts/test-cloud-migrations.sh` runs
//! them against its own database. Every test uses uuid-suffixed data.

mod delivery_db;
mod desktop_db;
mod fixture;
mod sessions_db;
mod settings_db;
mod sweep_db;
