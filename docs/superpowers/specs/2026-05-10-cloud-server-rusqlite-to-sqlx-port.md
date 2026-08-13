# Cloud-server rusqlite → sqlx + Postgres Port

Session 4 of the k3s rollout. Replaces the synchronous rusqlite + SQLite storage layer in `bridges/cloud-server` with async sqlx + PostgreSQL so the cloud-server can run as multiple replicas behind a load balancer (the whole point of putting it on k3s).

## What stays the same

- HTTP wire shapes for every cloud route (`/v1/cloud/auth/{signup,login,me,logout}`, `/v1/cloud/accounts/:id/profile`, `/v1/cloud/contacts`).
- Error codes and JSON response shapes.
- argon2 password hashing (in `auth/password.rs`, no DB).
- In-memory rate limiter (in `auth/rate_limit.rs`, moves to Redis in session 7 — not this session).
- Test coverage: every existing rusqlite test gets a sqlx equivalent; behaviour assertions don't change.

## What changes

| Layer | Before | After |
|---|---|---|
| Driver | `rusqlite = "0.35"` synchronous | `sqlx = "0.8"` with `postgres,runtime-tokio-rustls,uuid,chrono,macros` |
| Connection | per-request `Connection::open` + `Mutex<Connection>` for writes (DbRunner) | `sqlx::PgPool` shared across all requests |
| Concurrency | single writer through DbRunner mutex; reads on per-call connections; everything wrapped in `tokio::task::spawn_blocking` | sqlx pool's connections are async; no `spawn_blocking`; concurrent writes serialised by Postgres MVCC, not by an app-level mutex |
| Schema location | inline `add_column_if_missing` calls + `apply_migration` helper in `src/schema.rs` | `migrations/0001_initial.sql` + `migrations/000N_*.sql` files run by `sqlx::migrate!()` |
| Identifiers | `TEXT` columns holding `format!("acct_{}", uuid::simple())` | unchanged — same `TEXT` columns, same prefixed-uuid format. (UUID-typed columns is a future cleanup, not this session.) |
| Timestamps | `TEXT` columns holding RFC3339 strings | unchanged — same `TEXT` columns. (`TIMESTAMPTZ` is future cleanup.) |
| Idempotent inserts | `INSERT OR IGNORE` (SQLite) | `INSERT … ON CONFLICT DO NOTHING` (Postgres) |
| Conflict-and-return | manual SELECT-then-INSERT pattern | `INSERT … ON CONFLICT … DO UPDATE SET id = id RETURNING id` |
| Test DB | `Connection::open_in_memory()` | sqlx connects to a real Postgres at `$DATABASE_URL`. Tests use `sqlx::test` for per-test isolated databases. |

## Multi-turn plan

| Turn | Deliverable | Compiles? | Tests pass? |
|---|---|---|---|
| 1 (**this turn**) | Spec + sqlx deps + `migrations/0001_initial.sql` + `src/pg/pool.rs` (PgPool + migration runner). No module ports yet — existing rusqlite paths untouched. | ✅ | ✅ existing 40 tests still green |
| 2 | Port `auth/password.rs` (no-op — already pure) and `auth/rate_limit.rs` (no-op). Port `auth/session.rs` to sqlx. Add a sqlx-test for it that runs against `$DATABASE_URL` if set; otherwise skipped. | ✅ | ✅ |
| 3 | Port `auth/accounts.rs`. New tests against `$DATABASE_URL`. | ✅ | ✅ |
| 4 | Port `messages/log.rs`. | ✅ | ✅ |
| 5 | Port `auth/routes.rs` — the big one. Each handler simplifies dramatically (no DbRunner closures, no spawn_blocking, just `sqlx::query!(…).execute(&pool).await`). Idempotency rewrites use `ON CONFLICT … RETURNING`. | ✅ | ✅ |
| 6 | Drop `rusqlite` dep, drop `src/db_runner.rs`, drop `src/schema.rs` (the rusqlite versions), drop `Cargo.toml` rusqlite features. `ServerState` owns only the PgPool. | ✅ | ✅ |
| 7 | Update tests to require `DATABASE_URL`. Set up `make test-pg` or equivalent that uses `kubectl port-forward` to the in-cluster Postgres for local dev. | ✅ | ✅ |

After turn 7 the cloud-server is fully Postgres-backed. Session 5 (deploy in k3s) follows immediately because the binary now talks to `postgres.kordi-cloud.svc.cluster.local:5432` natively.

## Connection string

In production (cloud-server pod inside k3s):

```
DATABASE_URL=postgresql://kordi:<password>@postgres.kordi-cloud.svc.cluster.local:5432/kordi_cloud
```

The password comes from the existing `postgres-credentials` Secret (created in session 3). In session 5, the cloud-server Deployment manifest mounts it as an env var via `valueFrom.secretKeyRef`.

For local dev:

```
kubectl -n kordi-cloud port-forward svc/postgres 5432:5432 &
PG_PASS=$(gcloud compute ssh kordi@example-cloud-host --zone us-central1-c --command \
  "kubectl -n kordi-cloud get secret postgres-credentials -o jsonpath='{.data.password}' | base64 -d")
export DATABASE_URL="postgresql://kordi:$PG_PASS@127.0.0.1:5432/kordi_cloud"
cargo test -p kordi-cloud-server
```

## Postgres dialect notes the port has to handle

- **Partial unique indexes**: `CREATE UNIQUE INDEX ... WHERE column IS NOT NULL` works in both engines. The existing `idx_cloud_accounts_email_lower` on `LOWER(primary_email)` and `idx_server_messages_client_msg` on `(sender_node_id, client_message_id) WHERE client_message_id IS NOT NULL` translate cleanly.
- **`INSERT OR IGNORE`** → **`INSERT ... ON CONFLICT (col,...) DO NOTHING`**.
- **`COALESCE`** → identical syntax.
- **`OPTIONAL`/`OptionalExtension`**: rusqlite returns `Option<T>` via `.optional()` extension. sqlx returns it natively from `.fetch_optional(pool)`.
- **Boolean columns**: SQLite uses INTEGER; Postgres has native BOOLEAN. The schema currently uses `INTEGER NOT NULL DEFAULT 0` for `email_verified`. Migration translates to `BOOLEAN NOT NULL DEFAULT FALSE`.
- **Auto-increment** isn't used anywhere — every PK is a `TEXT` we generate in code.
- **`?N` placeholders** (rusqlite) → **`$N` placeholders** (Postgres). Every SQL string changes.

## What this session does NOT touch

- **Rate limiter migration to Redis.** Stays in-memory in this session. Moves in session 7.
- **Connection pool tuning, prepared-statement caching, observability.** Default `PgPool` settings are fine for now.
- **Migrations beyond the initial cut.** Adding a new column or table later is a new migration file (`0002_*.sql`). The pattern is set; future schema changes follow it.

## Verification gates per turn

- Turn 1: `cargo check -p kordi-cloud-server` clean. Existing 40 tests still pass (`cargo test -p kordi-cloud-server`).
- Turns 2–6: each module's new sqlx tests pass against a Postgres at `$DATABASE_URL`. Skipped (not failed) when `DATABASE_URL` is unset.
- Turn 7: existing 40 tests have all migrated to sqlx-test variants; `cargo test -p kordi-cloud-server` requires `DATABASE_URL` and runs them all green.

## Rollback per turn

Each turn is one or two commits. Reverting them takes the crate back to the previous working state — old rusqlite paths intact through turns 1–5; turn 6 is the cliff where they're dropped. If a turn 6 issue surfaces, revert to turn 5's tip; rusqlite path resumes.
