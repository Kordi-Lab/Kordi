# Chat Create Flows and Group Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Chats `+` create menu, people-only group creation, local group details/management, and `#` child session titles.

**Architecture:** Stack this branch on PR #189 because the create/details UI depends on participant-space drill-in. Store group foundations in the existing canonical session tables: `sessions.kind = 'group'`, `sessions.metadata_json` for group policy/admin metadata, and `session_participants` for active people members. Add small canonical-session commands for rename/metadata/member/role mutation and focused React helpers/dialogs for the UI.

**Tech Stack:** React 19 + TypeScript, existing Kordi desktop shell args, Tauri commands, Rust/rusqlite canonical session storage, Node `tsx --test` tests.

---

## Scope

In scope:

- `+` opens a create menu: chat with person, chat with agent, start group.
- Start group picker lists people contacts only and requires at least two selected contacts.
- Group creation creates a stable canonical `group` session id and default people-derived name.
- Group details `...` in drilled participant-space header shows name, created date, members, admins.
- Admins can rename groups, add/remove people contacts, promote/demote admins while keeping at least one admin.
- Groups under 50 people add contacts immediately without approval in local state.
- Child session rows in participant-space drill-in show `# ` before the session title.

Out of scope:

- Multi-device fan-out.
- Remote invite delivery.
- Approval workflows for 50+ member groups.
- Dedicated `participant_spaces` backend tables.

## File map

- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
  - Add Tauri command exports for canonical session mutation.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/commands.rs`
  - Add command wrappers that return fresh `CanonicalSessionState`.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/models.rs`
  - Add request types for metadata, participant add/remove, and role changes.
- Modify: `app/desktop/src-tauri/src/lib.rs`
  - Register new Tauri commands.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`
  - Add Rust tests for stable metadata, member state, and admin safeguard helpers.
- Modify: `app/desktop/src/kordi-app/types.ts`
  - Add frontend request types and allow canonical participant role `admin`.
- Modify: `app/desktop/src/lib/desktop.ts`
  - Add invoke wrappers for new canonical commands.
- Create: `app/desktop/src/features/chat/chatCreateFlows.ts`
  - Derive people/agent options, default group names, and group metadata.
- Create: `app/desktop/src/pages/ChatCreateDialog.tsx`
  - Render menu and pickers for person, agent, and group flows.
- Create: `app/desktop/src/pages/GroupDetailsDialog.tsx`
  - Render details/manage panel for group participant spaces.
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
  - Thread new create/manage handlers through shell args.
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
  - Forward new handlers to sidebar args.
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
  - Pass new props to `WorkspaceSidebar`.
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
  - Implement create/manage handlers using canonical commands and existing bridge handlers.
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
  - Open create dialog from `+`, add group `...`, show `#` session prefixes.
- Create/Modify tests:
  - `app/desktop/tests/chatCreateFlows.test.tsx`
  - `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`
  - `app/desktop/tests/chatRouting.test.tsx`

---

### Task 1: Backend canonical group mutation commands

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/models.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/commands.rs`
- Modify: `app/desktop/src-tauri/src/lib.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [x] **Step 1: Write Rust tests**

Add a helper and tests to `app/desktop/src-tauri/src/canonical_sessions/tests.rs`:

```rust
fn seed_identity(conn: &Connection, id: &str, display_name: &str, kind: &str) -> CanonicalIdentity {
    upsert_identity_in_db(conn, UpsertCanonicalIdentityRequest {
        id: Some(id.to_string()),
        kind: kind.to_string(),
        display_name: display_name.to_string(),
        owner_identity_id: None,
        source: Some("local".to_string()),
        source_host_id: None,
        bridge_node_id: None,
        human_id: kind.eq_ignore_ascii_case("human").then(|| id.trim_start_matches("human:").to_string()),
        agent_id: kind.eq_ignore_ascii_case("agent").then(|| id.trim_start_matches("agent:").to_string()),
        avatar_key: Some(id.to_string()),
        profile_image_url: None,
        metadata: None,
    }).expect("seed identity")
}

#[test]
fn canonical_group_metadata_and_participant_role_mutations_are_stable() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let bob = seed_identity(&conn, "human:bob", "Bob", "human");
    let group = open_or_create_session_in_db(&conn, OpenCanonicalSessionRequest {
        id: Some("session:group:test".to_string()),
        kind: "group".to_string(),
        title: Some("Alice, Bob".to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: creator.id.clone(),
        primary_identity_id: None,
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: vec![alice.id.clone(), bob.id.clone()],
        metadata: Some(serde_json::json!({ "adminIdentityIds": [creator.id.clone()], "customName": null })),
    }).expect("create group");

    rename_session_in_db(&conn, &group.id, "Design crew").expect("rename");
    set_session_metadata_in_db(&conn, &group.id, serde_json::json!({ "adminIdentityIds": [creator.id.clone(), alice.id.clone()], "customName": "Design crew" })).expect("metadata");
    set_session_participant_role_in_db(&conn, &group.id, &alice.id, "admin").expect("admin role");
    remove_session_participant_in_db(&conn, &group.id, &bob.id).expect("remove member");

    let selected = select_session(&conn, &group.id).expect("select").expect("session");
    assert_eq!(selected.id, "session:group:test");
    assert_eq!(selected.title, "Design crew");
    assert_eq!(selected.metadata.unwrap()["customName"], "Design crew");
    let bob_state: String = conn.query_row(
        "SELECT state FROM session_participants WHERE session_id = ?1 AND identity_id = ?2",
        rusqlite::params![group.id, bob.id],
        |row| row.get(0),
    ).expect("bob state");
    assert_eq!(bob_state, "left");
}

#[test]
fn canonical_group_role_mutation_rejects_last_admin_removal() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let alice = seed_identity(&conn, "human:alice", "Alice", "human");
    let group = open_or_create_session_in_db(&conn, OpenCanonicalSessionRequest {
        id: Some("session:group:admin".to_string()),
        kind: "group".to_string(),
        title: Some("Alice".to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: creator.id.clone(),
        primary_identity_id: None,
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: vec![alice.id.clone()],
        metadata: Some(serde_json::json!({ "adminIdentityIds": [creator.id.clone()] })),
    }).expect("create group");

    let error = set_session_participant_role_in_db(&conn, &group.id, &creator.id, "person").expect_err("last admin rejected");
    assert!(error.contains("at least one admin"));
}
```

- [x] **Step 2: Run RED**

Run:

```bash
cargo test -p kordi-desktop --no-default-features canonical_group_metadata_and_participant_role_mutations_are_stable canonical_group_role_mutation_rejects_last_admin_removal
```

Expected: FAIL because helper functions and/or request types do not exist.

- [x] **Step 3: Implement commands**

Add request structs to `models.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanonicalSessionMetadataRequest {
    pub session_id: String,
    pub metadata: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCanonicalSessionParticipantsRequest {
    pub session_id: String,
    pub identity_ids: Vec<String>,
    pub added_by_identity_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCanonicalSessionParticipantRequest {
    pub session_id: String,
    pub identity_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCanonicalSessionParticipantRoleRequest {
    pub session_id: String,
    pub identity_id: String,
    pub role: String,
}
```

Implement helpers in `canonical_sessions.rs`:

```rust
fn ensure_group_session(conn: &Connection, session_id: &str) -> Result<CanonicalSession, String> {
    let session = select_session(conn, session_id)?.ok_or_else(|| "Group session not found".to_string())?;
    if session.kind != "group" {
        return Err("Session is not a group".to_string());
    }
    Ok(session)
}

fn rename_session_in_db(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() { return Err("Group name is required".to_string()); }
    ensure_group_session(conn, session_id)?;
    conn.execute("UPDATE sessions SET title = ?2, updated_at_ms = ?3 WHERE id = ?1", params![session_id, title, now_ms()])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn set_session_metadata_in_db(conn: &Connection, session_id: &str, metadata: Value) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let raw = serde_json::to_string(&metadata).map_err(|err| err.to_string())?;
    conn.execute("UPDATE sessions SET metadata_json = ?2, updated_at_ms = ?3 WHERE id = ?1", params![session_id, raw, now_ms()])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn add_session_participants_in_db(conn: &Connection, session_id: &str, identity_ids: &[String], added_by: &str) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let now = now_ms();
    for identity_id in identity_ids.iter().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        upsert_participant(conn, session_id, identity_id, "person", Some(added_by), now)?;
    }
    Ok(())
}

fn active_admin_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_participants WHERE session_id = ?1 AND role IN ('self', 'admin') AND state = 'active'",
        params![session_id],
        |row| row.get(0),
    ).map_err(|err| err.to_string())
}

fn set_session_participant_role_in_db(conn: &Connection, session_id: &str, identity_id: &str, role: &str) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let role = role.trim().to_lowercase();
    if !matches!(role.as_str(), "self" | "admin" | "person" | "delegate") {
        return Err("Unsupported participant role".to_string());
    }
    let existing_role: Option<String> = conn.query_row(
        "SELECT role FROM session_participants WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
        params![session_id, identity_id],
        |row| row.get(0),
    ).optional().map_err(|err| err.to_string())?;
    if matches!(existing_role.as_deref(), Some("self" | "admin")) && !matches!(role.as_str(), "self" | "admin") && active_admin_count(conn, session_id)? <= 1 {
        return Err("Group must keep at least one admin".to_string());
    }
    conn.execute(
        "UPDATE session_participants SET role = ?3 WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
        params![session_id, identity_id, role],
    ).map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_session_participant_in_db(conn: &Connection, session_id: &str, identity_id: &str) -> Result<(), String> {
    ensure_group_session(conn, session_id)?;
    let existing_role: Option<String> = conn.query_row(
        "SELECT role FROM session_participants WHERE session_id = ?1 AND identity_id = ?2 AND state = 'active'",
        params![session_id, identity_id],
        |row| row.get(0),
    ).optional().map_err(|err| err.to_string())?;
    if matches!(existing_role.as_deref(), Some("self" | "admin")) && active_admin_count(conn, session_id)? <= 1 {
        return Err("Group must keep at least one admin".to_string());
    }
    conn.execute(
        "UPDATE session_participants SET state = 'left', updated_at_ms = ?3 WHERE session_id = ?1 AND identity_id = ?2",
        params![session_id, identity_id, now_ms()],
    ).map_err(|err| err.to_string())?;
    Ok(())
}
```

Add wrappers in `commands.rs`, Tauri exports in `canonical_sessions.rs`, and register each command in `lib.rs`.

- [x] **Step 4: Run GREEN**

Run:

```bash
cargo test -p kordi-desktop --no-default-features canonical_group
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add app/desktop/src-tauri/src/canonical_sessions.rs app/desktop/src-tauri/src/canonical_sessions/commands.rs app/desktop/src-tauri/src/canonical_sessions/models.rs app/desktop/src-tauri/src/lib.rs app/desktop/src-tauri/src/canonical_sessions/tests.rs
git commit -m "Add canonical group management commands"
```

---

### Task 2: Frontend group/create flow helpers

**Files:**
- Create: `app/desktop/src/features/chat/chatCreateFlows.ts`
- Create: `app/desktop/tests/chatCreateFlows.test.tsx`
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/lib/desktop.ts`

- [x] **Step 1: Write failing helper tests**

Create `app/desktop/tests/chatCreateFlows.test.tsx` with tests for people-only options, minimum selected people, stable names, metadata, and direct agent/person options.

- [x] **Step 2: Run RED**

```bash
pnpm --dir app/desktop test:unit -- chatCreateFlows.test.tsx
```

Expected: FAIL because `chatCreateFlows.ts` does not exist.

- [x] **Step 3: Implement helpers**

Create helpers:

```ts
export type ChatCreatePersonOption = { id: string; label: string; detail: string; avatarSeed?: string | null; profileImageUrl?: string | null; contact: Contact };
export type ChatCreateAgentOption = { id: string; label: string; detail: string; avatarSeed?: string | null; profileImageUrl?: string | null; agent: Agent };

export function groupDefaultName(names: string[]) {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (clean.length <= 2) return clean.join(', ');
  return `${clean.slice(0, 2).join(', ')} +${clean.length - 2} more`;
}

export function canCreateGroup(selectedContactIds: string[]) {
  return new Set(selectedContactIds.filter(Boolean)).size >= 2;
}
```

Derive people options from contacts with `entityType !== 'Agent'` and agents from `displayedAgents`.

Add TS request types for canonical commands and desktop invoke wrappers in `lib/desktop.ts`.

- [x] **Step 4: Run GREEN**

```bash
pnpm --dir app/desktop test:unit -- chatCreateFlows.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/chatCreateFlows.ts app/desktop/tests/chatCreateFlows.test.tsx app/desktop/src/kordi-app/types.ts app/desktop/src/lib/desktop.ts
git commit -m "Add chat create flow helpers"
```

---

### Task 3: App-level create and group management handlers

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Modify: `app/desktop/tests/chatRouting.test.tsx`

- [x] **Step 1: Add failing view-model/handler exposure tests**

Extend existing shell test fixtures to include new no-op handlers and assert shell args include group create/manage callbacks.

- [x] **Step 2: Run RED**

```bash
pnpm --dir app/desktop test:unit -- chatRouting.test.tsx
```

Expected: FAIL until props/types are wired.

- [x] **Step 3: Implement handlers**

In `useKordiAppModel.ts` add callbacks:

- `handleStartChatWithPerson(contact)`
- `handleStartChatWithAgent(agent)`
- `handleCreateChatGroup({ name, contactIds })`
- `handleRenameChatGroup(sessionId, name)`
- `handleAddChatGroupMembers(sessionId, contactIds)`
- `handleRemoveChatGroupMember(sessionId, identityId)`
- `handleSetChatGroupAdmin(sessionId, identityId, isAdmin)`

Group creation uses `openOrCreateCanonicalSession({ id: 'session:group:' + crypto.randomUUID(), kind: 'group', title, participantIdentityIds, metadata })` and selects the new session in Chats.

- [x] **Step 4: Run GREEN**

```bash
pnpm --dir app/desktop test:unit -- chatRouting.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/kordiShellSlots.types.ts app/desktop/src/app/useKordiShellArgs.ts app/desktop/src/app/assembleSidebarSlot.tsx app/desktop/tests/chatRouting.test.tsx
git commit -m "Wire chat create and group management handlers"
```

---

### Task 4: Sidebar create menu, group details, and session `#` prefix

**Files:**
- Create: `app/desktop/src/pages/ChatCreateDialog.tsx`
- Create: `app/desktop/src/pages/GroupDetailsDialog.tsx`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [x] **Step 1: Write failing static render tests**

Extend `workspaceSidebarParticipantSpaces.test.tsx` to assert:

- create dialog can render `Chat with person`, `Chat with agent`, `Start group`
- start group copy says `Select at least 2 people`
- selected-space child row title renders `# Hi shu`
- group header contains an accessible `Group details` button

- [x] **Step 2: Run RED**

```bash
pnpm --dir app/desktop test:unit -- workspaceSidebarParticipantSpaces.test.tsx
```

Expected: FAIL until UI exists.

- [x] **Step 3: Implement UI**

Add `ChatCreateDialog` with a mode state (`menu`, `person`, `agent`, `group`) and people-only group picker. Add `GroupDetailsDialog` with name edit, members/admins, add members, remove, promote/demote.

Update `WorkspaceSidebar`:

- replace both `+` buttons with create-dialog open behavior
- add `...` in selected group header
- prefix child session titles with `# `

- [x] **Step 4: Run GREEN**

```bash
pnpm --dir app/desktop test:unit -- workspaceSidebarParticipantSpaces.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add app/desktop/src/pages/ChatCreateDialog.tsx app/desktop/src/pages/GroupDetailsDialog.tsx app/desktop/src/pages/WorkspaceSidebar.tsx app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx
git commit -m "Add chat create and group detail UI"
```

---

### Task 5: Verification, QA refresh, and PR

- [x] **Step 1: Run full verification**

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
cargo fmt --all -- --check
git diff --check
```

Expected: PASS. Existing Vite large chunk warning is acceptable.

- [x] **Step 2: Refresh user1/user2 QA instances from this branch without resetting data**

Stop existing user1/user2 pid groups from `/Users/shuyang/kordi/app/desktop/.multi-instance-runtime`, then run:

```bash
pnpm --dir app/desktop tauri:dev:multi -- --config /Users/shuyang/kordi/app/desktop/scripts/multi-instance/configs/users.yaml --users user1,user2
curl -s -o /dev/null -w 'user1 %{http_code}\n' http://127.0.0.1:1482/
curl -s -o /dev/null -w 'user2 %{http_code}\n' http://127.0.0.1:1484/
```

Expected: both HTTP 200.

- [x] **Step 3: Push and open stacked PR**

```bash
git push -u origin feature/issue-171-create-flows
```

Open the PR against `feature/issue-171-sidebar-participant-spaces` until PR #189 lands, using `Refs #171`.

## Self-review

- Spec coverage: create menu, people-only group picker, stable group identity, details management, and `#` session rows are all covered.
- TDD: each behavior task starts with failing tests.
- Scope: fan-out and remote invite delivery remain out of scope.
- No placeholders: all commands, file paths, and validation commands are specified.
