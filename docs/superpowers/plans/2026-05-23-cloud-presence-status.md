# Cloud Presence Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build #492, the backend + desktop Cloud presence foundation for #479, with device heartbeat, account rollup, contacts-only visibility, realtime updates, and avatar-light UI.

**Architecture:** Add a dedicated `cloud_device_presence` table and a focused Rust `presence` module for writes, rollups, and timeout sweeping. Desktop gets a small auth-client surface, a contact presence store, and a lifecycle publisher. UI consumes account-id keyed presence and renders only a small green/gray light on avatars in Contacts and participant surfaces.

**Tech Stack:** Rust/axum/sqlx/Postgres/NATS for cloud-server; React/TypeScript/Tauri/Vite for desktop; node:test/tsx and Rust integration tests.

---

## File structure

- Create `bridges/cloud-server/migrations/0015_cloud_device_presence.sql`: presence table and indexes.
- Create `bridges/cloud-server/src/presence.rs`: core server presence model, DB writes, account rollup, contact-scoped read, timeout sweep, and event publishing helper.
- Modify `bridges/cloud-server/src/lib.rs`: export `presence` module.
- Modify `bridges/cloud-server/src/auth/routes.rs`: mount authenticated presence endpoints under `/v1/cloud/presence/*`.
- Modify `bridges/cloud-server/src/events/mod.rs`: add `publish_presence_account_changed`.
- Modify `bridges/cloud-server/src/ws/mod.rs`: subscribe to `kordi.events.presence.account.<viewer_account_id>`.
- Modify `bridges/cloud-server/src/server.rs`: start a background timeout sweeper in production `run`.
- Modify `bridges/cloud-server/tests/cloud_auth_e2e.rs`: backend regression tests.
- Modify `app/desktop/src/features/cloud/authClient.ts`: add presence types and API methods.
- Create `app/desktop/src/features/cloud/presence.ts`: pure helpers, event parsing, merge logic.
- Create `app/desktop/src/features/cloud/useCloudPresence.ts`: React store/hook for read API + realtime/poll updates.
- Create `app/desktop/src/features/cloud/useCloudPresencePublisher.ts`: lifecycle publisher for online/heartbeat/offline.
- Modify `app/desktop/src/features/cloud/useCloudSession.ts`: install the presence publisher when authenticated.
- Modify `app/desktop/src/features/cloud/CloudContactsAdapter.tsx`: pass presence to cloud contact rows.
- Modify `app/desktop/src/kordi-app/types.ts`: add optional `presenceStatus` metadata on `Contact` and participant types if needed.
- Modify `app/desktop/src/kordi-app/components/IdentityAvatar.tsx`: add optional avatar light props.
- Modify `app/desktop/src/kordi-app/pages.tsx`: render contact avatar lights through existing row avatar path.
- Modify `app/desktop/src/pages/GroupDetailsDialog.tsx` and any compact participant avatar surface found during implementation: render participant avatar lights.
- Add/modify tests under `app/desktop/tests`: `cloudPresence.test.tsx`, `cloudPresencePublisher.test.tsx`, and UI coverage in existing contact/group tests.

---

### Task 1: Backend presence schema and pure status model

**Files:**
- Create: `bridges/cloud-server/migrations/0015_cloud_device_presence.sql`
- Create: `bridges/cloud-server/src/presence.rs`
- Modify: `bridges/cloud-server/src/lib.rs`
- Test: `bridges/cloud-server/src/presence.rs` unit tests

- [ ] **Step 1: Write the failing pure model tests**

Add `#[cfg(test)]` tests to the new `bridges/cloud-server/src/presence.rs` before implementation:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, TimeZone, Utc};

    #[test]
    fn online_device_is_fresh_until_timeout() {
        let now = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
        let fresh = now - ChronoDuration::seconds(74);
        let stale = now - ChronoDuration::seconds(76);
        assert!(device_presence_is_currently_online("online", Some(fresh), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("online", Some(stale), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("offline", Some(fresh), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("online", None, now, ChronoDuration::seconds(75)));
    }

    #[test]
    fn account_rollup_is_online_when_any_device_is_online() {
        assert_eq!(rollup_account_presence([false, true, false]), AccountPresenceStatus::Online);
        assert_eq!(rollup_account_presence([false, false]), AccountPresenceStatus::Offline);
        assert_eq!(rollup_account_presence(std::iter::empty::<bool>()), AccountPresenceStatus::Offline);
    }
}
```

- [ ] **Step 2: Run the unit test to verify RED**

Run:

```bash
cargo test -p kordi-cloud-server presence::tests::online_device_is_fresh_until_timeout presence::tests::account_rollup_is_online_when_any_device_is_online
```

Expected: compile failure because `presence` module/functions do not exist.

- [ ] **Step 3: Add migration**

Create `bridges/cloud-server/migrations/0015_cloud_device_presence.sql`:

```sql
CREATE TABLE IF NOT EXISTS cloud_device_presence (
    device_id         TEXT PRIMARY KEY REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    account_id        TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    state             TEXT NOT NULL CHECK (state IN ('online', 'offline')),
    last_heartbeat_at TEXT,
    last_offline_at   TEXT,
    updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_device_presence_account
    ON cloud_device_presence (account_id, state, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_cloud_device_presence_heartbeat
    ON cloud_device_presence (state, last_heartbeat_at);
```

- [ ] **Step 4: Add minimal model implementation**

Create `bridges/cloud-server/src/presence.rs` with:

```rust
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountPresenceStatus {
    Online,
    Offline,
}

impl AccountPresenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountPresenceSummary {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub status: AccountPresenceStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub const DEFAULT_PRESENCE_TIMEOUT_SECONDS: i64 = 90;

pub fn presence_timeout() -> ChronoDuration {
    let seconds = std::env::var("KORDI_CLOUD_PRESENCE_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 30)
        .unwrap_or(DEFAULT_PRESENCE_TIMEOUT_SECONDS);
    ChronoDuration::seconds(seconds)
}

pub fn device_presence_is_currently_online(
    state: &str,
    last_heartbeat_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> bool {
    state == "online" && last_heartbeat_at.map(|ts| now - ts <= timeout).unwrap_or(false)
}

pub fn rollup_account_presence<I>(device_online_states: I) -> AccountPresenceStatus
where
    I: IntoIterator<Item = bool>,
{
    if device_online_states.into_iter().any(|online| online) {
        AccountPresenceStatus::Online
    } else {
        AccountPresenceStatus::Offline
    }
}
```

- [ ] **Step 5: Export the module**

Modify `bridges/cloud-server/src/lib.rs`:

```rust
pub mod attachments;
pub mod auth;
pub mod events;
pub mod pg;
pub mod presence;
pub mod server;
pub mod ws;
```

Keep existing modules; only add `pub mod presence;`.

- [ ] **Step 6: Run unit test to verify GREEN**

Run:

```bash
cargo test -p kordi-cloud-server presence::tests
```

Expected: presence unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add bridges/cloud-server/migrations/0015_cloud_device_presence.sql bridges/cloud-server/src/presence.rs bridges/cloud-server/src/lib.rs
git commit -m "Add cloud device presence model"
```

---

### Task 2: Backend presence read/write APIs and contacts-only visibility

**Files:**
- Modify: `bridges/cloud-server/src/presence.rs`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Test: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Write failing backend e2e tests**

Append tests to `bridges/cloud-server/tests/cloud_auth_e2e.rs`:

```rust
#[tokio::test]
async fn presence_contacts_returns_self_and_accepted_contacts_only() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let a_email = unique_email("presence-a");
    let b_email = unique_email("presence-b");
    let c_email = unique_email("presence-c");

    let a = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&a_email, "correct horse"))).await.unwrap()).await;
    let b = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&b_email, "correct horse"))).await.unwrap()).await;
    let c = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&c_email, "correct horse"))).await.unwrap()).await;
    let a_token = a["session"]["token"].as_str().unwrap();
    let b_id = b["account"]["accountId"].as_str().unwrap();
    let c_id = c["account"]["accountId"].as_str().unwrap();

    let request_body = json!({ "peerAccountId": b_id });
    let request = read_json(router.clone().oneshot(post_json_with_token("/v1/cloud/contacts/requests", a_token, request_body)).await.unwrap()).await;
    let request_id = request["request"]["requestId"].as_str().unwrap();
    let b_token = b["session"]["token"].as_str().unwrap();
    let accept_path = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    let accept_status = router.clone().oneshot(post_with_token(&accept_path, b_token)).await.unwrap().status();
    assert_eq!(accept_status, StatusCode::OK);

    let online_status = router.clone().oneshot(post_with_token("/v1/cloud/presence/online", a_token)).await.unwrap().status();
    assert_eq!(online_status, StatusCode::OK);

    let response = router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", a_token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let ids: Vec<String> = body["accounts"].as_array().unwrap().iter().map(|row| row["accountId"].as_str().unwrap().to_string()).collect();
    assert!(ids.contains(&a["account"]["accountId"].as_str().unwrap().to_string()));
    assert!(ids.contains(&b_id.to_string()));
    assert!(!ids.contains(&c_id.to_string()));
}

#[tokio::test]
async fn presence_rollup_stays_online_until_all_devices_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let email = unique_email("presence-rollup");
    let signup = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse"))).await.unwrap()).await;
    let token = signup["session"]["token"].as_str().unwrap();

    assert_eq!(router.clone().oneshot(post_with_token("/v1/cloud/presence/online", token)).await.unwrap().status(), StatusCode::OK);
    let online = read_json(router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", token)).await.unwrap()).await;
    assert_eq!(online["accounts"][0]["status"], "online");

    assert_eq!(router.clone().oneshot(post_with_token("/v1/cloud/presence/offline", token)).await.unwrap().status(), StatusCode::OK);
    let offline = read_json(router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", token)).await.unwrap()).await;
    assert_eq!(offline["accounts"][0]["status"], "offline");
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
DATABASE_URL="$DATABASE_URL" cargo test -p kordi-cloud-server --test cloud_auth_e2e presence_contacts_returns_self_and_accepted_contacts_only presence_rollup_stays_online_until_all_devices_offline
```

Expected: 404/not found or compile failure because routes/functions do not exist.

- [ ] **Step 3: Implement DB helpers in `presence.rs`**

Add these public functions after the model helpers:

```rust
fn parse_rfc3339(value: Option<String>) -> Option<DateTime<Utc>> {
    value.and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok()).map(|ts| ts.with_timezone(&Utc))
}

pub async fn account_presence_status(
    pool: &PgPool,
    account_id: &str,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> Result<AccountPresenceSummary, sqlx::Error> {
    let rows: Vec<(String, Option<String>)> = query_as(
        "SELECT p.state, p.last_heartbeat_at \
         FROM cloud_device_presence p \
         JOIN cloud_devices d ON d.device_id = p.device_id \
         WHERE p.account_id = $1 AND d.revoked_at IS NULL",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let status = rollup_account_presence(rows.into_iter().map(|(state, heartbeat)| {
        device_presence_is_currently_online(&state, parse_rfc3339(heartbeat), now, timeout)
    }));
    Ok(AccountPresenceSummary { account_id: account_id.to_string(), status, updated_at: now.to_rfc3339() })
}

pub async fn mark_device_online(pool: &PgPool, account_id: &str, device_id: &str) -> Result<AccountPresenceSummary, sqlx::Error> {
    let now = Utc::now();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, last_offline_at, updated_at) \
         VALUES ($1, $2, 'online', $3, NULL, $3) \
         ON CONFLICT (device_id) DO UPDATE SET state = 'online', last_heartbeat_at = EXCLUDED.last_heartbeat_at, updated_at = EXCLUDED.updated_at",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    account_presence_status(pool, account_id, now, presence_timeout()).await
}

pub async fn mark_device_offline(pool: &PgPool, account_id: &str, device_id: &str) -> Result<AccountPresenceSummary, sqlx::Error> {
    let now = Utc::now();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, last_offline_at, updated_at) \
         VALUES ($1, $2, 'offline', NULL, $3, $3) \
         ON CONFLICT (device_id) DO UPDATE SET state = 'offline', last_offline_at = EXCLUDED.last_offline_at, updated_at = EXCLUDED.updated_at",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    account_presence_status(pool, account_id, now, presence_timeout()).await
}

pub async fn contact_presence_summaries(pool: &PgPool, account_id: &str) -> Result<Vec<AccountPresenceSummary>, sqlx::Error> {
    let contact_ids: Vec<(String,)> = query_as(
        "SELECT $1::TEXT AS account_id \
         UNION \
         SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let now = Utc::now();
    let timeout = presence_timeout();
    let mut rows = Vec::with_capacity(contact_ids.len());
    for (id,) in contact_ids {
        rows.push(account_presence_status(pool, &id, now, timeout).await?);
    }
    Ok(rows)
}
```

- [ ] **Step 4: Add route response types and handlers**

In `auth/routes.rs`, add:

```rust
#[derive(Debug, Serialize)]
pub struct PresenceContactsResponse {
    pub accounts: Vec<crate::presence::AccountPresenceSummary>,
}
```

Add handlers near other authenticated handlers:

```rust
async fn publish_current_device_online(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Result<Json<crate::presence::AccountPresenceSummary>, CloudHttpError> {
    let summary = crate::presence::mark_device_online(state.db_pool(), &session.account_id, &session.device_id)
        .await
        .map_err(|_| CloudHttpError::server_error("Could not update presence."))?;
    Ok(Json(summary))
}

async fn publish_current_device_heartbeat(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Result<Json<crate::presence::AccountPresenceSummary>, CloudHttpError> {
    publish_current_device_online(State(state), Extension(session)).await
}

async fn publish_current_device_offline(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Result<Json<crate::presence::AccountPresenceSummary>, CloudHttpError> {
    let summary = crate::presence::mark_device_offline(state.db_pool(), &session.account_id, &session.device_id)
        .await
        .map_err(|_| CloudHttpError::server_error("Could not update presence."))?;
    Ok(Json(summary))
}

async fn list_contact_presence(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Result<Json<PresenceContactsResponse>, CloudHttpError> {
    let accounts = crate::presence::contact_presence_summaries(state.db_pool(), &session.account_id)
        .await
        .map_err(|_| CloudHttpError::server_error("Could not load presence."))?;
    Ok(Json(PresenceContactsResponse { accounts }))
}
```

Mount routes inside `routes_with_config` authenticated router:

```rust
.route("/v1/cloud/presence/online", post(publish_current_device_online))
.route("/v1/cloud/presence/heartbeat", post(publish_current_device_heartbeat))
.route("/v1/cloud/presence/offline", post(publish_current_device_offline))
.route("/v1/cloud/presence/contacts", get(list_contact_presence))
```

- [ ] **Step 5: Run backend tests to verify GREEN**

Run:

```bash
DATABASE_URL="$DATABASE_URL" cargo test -p kordi-cloud-server --test cloud_auth_e2e presence_contacts_returns_self_and_accepted_contacts_only presence_rollup_stays_online_until_all_devices_offline
```

Expected: tests pass when `DATABASE_URL` is set; tests skip safely otherwise.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-server/src/presence.rs bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs
git commit -m "Add cloud presence APIs"
```

---

### Task 3: Presence events, websocket routing, and timeout sweeper

**Files:**
- Modify: `bridges/cloud-server/src/events/mod.rs`
- Modify: `bridges/cloud-server/src/presence.rs`
- Modify: `bridges/cloud-server/src/ws/mod.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Test: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Write failing tests for event subject matching and timeout sweep**

Add to `bridges/cloud-server/src/ws/mod.rs` tests:

```rust
#[test]
fn websocket_subscribes_to_presence_account_events() {
    let subjects = account_event_subjects("acct_1");
    assert!(subjects.contains(&"kordi.events.presence.account.acct_1".to_string()));
}
```

Add to `presence.rs` tests:

```rust
#[test]
fn stale_online_cutoff_uses_timeout() {
    let now = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
    assert_eq!(stale_presence_cutoff(now, ChronoDuration::seconds(90)).to_rfc3339(), "2026-05-23T11:58:30+00:00");
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p kordi-cloud-server ws::tests::websocket_subscribes_to_presence_account_events presence::tests::stale_online_cutoff_uses_timeout
```

Expected: compile/test failure.

- [ ] **Step 3: Add event publishing**

In `events/mod.rs`, add:

```rust
#[derive(Serialize)]
struct PresenceAccountChanged<'a> {
    event_type: &'static str,
    account_id: &'a str,
    status: &'a str,
    occurred_at: String,
}

impl EventBus {
    pub async fn publish_presence_account_changed(&self, account_id: &str, observer_account_id: &str, status: &str) {
        if self.inner.is_none() {
            return;
        }
        let payload = PresenceAccountChanged {
            event_type: "presence.account.changed",
            account_id,
            status,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize presence.account.changed: {err}");
                return;
            }
        };
        let subject = format!("kordi.events.presence.account.{observer_account_id}");
        self.publish_raw(subject, body).await;
    }
}
```

- [ ] **Step 4: Add observer lookup and rollup-change publishing helper**

In `presence.rs`, add:

```rust
pub fn stale_presence_cutoff(now: DateTime<Utc>, timeout: ChronoDuration) -> DateTime<Utc> {
    now - timeout
}

pub async fn presence_observer_account_ids(pool: &PgPool, account_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = query_as(
        "SELECT $1::TEXT AS account_id \
         UNION \
         SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 \
         UNION \
         SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn publish_presence_to_observers(
    pool: &PgPool,
    events: &crate::events::EventBus,
    account_id: &str,
    status: AccountPresenceStatus,
) -> Result<(), sqlx::Error> {
    for observer in presence_observer_account_ids(pool, account_id).await? {
        events.publish_presence_account_changed(account_id, &observer, status.as_str()).await;
    }
    Ok(())
}
```

Then update route handlers from Task 2 to compute `before` and `after`; publish only when status changes:

```rust
let before = crate::presence::account_presence_status(state.db_pool(), &session.account_id, chrono::Utc::now(), crate::presence::presence_timeout()).await?;
let summary = crate::presence::mark_device_online(...).await?;
if before.status != summary.status {
    let _ = crate::presence::publish_presence_to_observers(state.db_pool(), state.events(), &session.account_id, summary.status).await;
}
```

Apply the same pattern to offline.

- [ ] **Step 5: Subscribe websocket to presence subject**

Modify `account_event_subjects` in `ws/mod.rs` to include exact presence subject:

```rust
fn account_event_subjects(account_id: &str) -> Vec<String> {
    vec![
        format!("kordi.events.*.*.{account_id}"),
        format!("kordi.events.contact.request.*.{account_id}"),
        format!("kordi.events.presence.account.{account_id}"),
    ]
}
```

Update `run_ws` to subscribe to `subjects[2]` and add it to the `tokio::select!` loop the same way `general_sub` and `contact_request_sub` are handled.

- [ ] **Step 6: Add timeout sweep implementation**

In `presence.rs`, add:

```rust
pub async fn sweep_stale_presence(pool: &PgPool, events: &crate::events::EventBus) -> Result<Vec<AccountPresenceSummary>, sqlx::Error> {
    let now = Utc::now();
    let timeout = presence_timeout();
    let cutoff = stale_presence_cutoff(now, timeout).to_rfc3339();
    let account_rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT account_id FROM cloud_device_presence WHERE state = 'online' AND last_heartbeat_at < $1",
    )
    .bind(&cutoff)
    .fetch_all(pool)
    .await?;
    let mut changed = Vec::new();
    for (account_id,) in account_rows {
        let before = account_presence_status(pool, &account_id, now, timeout).await?;
        query("UPDATE cloud_device_presence SET state = 'offline', last_offline_at = $2, updated_at = $2 WHERE account_id = $1 AND state = 'online' AND last_heartbeat_at < $3")
            .bind(&account_id)
            .bind(now.to_rfc3339())
            .bind(&cutoff)
            .execute(pool)
            .await?;
        let after = account_presence_status(pool, &account_id, now, timeout).await?;
        if before.status != after.status {
            publish_presence_to_observers(pool, events, &account_id, after.status).await?;
            changed.push(after);
        }
    }
    Ok(changed)
}
```

In `server.rs`, after building `state`, spawn:

```rust
let sweeper_state = state.clone();
tokio::spawn(async move {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        interval.tick().await;
        if let Err(err) = crate::presence::sweep_stale_presence(sweeper_state.db_pool(), sweeper_state.events()).await {
            eprintln!("[presence] sweep stale devices: {err}");
        }
    }
});
```

- [ ] **Step 7: Run tests**

Run:

```bash
cargo test -p kordi-cloud-server presence::tests ws::tests
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```bash
git add bridges/cloud-server/src/events/mod.rs bridges/cloud-server/src/presence.rs bridges/cloud-server/src/ws/mod.rs bridges/cloud-server/src/server.rs bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs
git commit -m "Broadcast cloud presence changes"
```

---

### Task 4: Desktop auth client and pure presence store helpers

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Create: `app/desktop/src/features/cloud/presence.ts`
- Test: `app/desktop/tests/cloudPresence.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/cloudPresence.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPresenceSnapshot,
  mergePresenceEvent,
  presenceStatusForAccount,
  shouldRefreshPresenceForWsSubject,
  cloudPresenceChangedFromWsPayload,
} from '../src/features/cloud/presence';

test('presence snapshot stores account statuses by account id', () => {
  const snapshot = applyPresenceSnapshot({}, {
    accounts: [
      { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' },
      { accountId: 'acct_2', status: 'offline', updatedAt: '2026-05-23T00:01:00Z' },
    ],
  });
  assert.equal(presenceStatusForAccount(snapshot, 'acct_1'), 'online');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_2'), 'offline');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_missing'), 'offline');
});

test('presence websocket event updates a single account', () => {
  const next = mergePresenceEvent({}, { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' });
  assert.equal(next.acct_1?.status, 'online');
});

test('presence subject and payload parser recognize account changes', () => {
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.presence.account.acct_1'), true);
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.message.arrived.acct_1'), false);
  assert.deepEqual(cloudPresenceChangedFromWsPayload({ account_id: 'acct_1', status: 'online', occurred_at: 'now' }), {
    accountId: 'acct_1',
    status: 'online',
    updatedAt: 'now',
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx
```

Expected: module not found.

- [ ] **Step 3: Add auth client methods**

In `authClient.ts`, add types:

```ts
export type CloudPresenceStatus = 'online' | 'offline';
export type CloudPresenceAccount = { accountId: string; status: CloudPresenceStatus; updatedAt: string };
export type CloudPresenceContactsResponse = { accounts: CloudPresenceAccount[] };
```

Add methods to `CloudAuthClient`:

```ts
async publishPresenceOnline(token: string): Promise<CloudPresenceAccount> {
  return this.request<CloudPresenceAccount>('/v1/cloud/presence/online', { method: 'POST', token });
}
async publishPresenceHeartbeat(token: string): Promise<CloudPresenceAccount> {
  return this.request<CloudPresenceAccount>('/v1/cloud/presence/heartbeat', { method: 'POST', token });
}
async publishPresenceOffline(token: string): Promise<CloudPresenceAccount> {
  return this.request<CloudPresenceAccount>('/v1/cloud/presence/offline', { method: 'POST', token });
}
async listContactPresence(token: string): Promise<CloudPresenceContactsResponse> {
  return this.request<CloudPresenceContactsResponse>('/v1/cloud/presence/contacts', { method: 'GET', token });
}
```

Use the existing `request` method signature in this file; adjust option names to match the actual helper (`token`/`authToken`) if needed.

- [ ] **Step 4: Add pure presence helpers**

Create `presence.ts`:

```ts
import type { CloudPresenceAccount, CloudPresenceContactsResponse, CloudPresenceStatus } from './authClient';

export type CloudPresenceStore = Record<string, CloudPresenceAccount>;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePresenceStatus(value: unknown): CloudPresenceStatus {
  return cleanText(value).toLowerCase() === 'online' ? 'online' : 'offline';
}

export function applyPresenceSnapshot(current: CloudPresenceStore, response: CloudPresenceContactsResponse): CloudPresenceStore {
  const next = { ...current };
  for (const account of response.accounts) {
    const accountId = cleanText(account.accountId);
    if (!accountId) continue;
    next[accountId] = { accountId, status: normalizePresenceStatus(account.status), updatedAt: cleanText(account.updatedAt) || new Date().toISOString() };
  }
  return next;
}

export function mergePresenceEvent(current: CloudPresenceStore, event: CloudPresenceAccount): CloudPresenceStore {
  const accountId = cleanText(event.accountId);
  if (!accountId) return current;
  return { ...current, [accountId]: { accountId, status: normalizePresenceStatus(event.status), updatedAt: cleanText(event.updatedAt) || new Date().toISOString() } };
}

export function presenceStatusForAccount(store: CloudPresenceStore, accountId?: string | null): CloudPresenceStatus {
  const id = cleanText(accountId);
  if (!id) return 'offline';
  return store[id]?.status ?? 'offline';
}

export function shouldRefreshPresenceForWsSubject(subject: string): boolean {
  return subject.startsWith('kordi.events.presence.account.');
}

export function cloudPresenceChangedFromWsPayload(payload: unknown): CloudPresenceAccount | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const accountId = cleanText(record.account_id ?? record.accountId);
  if (!accountId) return null;
  return {
    accountId,
    status: normalizePresenceStatus(record.status),
    updatedAt: cleanText(record.occurred_at ?? record.updatedAt) || new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/features/cloud/authClient.ts app/desktop/src/features/cloud/presence.ts app/desktop/tests/cloudPresence.test.tsx
git commit -m "Add desktop cloud presence client"
```

---

### Task 5: Desktop presence hook and lifecycle publisher

**Files:**
- Create: `app/desktop/src/features/cloud/useCloudPresence.ts`
- Create: `app/desktop/src/features/cloud/useCloudPresencePublisher.ts`
- Modify: `app/desktop/src/features/cloud/useCloudSession.ts`
- Test: `app/desktop/tests/cloudPresencePublisher.test.tsx`

- [ ] **Step 1: Write failing publisher tests**

Create `cloudPresencePublisher.test.tsx` with pure lifecycle helper tests:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldPublishPresenceOfflineForEvent, CLOUD_PRESENCE_HEARTBEAT_MS } from '../src/features/cloud/useCloudPresencePublisher';

test('presence heartbeat interval is conservative for tunnel previews', () => {
  assert.ok(CLOUD_PRESENCE_HEARTBEAT_MS >= 20_000);
});

test('presence offline publishes only for real page lifecycle events', () => {
  assert.equal(shouldPublishPresenceOfflineForEvent('pagehide'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('beforeunload'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('react-cleanup'), false);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresencePublisher.test.tsx
```

Expected: module not found.

- [ ] **Step 3: Implement `useCloudPresencePublisher.ts`**

Create the hook:

```ts
import { useEffect } from 'react';
import type { CloudAccount, CloudAuthClient } from './authClient';
import { defaultCloudAuthClient } from './authClient';
import { loadSession } from './session';

export const CLOUD_PRESENCE_HEARTBEAT_MS = 25_000;
export type PresenceOfflineEventKind = 'pagehide' | 'beforeunload' | 'logout' | 'react-cleanup';

export function shouldPublishPresenceOfflineForEvent(kind: PresenceOfflineEventKind): boolean {
  return kind === 'pagehide' || kind === 'beforeunload' || kind === 'logout';
}

async function publishWithSession(client: CloudAuthClient, kind: 'online' | 'heartbeat' | 'offline') {
  const session = await loadSession();
  if (!session?.token) return;
  if (kind === 'online') await client.publishPresenceOnline(session.token);
  else if (kind === 'heartbeat') await client.publishPresenceHeartbeat(session.token);
  else await client.publishPresenceOffline(session.token);
}

export function publishPresenceOffline(client: CloudAuthClient = defaultCloudAuthClient()) {
  return publishWithSession(client, 'offline').catch(() => undefined);
}

export function useCloudPresencePublisher(account: CloudAccount | null, client: CloudAuthClient = defaultCloudAuthClient()) {
  useEffect(() => {
    if (!account?.accountId) return;
    let cancelled = false;
    void publishWithSession(client, 'online').catch(() => undefined);
    const interval = window.setInterval(() => {
      if (!cancelled) void publishWithSession(client, 'heartbeat').catch(() => undefined);
    }, CLOUD_PRESENCE_HEARTBEAT_MS);
    const publishOffline = () => { void publishPresenceOffline(client); };
    window.addEventListener('pagehide', publishOffline);
    window.addEventListener('beforeunload', publishOffline);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('pagehide', publishOffline);
      window.removeEventListener('beforeunload', publishOffline);
    };
  }, [account?.accountId, client]);
}
```

- [ ] **Step 4: Implement `useCloudPresence.ts`**

Create hook following `useCloudContacts.ts` store pattern:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudAuthClient, cloudWebSocketUrl, defaultCloudAuthClient, type CloudAccount } from './authClient';
import { cloudPresenceChangedFromWsPayload, applyPresenceSnapshot, mergePresenceEvent, presenceStatusForAccount, shouldRefreshPresenceForWsSubject, type CloudPresenceStore } from './presence';
import { loadSession } from './session';

const REFRESH_MS = 15_000;
const stores = new Map<string, { snapshot: CloudPresenceStore; listeners: Set<() => void>; timer: ReturnType<typeof window.setInterval> | null; ws: WebSocket | null }>();

function storeFor(accountId: string) {
  let store = stores.get(accountId);
  if (!store) {
    store = { snapshot: {}, listeners: new Set(), timer: null, ws: null };
    stores.set(accountId, store);
  }
  return store;
}

function publish(store: ReturnType<typeof storeFor>, snapshot: CloudPresenceStore) {
  store.snapshot = snapshot;
  for (const listener of store.listeners) listener();
}

async function refresh(store: ReturnType<typeof storeFor>, client: CloudAuthClient) {
  const session = await loadSession();
  if (!session?.token) return;
  const response = await client.listContactPresence(session.token);
  publish(store, applyPresenceSnapshot(store.snapshot, response));
}

export function useCloudPresence(account: CloudAccount | null) {
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const store = account ? storeFor(account.accountId) : null;
  const [snapshot, setSnapshot] = useState<CloudPresenceStore>(() => store?.snapshot ?? {});
  useEffect(() => {
    if (!store || !account) { setSnapshot({}); return; }
    const listener = () => setSnapshot(store.snapshot);
    store.listeners.add(listener);
    setSnapshot(store.snapshot);
    void refresh(store, client).catch(() => undefined);
    if (!store.timer) store.timer = window.setInterval(() => void refresh(store, client).catch(() => undefined), REFRESH_MS);
    void loadSession().then((session) => {
      if (!session?.token || store.ws) return;
      const ws = new WebSocket(cloudWebSocketUrl(session.token));
      store.ws = ws;
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (!shouldRefreshPresenceForWsSubject(String(frame.subject ?? ''))) return;
          const changed = cloudPresenceChangedFromWsPayload(frame.payload);
          if (changed) publish(store, mergePresenceEvent(store.snapshot, changed));
        } catch { /* ignore bad frames */ }
      };
      ws.onclose = () => { if (store.ws === ws) store.ws = null; };
      ws.onerror = () => ws.close();
    }).catch(() => undefined);
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        if (store.timer) window.clearInterval(store.timer);
        store.timer = null;
        store.ws?.close();
        store.ws = null;
      }
    };
  }, [account, client, store]);
  return { snapshot, statusForAccount: useCallback((accountId?: string | null) => presenceStatusForAccount(snapshot, accountId), [snapshot]) };
}
```

During implementation, reuse existing `cloudWebSocketsEnabled` helper if present; do not force websockets on for tunnel previews.

- [ ] **Step 5: Install publisher in `useCloudSession.ts`**

Import and call:

```ts
import { useCloudPresencePublisher, publishPresenceOffline } from './useCloudPresencePublisher';
```

Inside `useCloudSession`, after `account` is available:

```ts
useCloudPresencePublisher(account);
```

In logout/sign-out path, before/around `clearSessionAndNotifySignedOut`, call:

```ts
void publishPresenceOffline(authClient);
```

- [ ] **Step 6: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx tests/cloudPresencePublisher.test.tsx tests/cloudSession.test.tsx
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/features/cloud/useCloudPresence.ts app/desktop/src/features/cloud/useCloudPresencePublisher.ts app/desktop/src/features/cloud/useCloudSession.ts app/desktop/tests/cloudPresencePublisher.test.tsx
git commit -m "Publish desktop cloud presence"
```

---

### Task 6: Avatar-light UI in Contacts and Participants

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/kordi-app/components/IdentityAvatar.tsx`
- Modify: `app/desktop/src/features/cloud/CloudContactsAdapter.tsx`
- Modify: `app/desktop/src/kordi-app/pages.tsx`
- Modify: `app/desktop/src/pages/GroupDetailsDialog.tsx`
- Test: `app/desktop/tests/cloudPresence.test.tsx` or new `cloudPresenceUi.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Append to `cloudPresence.test.tsx`:

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';

test('IdentityAvatar can render an online presence light without visible status text', () => {
  const html = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_1',
    name: '111',
    presenceStatus: 'online',
  }));
  assert.match(html, /app-presence-light/);
  assert.match(html, /data-presence-status="online"/);
  assert.doesNotMatch(html, />Online</);
});

test('IdentityAvatar can render an offline presence light without visible status text', () => {
  const html = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_2',
    name: '222',
    presenceStatus: 'offline',
  }));
  assert.match(html, /app-presence-light/);
  assert.match(html, /data-presence-status="offline"/);
  assert.doesNotMatch(html, />Offline</);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx
```

Expected: TypeScript/render failure because `presenceStatus` prop is missing.

- [ ] **Step 3: Add avatar prop and CSS classes**

Modify `IdentityAvatarProps`:

```ts
presenceStatus?: 'online' | 'offline' | null;
presenceLabel?: string | null;
```

Wrap the existing `<Avatar>` in a `span` and render the light:

```tsx
return (
  <span className={cn('relative inline-flex shrink-0', className)}>
    <Avatar className="h-full w-full rounded-full bg-slate-900/30 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" ...>
      ...existing contents...
    </Avatar>
    {presenceStatus ? (
      <span
        className="app-presence-light"
        data-presence-status={presenceStatus}
        aria-label={presenceLabel ?? `${name ?? 'Contact'} is ${presenceStatus}`}
        title={presenceLabel ?? `${name ?? 'Contact'} is ${presenceStatus}`}
      />
    ) : null}
  </span>
);
```

Preserve existing sizing by moving `className` to the wrapper and giving Avatar `h-full w-full`.

Add CSS in `app/desktop/src/styles/shell.css`:

```css
.app-presence-light {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 0.72rem;
  height: 0.72rem;
  border-radius: 999px;
  background: rgb(52 211 153);
  box-shadow: 0 0 0 2px rgb(15 17 23), 0 0 0 5px rgba(52, 211, 153, 0.13);
}

.app-presence-light[data-presence-status='offline'] {
  background: rgb(100 116 139);
  box-shadow: 0 0 0 2px rgb(15 17 23), 0 0 0 5px rgba(100, 116, 139, 0.12);
}
```

- [ ] **Step 4: Thread contact presence through cloud contacts**

In `CloudContactsAdapter`, call `const presence = useCloudPresence(account);` and map visible contacts:

```ts
function withPresence(contact: Contact): Contact {
  const accountId = cloudAccountIdForContact(contact);
  const status = presence.statusForAccount(accountId);
  return { ...contact, presenceStatus: status };
}
```

Apply to `visibleCloudContacts` before passing to `ContactsPage`.

- [ ] **Step 5: Render contact avatar light**

Find `ContactRow` in `pages.tsx`. Where it renders `EditableIdentityAvatar` or `IdentityAvatar`, pass:

```tsx
presenceStatus={contact.presenceStatus}
presenceLabel={`${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}`}
```

Do not render visible status text.

- [ ] **Step 6: Render participant avatar light**

In `GroupDetailsDialog.tsx`, derive participant presence by matching member stable IDs to cloud contacts or account IDs. Minimum first pass:

```ts
const presenceByContactId = new Map(contacts.map((contact) => [contactStableId(contact), contact.presenceStatus]));
function memberPresence(member: ConversationParticipant) {
  return presenceByContactId.get(memberStableId(member)) ?? 'offline';
}
```

Pass `presenceStatus={memberPresence(member)}` to participant avatar components in member rows and add-options if applicable.

- [ ] **Step 7: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx tests/cloudContactsLatency.test.tsx tests/chatDetailPanel.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add app/desktop/src/kordi-app/types.ts app/desktop/src/kordi-app/components/IdentityAvatar.tsx app/desktop/src/styles/shell.css app/desktop/src/features/cloud/CloudContactsAdapter.tsx app/desktop/src/kordi-app/pages.tsx app/desktop/src/pages/GroupDetailsDialog.tsx app/desktop/tests/cloudPresence.test.tsx
git commit -m "Show cloud presence on avatars"
```

---

### Task 7: Full verification, subissue reference, and preview

**Files:**
- Modify: PR/issue references if needed.
- Test: backend + desktop suites.

- [ ] **Step 1: Run desktop verification**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudPresence.test.tsx tests/cloudPresencePublisher.test.tsx tests/cloudSession.test.tsx tests/cloudContactsLatency.test.tsx tests/chatDetailPanel.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: all listed tests pass, typecheck exits 0.

- [ ] **Step 2: Run backend verification**

```bash
cargo test -p kordi-cloud-server presence::tests ws::tests
```

If `DATABASE_URL` is available, also run:

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e presence
```

Expected: unit tests pass; e2e tests pass or skip only when `DATABASE_URL` is intentionally absent.

- [ ] **Step 3: Confirm issue reference**

Update commit/PR body to mention:

```md
Refs #492
Part of #479
```

Do not close #479 from this subissue.

- [ ] **Step 4: Launch Cloud Edition preview**

From worktree:

```bash
CARGO_TARGET_DIR=/Users/shuyang/kordi/.worktrees/issue-479-presence-status/target \
KORDI_CLOUD_USE_LOCAL_TUNNEL=1 \
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2,user3
```

Expected ports:

- user1: `http://127.0.0.1:1482`
- user2: `http://127.0.0.1:1484`
- user3: `http://127.0.0.1:1486`

- [ ] **Step 5: Manual validation checklist**

- Register/sign in three clean users.
- Add/accept contacts.
- Confirm Contacts avatars show green lights for online contacts.
- Confirm participant avatars show green/gray lights without status words.
- Close one app instance.
- Confirm the light turns gray after explicit offline or heartbeat timeout.
- Reopen/sign in that user.
- Confirm the light turns green again.

- [ ] **Step 6: Commit any verification-only docs updates**

Only commit if docs or tests changed:

```bash
git status --short
git add <changed-files>
git commit -m "Document cloud presence validation"
```

---

## Self-review notes

- Spec coverage: device-level state, account rollup, contacts-only read API, realtime events, timeout, desktop lifecycle, and avatar-light UI each have a task.
- Scope: server read-only fallback is explicitly excluded; #479 remains open after this subissue.
- Ambiguity resolved: visible UI is avatar light only; no pills, status labels, or last-seen text.
- Implementation caution: do not publish offline from React effect cleanup; only logout/pagehide/beforeunload.
