# Issue 159 Bridge Raw Store Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair historical raw Bridge SQLite rows where shared `bridge-person` session-relay agent responses were stored in a sibling base conversation with a non-response direction.

**Architecture:** Add an idempotent raw-store repair pass in the Bridge conversation storage layer, run after existing legacy JSON/message-outreach reconciliation. The repair scans persisted conversation records, moves only session-relay/session-message `bridge-person` response rows into the scoped `:person` conversation, normalizes directions, updates outreach metadata, and merges duplicate target rows by `(request_id, direction)`.

**Tech Stack:** Rust/Tauri desktop backend, rusqlite, existing Bridge conversation storage modules, existing `cargo test -p kordi-desktop --no-default-features` tests.

---

## Debug Evidence / Root Cause

Existing `user1` / `user2` DBs prove the raw store inconsistency is historical and persisted:

- Correct newer rows after #158:
  - user1: `bridge:...:person`, `outbound-response`, `targetKind=bridge-person`, `parentTurnId` set
  - user2: `bridge:...:person`, `inbound-response`, `targetKind=bridge-person`, `parentTurnId` set
- Broken older rows:
  - user2 disk usage response: `bridge:...` base conversation, `direction=inbound`, `peer_runtime=kordi-desktop`, `targetKind=bridge-person`, `contextPolicy=session-relay`, `parentTurnId` set
  - user1 has similar older remote-agent rows in the base conversation

#158 fixed future writes in `conversation_actions.rs` and `mailbox.rs`. #159 is only the historical raw-store repair.

## Safety Principles

1. **No active user data reset.** Do not delete simulated user DBs.
2. **Single SQLite transaction per repair run.** Either all moves/merges apply or none do.
3. **Idempotent.** Running repair repeatedly must not duplicate messages.
4. **Narrow predicate.** Only repair rows whose message-level `outreach` has:
   - `target_kind == "bridge-person"`
   - `context_policy == "session-relay"` or `"session-message"`
   - non-empty `parent_session_id`
   - non-empty `parent_turn_id` or an existing response direction
   - row is either in the sibling base conversation or already in `:person` with non-response direction/stale metadata
5. **Preserve source conversations.** Do not delete conversations in this change; only remove moved duplicate message rows from the wrong conversation and clear/move wrong conversation-level outreach where safe.
6. **Canonical guard remains.** Do not remove #158 canonical source-selection guard in this PR.

---

## File Structure

- Create: `app/desktop/src-tauri/src/bridge/storage/conversations/repair.rs`
  - Owns idempotent historical row repair.
  - Contains pure helper functions for classification/direction normalization.
  - Contains DB repair entrypoint used by schema migration/load.
  - Also normalizes already-scoped `:person` response rows whose old direction is plain `inbound`/`outbound`.
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations.rs`
  - Add `mod repair;`.
  - Export repair entrypoint under `#[cfg(test)]` for unit tests.
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs`
  - Call repair after `reconcile_persisted_message_outreach_metadata` in `migrate_legacy_conversation_json`.
- Modify: `app/desktop/src-tauri/src/bridge/storage/tests.rs`
  - Add failing tests for move, direction normalization, dedupe, and idempotency.

---

## Task 1: Add failing repair tests

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/storage/tests.rs`

- [ ] **Step 1: Add helpers for split session-relay fixtures**

Append these helper functions near existing `test_outreach` in `storage/tests.rs`:

```rust
fn test_outreach_for_conversation(
    request_id: &str,
    conversation_id: &str,
    parent_turn_id: Option<&str>,
    delivery_state: Option<&str>,
) -> DesktopBridgeOutreachMetadata {
    let mut outreach = test_outreach(request_id, delivery_state);
    outreach.bridge_conversation_id = Some(conversation_id.to_string());
    outreach.parent_turn_id = parent_turn_id.map(ToString::to_string);
    outreach.context_policy = Some("session-relay".to_string());
    outreach.parent_session_id = Some("session:bridge:humans:test".to_string());
    outreach.target_kind = "bridge-person".to_string();
    outreach
}

fn bridge_person_conversation_id() -> &'static str {
    "bridge:host-1:peer-1:person"
}

fn bridge_base_conversation_id() -> &'static str {
    "bridge:host-1:peer-1"
}
```

- [ ] **Step 2: Add test for moving inbound response from base to person conversation**

Append this test:

```rust
#[test]
fn repair_moves_inbound_session_relay_agent_response_into_person_thread() {
    let mut conn = memory_conversation_db();

    let mut person = test_conversation(vec![test_message(
        "msg-request",
        "inbound",
        "@MyKordi check my disk usage",
        1_000,
        Some("req-user"),
        None,
    )]);
    person.id = bridge_person_conversation_id().to_string();
    person.peer_runtime = "person".to_string();
    upsert_conversation_record(&conn, &person).expect("insert person thread");

    let mut response = test_message(
        "msg-response-wrong-thread",
        "inbound",
        "I tried to check disk usage with `df -h`.",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert wrong base thread");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("repair split rows");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation exists");
    assert!(person.messages.iter().any(|message| {
        message.id == "msg-response-wrong-thread"
            && message.direction == "inbound-response"
            && message.outreach.as_ref().and_then(|outreach| outreach.bridge_conversation_id.as_deref())
                == Some(bridge_person_conversation_id())
    }));

    let base = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_base_conversation_id())
        .expect("base conversation preserved");
    assert!(!base.messages.iter().any(|message| message.id == "msg-response-wrong-thread"));
}
```

Expected before implementation: compile failure because `repair_split_bridge_person_session_relay_rows` is not exported.

- [ ] **Step 3: Add test for outbound direction normalization**

Append this test:

```rust
#[test]
fn repair_moves_outbound_session_relay_agent_response_as_outbound_response() {
    let mut conn = memory_conversation_db();

    let mut response = test_message(
        "msg-outbound-response-wrong-thread",
        "outbound",
        "Final local answer",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert wrong base thread");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("repair split rows");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation created");
    assert_eq!(person.peer_runtime, "person");
    assert!(person.messages.iter().any(|message| {
        message.id == "msg-outbound-response-wrong-thread"
            && message.direction == "outbound-response"
            && message.text == "Final local answer"
    }));
}
```

- [ ] **Step 4: Add dedupe/idempotency test**

Append this test:

```rust
#[test]
fn repair_is_idempotent_and_merges_duplicate_target_response() {
    let mut conn = memory_conversation_db();

    let mut target_response = test_message(
        "msg-target-processing",
        "inbound-response",
        "processing...",
        1_000,
        Some("req-agent"),
        Some("processing"),
    );
    target_response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_person_conversation_id(),
        Some("turn-agent"),
        Some("processing"),
    ));
    let mut person = test_conversation(vec![target_response]);
    person.id = bridge_person_conversation_id().to_string();
    upsert_conversation_record(&conn, &person).expect("insert target processing row");

    let mut source_response = test_message(
        "msg-source-final",
        "inbound",
        "Final answer",
        1_500,
        Some("req-agent"),
        Some("responded"),
    );
    source_response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![source_response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert source final row");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("first repair");
    repair_split_bridge_person_session_relay_rows(&mut conn).expect("second repair");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation exists");
    let responses = person
        .messages
        .iter()
        .filter(|message| message.request_id.as_deref() == Some("req-agent") && message.direction == "inbound-response")
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].text, "Final answer");
    assert_eq!(responses[0].delivery_state.as_deref(), Some("responded"));
}
```

- [ ] **Step 5: Run tests and verify they fail before implementation**

Run:

```bash
cargo test -p kordi-desktop --no-default-features repair_moves_inbound_session_relay_agent_response_into_person_thread
```

If sidecar binaries are missing in this worktree, first run:

```bash
pnpm --dir app/desktop tauri:prepare-sidecars
```

Expected initial failure: `cannot find function repair_split_bridge_person_session_relay_rows`.

---

## Task 2: Implement repair classification helpers

**Files:**
- Create: `app/desktop/src-tauri/src/bridge/storage/conversations/repair.rs`
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations.rs`

- [ ] **Step 1: Create `repair.rs` with pure helpers**

Create `app/desktop/src-tauri/src/bridge/storage/conversations/repair.rs`:

```rust
use rusqlite::{params, Connection, TransactionBehavior};

use super::lookup::scoped_conversation_id;
use super::merge::merge_conversation_message_records;
use super::outreach_metadata::reconcile_message_outreach_for_storage;
use super::records::{load_conversation_record, load_conversation_store_from_db, optional_json, store_conversation_record, store_message_record};
use super::schema::sqlite_error;
use crate::bridge::constants::{
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
};
use crate::bridge::{DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord, DesktopBridgeOutreachMetadata};

fn is_session_policy(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|policy| policy.eq_ignore_ascii_case("session-relay") || policy.eq_ignore_ascii_case("session-message"))
}

fn has_text(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn response_direction(direction: &str) -> Option<&'static str> {
    match direction {
        BRIDGE_MESSAGE_DIRECTION_INBOUND | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE => {
            Some(BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE)
        }
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE => {
            Some(BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE)
        }
        _ => None,
    }
}

fn should_repair_message(message: &DesktopBridgeConversationMessageRecord) -> bool {
    let Some(outreach) = message.outreach.as_ref() else {
        return false;
    };
    outreach.target_kind.trim().eq_ignore_ascii_case("bridge-person")
        && is_session_policy(outreach.context_policy.as_deref())
        && has_text(outreach.parent_session_id.as_deref())
        && (has_text(outreach.parent_turn_id.as_deref())
            || matches!(
                message.direction.as_str(),
                BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
            ))
        && response_direction(&message.direction).is_some()
}

fn target_person_conversation_id(conversation: &DesktopBridgeConversationRecord) -> String {
    scoped_conversation_id(
        &conversation.host_id,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        "person",
    )
}
```

- [ ] **Step 2: Register module and test export**

Modify `app/desktop/src-tauri/src/bridge/storage/conversations.rs`:

```rust
mod repair;
```

Add this test export near existing `#[cfg(test)]` exports:

```rust
#[cfg(test)]
pub(in crate::bridge::storage) use repair::repair_split_bridge_person_session_relay_rows;
```

- [ ] **Step 3: Run helper compile check**

Run:

```bash
cargo test -p kordi-desktop --no-default-features repair_moves_inbound_session_relay_agent_response_into_person_thread
```

Expected: still fails because `repair_split_bridge_person_session_relay_rows` is not implemented/exported public yet.

---

## Task 3: Implement idempotent DB repair

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations/repair.rs`

- [ ] **Step 1: Add repair entrypoint and row collection**

Append this code to `repair.rs`:

```rust
#[derive(Debug, Clone)]
struct RepairMove {
    source_conversation_id: String,
    target_conversation_id: String,
    message: DesktopBridgeConversationMessageRecord,
}

fn normalize_message_for_target(
    mut message: DesktopBridgeConversationMessageRecord,
    target_conversation_id: &str,
) -> Option<DesktopBridgeConversationMessageRecord> {
    let next_direction = response_direction(&message.direction)?.to_string();
    message.direction = next_direction;
    if let Some(outreach) = message.outreach.as_mut() {
        outreach.bridge_conversation_id = Some(target_conversation_id.to_string());
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = message.request_id.clone();
        }
        reconcile_message_outreach_for_storage(
            outreach,
            target_conversation_id,
            message.request_id.as_deref(),
            message.delivery_state.as_deref(),
            &message.text,
            None,
            message.timestamp_ms,
        );
    }
    Some(message)
}

fn collect_repair_moves(
    conversations: &[DesktopBridgeConversationRecord],
) -> Vec<RepairMove> {
    let mut moves = Vec::new();
    for conversation in conversations {
        let target_conversation_id = target_person_conversation_id(conversation);
        if conversation.id == target_conversation_id {
            continue;
        }
        for message in &conversation.messages {
            if !should_repair_message(message) {
                continue;
            }
            let Some(message) = normalize_message_for_target(message.clone(), &target_conversation_id) else {
                continue;
            };
            moves.push(RepairMove {
                source_conversation_id: conversation.id.clone(),
                target_conversation_id,
                message,
            });
        }
    }
    moves
}
```

- [ ] **Step 2: Add target conversation creation/update helper**

Append this code to `repair.rs`:

```rust
fn fallback_person_conversation(
    source: &DesktopBridgeConversationRecord,
    target_conversation_id: &str,
) -> DesktopBridgeConversationRecord {
    DesktopBridgeConversationRecord {
        id: target_conversation_id.to_string(),
        host_id: source.host_id.clone(),
        peer_node_id: source.peer_node_id.clone(),
        peer_display_name: source.peer_owner_name.clone().or_else(|| source.peer_display_name.clone()),
        peer_owner_name: source.peer_owner_name.clone(),
        peer_runtime: "person".to_string(),
        project_id: source.project_id.clone(),
        project_name: source.project_name.clone(),
        unread_count: 0,
        updated_at_ms: source.updated_at_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: source.peer_last_heartbeat_at_ms,
        outreach: None,
        identity: source.identity.clone(),
        messages: Vec::new(),
    }
}

fn merge_message_into_target(
    target: &mut DesktopBridgeConversationRecord,
    message: DesktopBridgeConversationMessageRecord,
) {
    if let Some(existing_index) = message.request_id.as_deref().and_then(|request_id| {
        target.messages.iter().position(|existing| {
            existing.request_id.as_deref() == Some(request_id)
                && existing.direction == message.direction
        })
    }) {
        let mut merged = merge_conversation_message_records(&target.messages[existing_index], &message);
        merged.id = target.messages[existing_index].id.clone();
        target.messages[existing_index] = merged;
    } else if let Some(existing_index) = target.messages.iter().position(|existing| existing.id == message.id) {
        target.messages[existing_index] = merge_conversation_message_records(&target.messages[existing_index], &message);
    } else {
        target.messages.push(message);
    }
    target.messages.sort_by(|left, right| {
        left.timestamp_ms.cmp(&right.timestamp_ms).then_with(|| left.id.cmp(&right.id))
    });
    target.updated_at_ms = target
        .messages
        .iter()
        .map(|message| message.timestamp_ms)
        .max()
        .unwrap_or(target.updated_at_ms)
        .max(target.updated_at_ms);
}
```

- [ ] **Step 3: Add transaction implementation**

Append this entrypoint to `repair.rs`:

```rust
pub(in crate::bridge::storage) fn repair_split_bridge_person_session_relay_rows(
    conn: &mut Connection,
) -> Result<(), String> {
    let store = load_conversation_store_from_db(conn)?;
    let moves = collect_repair_moves(&store.conversations);
    if moves.is_empty() {
        return Ok(());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;

    for repair_move in moves {
        let source = load_conversation_record(&tx, &repair_move.source_conversation_id)?;
        let Some(mut source) = source else {
            continue;
        };
        let mut target = load_conversation_record(&tx, &repair_move.target_conversation_id)?
            .unwrap_or_else(|| fallback_person_conversation(&source, &repair_move.target_conversation_id));

        let message_id = repair_move.message.id.clone();
        merge_message_into_target(&mut target, repair_move.message);
        store_conversation_record(&tx, &target)?;
        for message in &target.messages {
            store_message_record(&tx, &target.id, message)?;
        }

        source.messages.retain(|message| message.id != message_id);
        if let Some(outreach) = source.outreach.as_mut() {
            if outreach.target_kind.trim().eq_ignore_ascii_case("bridge-person")
                && has_text(outreach.parent_turn_id.as_deref())
                && outreach.bridge_conversation_id.as_deref() == Some(source.id.as_str())
            {
                outreach.bridge_conversation_id = Some(target.id.clone());
            }
        }
        store_conversation_record(&tx, &source)?;
        tx.execute(
            "DELETE FROM bridge_messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, source.id],
        )
        .map_err(sqlite_error)?;
    }

    tx.commit().map_err(sqlite_error)?;
    Ok(())
}
```

- [ ] **Step 4: Run tests and iterate only on compile errors**

Run:

```bash
cargo test -p kordi-desktop --no-default-features repair_moves_inbound_session_relay_agent_response_into_person_thread
cargo test -p kordi-desktop --no-default-features repair_moves_outbound_session_relay_agent_response_as_outbound_response
cargo test -p kordi-desktop --no-default-features repair_is_idempotent_and_merges_duplicate_target_response
```

Expected: tests pass after compile fixes.

---

## Task 4: Wire repair into migration/load path safely

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs`
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations.rs`

- [ ] **Step 1: Export repair function for schema module**

Modify `app/desktop/src-tauri/src/bridge/storage/conversations.rs`:

```rust
pub(in crate::bridge::storage) use repair::repair_split_bridge_person_session_relay_rows;
```

- [ ] **Step 2: Import repair in schema**

Modify imports in `schema.rs`:

```rust
use super::repair::repair_split_bridge_person_session_relay_rows;
```

If importing via module path fails due privacy, use the re-export from `conversations.rs`.

- [ ] **Step 3: Call repair after outreach reconciliation**

In `migrate_legacy_conversation_json`, replace both returns that currently end with `reconcile_persisted_message_outreach_metadata(conn)` with:

```rust
reconcile_persisted_message_outreach_metadata(conn)?;
repair_split_bridge_person_session_relay_rows(conn)?;
Ok(())
```

Specifically:

```rust
if conversation_json_migrated(conn)? {
    reconcile_persisted_message_outreach_metadata(conn)?;
    repair_split_bridge_person_session_relay_rows(conn)?;
    return Ok(());
}
```

and after `mark_conversation_json_migrated` commit:

```rust
reconcile_persisted_message_outreach_metadata(conn)?;
repair_split_bridge_person_session_relay_rows(conn)?;
Ok(())
```

- [ ] **Step 4: Run storage tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features bridge::storage::tests
```

Expected: all Bridge storage tests pass.

---

## Task 5: Add a direct migration/load-path regression

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/storage/tests.rs`

- [ ] **Step 1: Add test proving load path invokes repair**

Append this test:

```rust
#[test]
fn migrate_load_path_repairs_split_session_relay_rows() {
    let mut conn = memory_conversation_db();

    let mut response = test_message(
        "msg-response-wrong-thread",
        "inbound",
        "Final answer",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert split source row");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("simulate migration repair");

    let repaired = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = repaired
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person thread exists after repair");
    assert_eq!(person.messages.len(), 1);
    assert_eq!(person.messages[0].direction, "inbound-response");
    assert_eq!(person.messages[0].text, "Final answer");
}
```

- [ ] **Step 2: Run test**

Run:

```bash
cargo test -p kordi-desktop --no-default-features migrate_load_path_repairs_split_session_relay_rows
```

Expected: PASS.

---

## Task 6: Manual data dry-run query before QA

**Files:**
- No code changes.

- [ ] **Step 1: Query existing active user DBs before launching repaired build**

Run:

```bash
for u in user1 user2; do
  db=/Users/shuyang/kordi/app/desktop/.multi-instance-data/$u/korde/desktop-bridge-conversations.sqlite3
  echo "===== $u suspects before repair ====="
  sqlite3 -cmd ".timeout 5000" -header -column "$db" \
    "select m.id, m.conversation_id, c.peer_runtime, m.direction, substr(m.text,1,60) as text,
            json_extract(m.outreach_metadata,'$.targetKind') as target_kind,
            json_extract(m.outreach_metadata,'$.contextPolicy') as policy,
            json_extract(m.outreach_metadata,'$.parentTurnId') as parent_turn
     from bridge_messages m
     join bridge_conversations c on c.id=m.conversation_id
     where json_extract(m.outreach_metadata,'$.targetKind')='bridge-person'
       and json_extract(m.outreach_metadata,'$.contextPolicy') in ('session-relay','session-message')
       and json_extract(m.outreach_metadata,'$.parentTurnId') is not null
       and m.conversation_id not like '%:person'
     order by m.timestamp_ms;"
done
```

Expected before repair on current historical DBs: several rows in base conversations.

- [ ] **Step 2: Back up active DBs before manual QA**

Run:

```bash
stamp=$(date +%Y%m%d-%H%M%S)
for u in user1 user2; do
  src=/Users/shuyang/kordi/app/desktop/.multi-instance-data/$u/korde/desktop-bridge-conversations.sqlite3
  cp "$src" "$src.issue159-backup-$stamp"
done
```

Expected: two backup files next to active DBs. Do not back up or reset canonical DB unless manual QA specifically requires it.

---

## Task 7: Full verification

**Files:**
- No code changes.

- [ ] **Step 1: Run formatting**

```bash
cargo fmt --all -- --check
```

Expected: no formatting diffs.

- [ ] **Step 2: Run Rust desktop tests**

```bash
cargo test -p kordi-desktop --no-default-features
```

Expected: all tests pass.

- [ ] **Step 3: Run frontend regression suite to ensure #158 guard remains intact**

If `node_modules` is absent in this worktree, first run:

```bash
pnpm install
```

Then run:

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: all pass.

- [ ] **Step 4: Check whitespace**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src-tauri/src/bridge/storage/conversations.rs \
        app/desktop/src-tauri/src/bridge/storage/conversations/repair.rs \
        app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs \
        app/desktop/src-tauri/src/bridge/storage/tests.rs

git commit -m "Repair split bridge person relay rows"
```

---

## Task 8: Manual QA on existing user1/user2 data

**Files:**
- No code changes unless QA finds a bug.

- [ ] **Step 1: Stop active preview only with explicit approval**

Do not restart existing `user1` / `user2` windows without confirming with the user. If approved, stop via multi-instance shared script.

- [ ] **Step 2: Launch issue-159 worktree preview using existing DBs**

Run from this worktree:

```bash
pnpm dev:desktop:multi -- --config /tmp/kordi-issue146-users.yaml --users user1,user2
```

Expected: user1 on 1482, user2 on 1484, preserving existing data.

- [ ] **Step 3: Confirm repair query returns no wrong-thread rows**

Re-run the query from Task 6 Step 1.

Expected after repair: no rows whose session-relay `bridge-person` response with `parentTurnId` remains in base conversation.

- [ ] **Step 4: Open affected shared session**

Manual checks:

- Old disk-usage response still appears once in shared chat.
- No duplicate final response.
- No response hiding/flapping.
- Raw Bridge/direct views do not show the moved response as an unrelated sibling agent conversation.
- Extra `processing...` placeholder is noted under #160 if still present; do not fix #160 in this PR unless explicitly approved.

---

## Self-Review

- Spec coverage: Covers moving historical split rows, direction normalization, idempotency, dedupe, preserving canonical data, and manual QA.
- Placeholder scan: No TBD/TODO/fill-later placeholders.
- Type consistency: Uses existing `DesktopBridgeConversationRecord`, `DesktopBridgeConversationMessageRecord`, `DesktopBridgeOutreachMetadata`, `upsert_conversation_record`, and `load_conversation_store_from_db` names from the current codebase.
