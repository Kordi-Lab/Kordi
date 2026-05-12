//! Postgres-backed storage layer (sqlx).
//!
//! Lands as part of session 4 of the k3s rollout. This module owns the
//! `sqlx::PgPool`, runs migrations on boot, and is the foundation that
//! subsequent turns of the rusqlite → sqlx port build on. The legacy
//! rusqlite path under `crate::db_runner` + `crate::schema` stays in
//! place during the migration; modules port one at a time.
//!
//! See `docs/superpowers/specs/2026-05-10-cloud-server-rusqlite-to-sqlx-port.md`
//! for the multi-turn plan.

pub mod pool;

pub use pool::{init_pool, PgPoolError};
