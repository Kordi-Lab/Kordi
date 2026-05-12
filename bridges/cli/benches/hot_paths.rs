//! #332 Phase 0 baseline benchmarks for the bridges hot paths.
//!
//! Each bench exercises the same SQL the production handlers execute, against
//! a freshly-initialized SQLite file with WAL/foreign_keys/synchronous=NORMAL
//! configured the same way `serve::configure_server_connection` does. The
//! mailbox path is benched directly (raw SQL) to skip axum/hyper overhead so
//! we measure the storage layer in isolation; the argon2 benches call
//! `argon2` + `password-hash` directly because that's exactly what the
//! cloud_password module does.
//!
//! Running:
//!   cargo bench -p bridges --bench hot_paths
//!
//! Output is summarised under docs/perf/.

use std::path::PathBuf;
use std::time::Duration;

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use password_hash::{PasswordHash, SaltString};
use rand::rngs::OsRng;
use rusqlite::{params, Connection};

const PRODUCTION_ARGON2: (u32, u32, u32) = (64 * 1024, 3, 4); // m=64MiB, t=3, p=4
const TEST_TARGET: &str = "kd_bench_target";
const TEST_SENDER: &str = "kd_bench_sender";

fn fresh_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "bridges-bench-{label}-{}.db",
        uuid::Uuid::new_v4().simple()
    ))
}

fn open_configured(path: &PathBuf) -> Connection {
    let conn = Connection::open(path).expect("open db");
    conn.busy_timeout(Duration::from_secs(5)).expect("busy timeout");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         PRAGMA journal_mode = WAL;\n         PRAGMA synchronous = NORMAL;\n         CREATE TABLE IF NOT EXISTS server_mailbox (\n             message_id      TEXT PRIMARY KEY,\n             target_node_id  TEXT NOT NULL,\n             from_node_id    TEXT NOT NULL,\n             blob            TEXT NOT NULL,\n             project_id      TEXT,\n             created_at      TEXT NOT NULL\n         );\n         CREATE INDEX IF NOT EXISTS idx_server_mailbox_target_created_message\n             ON server_mailbox (target_node_id, created_at, message_id);",
    )
    .expect("init bench schema");
    conn
}

fn cleanup(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn bench_mailbox_enqueue(c: &mut Criterion) {
    let path = fresh_db_path("enqueue");
    let conn = open_configured(&path);
    let mut counter: u64 = 0;
    let now = chrono::Utc::now().to_rfc3339();
    c.bench_function("mailbox_enqueue/insert_one_row", |b| {
        b.iter(|| {
            counter += 1;
            let message_id = format!("msg_{counter}");
            conn.execute(
                "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![&message_id, TEST_TARGET, TEST_SENDER, "payload-blob", &now],
            )
            .expect("insert");
        });
    });
    drop(conn);
    cleanup(&path);
}

fn bench_mailbox_poll(c: &mut Criterion) {
    let path = fresh_db_path("poll");
    let conn = open_configured(&path);
    let now = chrono::Utc::now().to_rfc3339();
    for i in 0..500u32 {
        let id = format!("msg_{i:05}");
        conn.execute(
            "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![&id, TEST_TARGET, TEST_SENDER, "payload-blob", &now],
        )
        .expect("seed");
    }
    c.bench_function("mailbox_poll/top_100_rows", |b| {
        b.iter(|| {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, from_node_id, blob, project_id, created_at \
                     FROM server_mailbox WHERE target_node_id = ?1 \
                     ORDER BY created_at ASC, message_id ASC LIMIT 100",
                )
                .expect("prepare");
            let rows = stmt
                .query_map(params![TEST_TARGET], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .expect("query");
            let mut count = 0;
            for row in rows {
                let _ = row.expect("row");
                count += 1;
            }
            assert_eq!(count, 100);
        });
    });
    drop(conn);
    cleanup(&path);
}

fn bench_mailbox_ack_chunked(c: &mut Criterion) {
    let path = fresh_db_path("ack");
    c.bench_function("mailbox_ack/chunked_100_ids", |b| {
        b.iter_batched(
            || {
                let conn = open_configured(&path);
                let now = chrono::Utc::now().to_rfc3339();
                let mut ids = Vec::with_capacity(100);
                for i in 0..100u32 {
                    let id = format!("msg_{}_{i:05}", uuid::Uuid::new_v4().simple());
                    conn.execute(
                        "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                        params![&id, TEST_TARGET, TEST_SENDER, "payload-blob", &now],
                    )
                    .expect("seed");
                    ids.push(id);
                }
                (conn, ids)
            },
            |(mut conn, ids)| {
                let tx = conn.transaction().expect("tx");
                let mut placeholders = String::new();
                for i in 0..ids.len() {
                    if i > 0 {
                        placeholders.push_str(", ");
                    }
                    placeholders.push('?');
                    placeholders.push_str(&(i + 2).to_string());
                }
                let sql = format!(
                    "DELETE FROM server_mailbox WHERE target_node_id = ?1 AND message_id IN ({placeholders})"
                );
                let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
                bound.push(&TEST_TARGET);
                for id in &ids {
                    bound.push(id);
                }
                tx.execute(&sql, &bound[..]).expect("delete chunk");
                tx.commit().expect("commit");
            },
            BatchSize::PerIteration,
        );
    });
    cleanup(&path);
}

fn argon2_production() -> Argon2<'static> {
    let (m, t, p) = PRODUCTION_ARGON2;
    let params = Params::new(m, t, p, None).expect("params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn bench_argon2_hash_production(c: &mut Criterion) {
    let argon2 = argon2_production();
    let mut group = c.benchmark_group("argon2");
    // argon2id with production params is intentionally slow; ten samples is
    // plenty to spot regressions and keeps `cargo bench` interactive.
    group.sample_size(10);
    group.bench_function("hash/production_params", |b| {
        b.iter(|| {
            let salt = SaltString::generate(&mut OsRng);
            let _ = argon2
                .hash_password(b"correct horse battery staple", &salt)
                .expect("hash")
                .to_string();
        });
    });
    group.finish();
}

fn bench_argon2_verify_production(c: &mut Criterion) {
    let argon2 = argon2_production();
    let salt = SaltString::generate(&mut OsRng);
    let stored = argon2
        .hash_password(b"correct horse battery staple", &salt)
        .expect("seed hash")
        .to_string();
    let parsed = PasswordHash::new(&stored).expect("parse");

    let mut group = c.benchmark_group("argon2");
    group.sample_size(10);
    group.bench_function("verify/production_params_match", |b| {
        b.iter(|| {
            assert!(Argon2::default()
                .verify_password(b"correct horse battery staple", &parsed)
                .is_ok());
        });
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_mailbox_enqueue,
    bench_mailbox_poll,
    bench_mailbox_ack_chunked,
    bench_argon2_hash_production,
    bench_argon2_verify_production,
);
criterion_main!(benches);
