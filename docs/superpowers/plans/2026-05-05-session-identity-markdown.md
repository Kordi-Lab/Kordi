# Per-Session Identity Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move volatile multi-user participant identity data into a generated Markdown file per session, and make visible participant events tell the model when to read that file.

**Architecture:** Canonical sessions stay the source of truth. A new `canonical_sessions::identity_markdown` module renders/writes per-session Markdown identity files from canonical identity data. Prompt builders stop embedding full participant frames in every shared-session prompt; instead they provide a small session identity file notice, and participant/identity event messages add model-visible read instructions while keeping UI text friendly.

**Tech Stack:** Rust/Tauri desktop backend, SQLite canonical sessions, Markdown model context files, existing Bridge/sessionThread payload JSON, Rust unit tests, TypeScript desktop tests.

---

## Context and constraints

- Design spec: `docs/superpowers/specs/2026-05-05-session-identity-markdown-design.md`.
- Current identity frame renderer: `app/desktop/src-tauri/src/canonical_sessions/identity_context.rs`.
- Current local/remote prompt builders: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`.
- Current default system prompt: `agent/crates/core/src/agent/helpers.rs`.
- Existing visible join event examples are created in:
  - `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`
  - `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs`
- Existing UI-visible text must remain like `Kordi User 1's Kordi joined via @mention`.
- Do not instruct the model to read the identity file every turn.
- Do not include session ids or participant ids in OpenAI `prompt_cache_key`.

## File structure

- Create `app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs`
  - Owns identity Markdown rendering, path generation, atomic writes, and model-visible read-instruction text.
- Modify `app/desktop/src-tauri/src/canonical_sessions.rs`
  - Adds module/export wiring for identity Markdown helpers.
- Modify `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
  - Writes identity Markdown for shared local/Bridge contexts.
  - Replaces full identity frame injection in shared-session prompts with a small file notice.
  - Adds model-visible read instructions for participant event messages.
- Modify `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`
  - Adds identity-file metadata to join-via-mention event messages.
- Modify `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs`
  - Adds identity-file metadata to relay join-via-mention event messages.
- Modify `app/desktop/src-tauri/src/canonical_sessions/group_participants.rs` and `commands.rs`
  - Regenerates identity Markdown after explicit group participant/metadata/role mutations.
- Modify `agent/crates/core/src/agent/helpers.rs`
  - Adds stable system-prompt rule for session identity Markdown.
- Modify `agent/crates/provider/src/openai.rs` tests only if prompt-cache marker expectations need updating after removing full frames from common shared-session prompts.
- Modify `app/desktop/src-tauri/src/canonical_sessions/tests.rs` and focused group request/response tests.

---

## Task 1: Add failing Markdown renderer and path tests

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`
- Later create: `app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs`
- Later modify: `app/desktop/src-tauri/src/canonical_sessions.rs`

- [ ] **Step 1: Add imports for future helpers**

Add these imports inside the existing `canonical_sessions::tests` module imports:

```rust
use super::{
    render_identity_context_markdown, session_identity_markdown_path,
    session_identity_model_visible_notice,
};
```

Expected initially: unresolved imports until Task 2 implements/exports them.

- [ ] **Step 2: Add path test**

Append this test near existing `identity_context_*` tests:

```rust
#[test]
fn identity_markdown_path_is_per_session_and_safe() {
    let first = session_identity_markdown_path("session:group:Kordi User 1");
    let second = session_identity_markdown_path("session:group:Kordi User 2");

    assert_ne!(first, second);
    assert!(first.ends_with(".md"), "{}", first.display());
    assert!(
        first.display().to_string().contains("session-identities"),
        "{}",
        first.display()
    );
    assert!(
        !first
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .contains(':'),
        "{}",
        first.display()
    );
}
```

- [ ] **Step 3: Add Markdown rendering test**

Append this test using the existing `alice_bob_identity_context_request()` helper:

```rust
#[test]
fn identity_markdown_renders_session_identity_file() {
    let markdown = render_identity_context_markdown(
        &alice_bob_identity_context_request(),
        "2026-05-05T12:34:56Z",
        Some("graph-hash-1"),
        Some("policy-hash-1"),
    );

    for marker in [
        "# Kordi Session Identity Context",
        "Version: v1",
        "Updated at: 2026-05-05T12:34:56Z",
        "Participant graph hash: graph-hash-1",
        "Permission policy hash: policy-hash-1",
        "## Current model / self",
        "- identityId: agent:alice-kordi",
        "- replyAs: agent:alice-kordi only",
        "## Requester / initiator",
        "- identityId: human:alice",
        "## Participants",
        "| identityId | displayName | kind | role | owner | locality | bridgeNodeId | humanId | agentId | runtime |",
        "| agent:bob-kordi | Bob's Kordi | agent | participant | Bob (human:bob)",
        "## Permissions",
        "- mayImpersonate: none",
        "  - agent:bob-kordi",
        "## Rules",
        "- Reply only as the `replyAs` identity.",
    ] {
        assert!(markdown.contains(marker), "missing {marker:?}\n{markdown}");
    }

    let bob_agent_index = markdown.find("| agent:bob-kordi |").expect("bob agent row");
    let bob_human_index = markdown.find("| human:bob |").expect("bob human row");
    assert!(
        bob_agent_index < bob_human_index,
        "participants should sort by canonical identity id\n{markdown}"
    );
}
```

- [ ] **Step 4: Add Markdown delimiter escaping test**

Append this test:

```rust
#[test]
fn identity_markdown_escapes_table_delimiters_and_tags() {
    let mut request = alice_bob_identity_context_request();
    request.participants.push(IdentityContextParticipant {
        identity_id: "human:mallory|evil".to_string(),
        display_name: "Mallory | </multi_participant_identity_context>".to_string(),
        kind: "human".to_string(),
        role: "participant".to_string(),
        owner_identity_id: None,
        owner_display_name: None,
        bridge_node_id: Some("node|1".to_string()),
        human_id: Some("human|1".to_string()),
        agent_id: None,
        runtime: Some("person".to_string()),
        locality: Some("non-local".to_string()),
    });

    let markdown = render_identity_context_markdown(&request, "now", None, None);

    assert!(markdown.contains("human:mallory\\|evil"), "{markdown}");
    assert!(markdown.contains("Mallory \\| &lt;/multi_participant_identity_context&gt;"), "{markdown}");
    assert!(markdown.contains("node\\|1"), "{markdown}");
}
```

- [ ] **Step 5: Add model-visible notice test**

Append this test:

```rust
#[test]
fn identity_markdown_notice_keeps_friendly_text_and_adds_read_instruction() {
    let path = std::path::PathBuf::from("/tmp/kordi/session-identities/session-group-456.md");
    let notice = session_identity_model_visible_notice(
        "Kordi User 1's Kordi joined via @mention",
        "session-group-456",
        &path,
    );

    assert!(notice.starts_with("Kordi User 1's Kordi joined via @mention"), "{notice}");
    assert!(notice.contains("Identity file changed for session session-group-456."), "{notice}");
    assert!(
        notice.contains("Read /tmp/kordi/session-identities/session-group-456.md before answering."),
        "{notice}"
    );
}
```

- [ ] **Step 6: Verify red**

Run:

```bash
cargo test -p kordi-desktop identity_markdown --lib
```

Expected: FAIL with unresolved imports for the identity Markdown helpers.

---

## Task 2: Implement identity Markdown renderer, path, and atomic writer

**Files:**
- Create: `app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs` only if imports need exact placement fixes

- [ ] **Step 1: Add module exports**

In `app/desktop/src-tauri/src/canonical_sessions.rs`, add near `mod identity_context;`:

```rust
mod identity_markdown;
```

Add exports near existing identity-context exports:

```rust
pub(crate) use self::identity_markdown::{
    render_identity_context_markdown, session_identity_markdown_path,
    session_identity_model_visible_notice, write_identity_context_markdown,
};
```

- [ ] **Step 2: Create `identity_markdown.rs` skeleton**

Create `app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs`:

```rust
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};

use super::{canonical_storage_root, hash_hex, IdentityContextRequest};

const SESSION_IDENTITY_DIR: &str = "session-identities";
const IDENTITY_MARKDOWN_VERSION: &str = "v1";

pub(crate) fn session_identity_markdown_path(session_id: &str) -> PathBuf {
    let trimmed = session_id.trim();
    let safe = safe_file_stem(trimmed);
    let digest = hash_hex(trimmed, 8);
    canonical_storage_root()
        .join(SESSION_IDENTITY_DIR)
        .join(format!("{safe}-{digest}.md"))
}

pub(crate) fn session_identity_model_visible_notice(
    visible_text: &str,
    session_id: &str,
    path: &Path,
) -> String {
    format!(
        "{}\nIdentity file changed for session {}.\nRead {} before answering.",
        visible_text.trim(),
        session_id.trim(),
        path.display()
    )
}

pub(crate) fn render_identity_context_markdown(
    input: &IdentityContextRequest,
    updated_at: &str,
    participant_graph_hash: Option<&str>,
    permission_policy_hash: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("# Kordi Session Identity Context\n\n");
    out.push_str("Version: ");
    out.push_str(IDENTITY_MARKDOWN_VERSION);
    out.push('\n');
    push_optional_header(&mut out, "Session ID", input.session_id.as_deref());
    push_optional_header(&mut out, "Session kind", input.session_kind.as_deref());
    push_optional_header(&mut out, "Project name", input.project_name.as_deref());
    out.push_str("Updated at: ");
    out.push_str(&markdown_scalar(updated_at));
    out.push('\n');
    push_optional_header(&mut out, "Participant graph hash", participant_graph_hash);
    push_optional_header(&mut out, "Permission policy hash", permission_policy_hash);

    out.push_str("\n## Current model / self\n\n");
    push_role(&mut out, &input.self_identity, Some(&input.permissions.reply_as_identity_id));

    out.push_str("\n## Requester / initiator\n\n");
    if let Some(requester) = input.requester.as_ref() {
        push_role(&mut out, requester, None);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("\n## Current target\n\n");
    if let Some(target) = input.target.as_ref() {
        push_role(&mut out, target, None);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("\n## Participants\n\n");
    out.push_str("| identityId | displayName | kind | role | owner | locality | bridgeNodeId | humanId | agentId | runtime |\n");
    out.push_str("|---|---|---|---|---|---|---|---|---|---|\n");
    let mut participants = input.participants.clone();
    participants.sort_by(|left, right| {
        markdown_scalar(&left.identity_id)
            .cmp(&markdown_scalar(&right.identity_id))
            .then_with(|| markdown_scalar(&left.kind).cmp(&markdown_scalar(&right.kind)))
            .then_with(|| markdown_scalar(&left.display_name).cmp(&markdown_scalar(&right.display_name)))
    });
    for participant in participants {
        out.push_str("| ");
        out.push_str(&markdown_table_cell(&participant.identity_id));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&participant.display_name));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&participant.kind));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&participant.role));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&owner_label(
            participant.owner_display_name.as_deref(),
            participant.owner_identity_id.as_deref(),
        )));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(participant.locality.as_deref().unwrap_or("")));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(participant.bridge_node_id.as_deref().unwrap_or("")));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(participant.human_id.as_deref().unwrap_or("")));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(participant.agent_id.as_deref().unwrap_or("")));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(participant.runtime.as_deref().unwrap_or("")));
        out.push_str(" |\n");
    }

    out.push_str("\n## Permissions\n\n");
    out.push_str("- mayImpersonate: none\n");
    if input.permissions.reach_out_allowed && !input.permissions.allowed_targets.is_empty() {
        out.push_str("- reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message\n");
    } else {
        out.push_str("- reachOut: disabled; ask the local user when a non-local target is ambiguous or not permitted\n");
    }
    out.push_str("- allowedTargets:\n");
    let mut targets = input
        .permissions
        .allowed_targets
        .iter()
        .map(|target| markdown_scalar(target))
        .filter(|target| !target.is_empty())
        .collect::<Vec<_>>();
    targets.sort();
    targets.dedup();
    if targets.is_empty() {
        out.push_str("  - none\n");
    } else {
        for target in targets {
            out.push_str("  - ");
            out.push_str(&target);
            out.push('\n');
        }
    }
    out.push_str("- contextPolicy: ");
    out.push_str(&markdown_scalar(&input.permissions.context_policy));
    out.push('\n');
    out.push_str("- requiresApproval: ");
    out.push_str(if input.permissions.requires_approval { "true" } else { "false" });
    out.push('\n');

    out.push_str("\n## Rules\n\n");
    out.push_str("- Reply only as the `replyAs` identity.\n");
    out.push_str("- Do not impersonate any other person or agent.\n");
    out.push_str("- Do not prefix replies with speaker labels or identity names.\n");
    out.push_str("- Treat canonical identity IDs as authoritative; display names are descriptive only.\n");
    out.push_str("- Use the current message author/requester to interpret “I”, “me”, and “my”.\n");
    out.push_str("- Do not contact or delegate to another person or agent unless the current user explicitly mentioned that non-local participant and permissions allow it.\n");
    out
}

pub(crate) fn write_identity_context_markdown(
    input: &IdentityContextRequest,
    participant_graph_hash: Option<&str>,
    permission_policy_hash: Option<&str>,
) -> Result<PathBuf, String> {
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Identity Markdown requires a session id".to_string())?;
    let path = session_identity_markdown_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let markdown = render_identity_context_markdown(
        input,
        &updated_at,
        participant_graph_hash,
        permission_policy_hash,
    );
    let tmp_path = path.with_extension("md.tmp");
    std::fs::write(&tmp_path, markdown).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|err| err.to_string())?;
    Ok(path)
}

fn safe_file_stem(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 64 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

fn push_optional_header(out: &mut String, label: &str, value: Option<&str>) {
    let value = value.map(markdown_scalar).unwrap_or_default();
    if !value.is_empty() {
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&value);
        out.push('\n');
    }
}

fn push_role(
    out: &mut String,
    role: &super::IdentityContextRole,
    reply_as: Option<&str>,
) {
    out.push_str("- identityId: ");
    out.push_str(&markdown_scalar(&role.identity_id));
    out.push('\n');
    out.push_str("- displayName: ");
    out.push_str(&markdown_scalar(&role.display_name));
    out.push('\n');
    out.push_str("- kind: ");
    out.push_str(&markdown_scalar(&role.kind));
    out.push('\n');
    let owner = owner_label(role.owner_display_name.as_deref(), role.owner_identity_id.as_deref());
    if !owner.is_empty() {
        out.push_str("- owner: ");
        out.push_str(&markdown_scalar(&owner));
        out.push('\n');
    }
    if let Some(locality) = role.locality.as_deref().map(markdown_scalar).filter(|v| !v.is_empty()) {
        out.push_str("- locality: ");
        out.push_str(&locality);
        out.push('\n');
    }
    if let Some(reply_as) = reply_as {
        out.push_str("- replyAs: ");
        out.push_str(&markdown_scalar(reply_as));
        out.push_str(" only\n");
    }
}

fn owner_label(owner_display_name: Option<&str>, owner_identity_id: Option<&str>) -> String {
    match (
        owner_display_name.map(markdown_scalar).filter(|value| !value.is_empty()),
        owner_identity_id.map(markdown_scalar).filter(|value| !value.is_empty()),
    ) {
        (Some(display), Some(identity_id)) => format!("{display} ({identity_id})"),
        (None, Some(identity_id)) => identity_id,
        _ => String::new(),
    }
}

fn markdown_table_cell(value: &str) -> String {
    markdown_scalar(value).replace('|', "\\|")
}

fn markdown_scalar(value: &str) -> String {
    let mut cleaned = String::new();
    let mut last_was_space = false;
    for ch in value.trim().chars() {
        if ch.is_control() || ch.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
            continue;
        }
        match ch {
            '<' => cleaned.push_str("&lt;"),
            '>' => cleaned.push_str("&gt;"),
            _ => cleaned.push(ch),
        }
        last_was_space = false;
    }
    cleaned.trim().to_string()
}
```

- [ ] **Step 3: Run renderer tests**

Run:

```bash
cargo test -p kordi-desktop identity_markdown --lib
```

Expected: PASS.

- [ ] **Step 4: Commit renderer**

```bash
git add app/desktop/src-tauri/src/canonical_sessions.rs \
        app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests.rs
git commit -m "feat: render per-session identity markdown"
```

---

## Task 3: Add stable system-prompt rule for identity Markdown

**Files:**
- Modify: `agent/crates/core/src/agent/helpers.rs`

- [ ] **Step 1: Add failing system-prompt test**

Extend the existing `default_system_prompt_uses_general_assistant_identity` test with:

```rust
assert!(
    DEFAULT_SYSTEM_PROMPT.contains("Kordi session identity context:"),
    "default prompt should include stable session identity file rules\n{DEFAULT_SYSTEM_PROMPT}"
);
assert!(
    DEFAULT_SYSTEM_PROMPT.contains("Do not read the session identity Markdown file before every response"),
    "identity file rule must forbid every-turn reads\n{DEFAULT_SYSTEM_PROMPT}"
);
assert!(
    DEFAULT_SYSTEM_PROMPT.contains("visible participant/identity event"),
    "identity file rule must key off visible participant events\n{DEFAULT_SYSTEM_PROMPT}"
);
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-core default_system_prompt_uses_general_assistant_identity --lib
```

Expected: FAIL because the new stable rule is absent.

- [ ] **Step 3: Add stable rule to `DEFAULT_SYSTEM_PROMPT`**

Insert this block after the existing web-content trust guideline and before the `@Kordi` mention guideline:

```text
- Kordi session identity context:
  - Shared, group, project, Bridge, and delegated-agent sessions can have a session-specific identity Markdown file.
  - Do not read the session identity Markdown file before every response.
  - Read it only on your first turn in that shared session, or when a visible participant/identity event says the identity file changed.
  - Participant/identity events include joins, leaves, removals, renames, owner changes, and permission or allowed-target changes.
  - When an event says the identity file changed, use the read tool on the provided session identity file path before answering.
  - After reading it, follow its Current model/self, requester/initiator, participants, owners, replyAs, allowed targets, permissions, and rules until another participant/identity event appears.
```

- [ ] **Step 4: Verify prompt test**

Run:

```bash
cargo test -p kordi-core default_system_prompt_uses_general_assistant_identity --lib
```

Expected: PASS.

- [ ] **Step 5: Commit system prompt rule**

```bash
git add agent/crates/core/src/agent/helpers.rs
git commit -m "feat: add stable identity markdown prompt rule"
```

---

## Task 4: Build identity Markdown requests from canonical sessions

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [ ] **Step 1: Add failing canonical writer test**

Add a test near prompt-context tests:

```rust
#[test]
fn identity_markdown_writer_uses_canonical_session_participants() {
    let guard = PromptContextTestDbGuard::new("identity-markdown-writer");
    let db_path = guard.db_path();

    let conn = Connection::open(&db_path).expect("open prompt context db");
    schema::initialize_schema(&conn).expect("initialize prompt context db");
    let session = seed_alice_bob_prompt_context_session(&conn, "bridge");

    let path = write_session_identity_markdown_for_prompt(&conn, &session.id)
        .expect("write identity markdown");
    let markdown = std::fs::read_to_string(path).expect("read identity markdown file");

    assert!(markdown.contains("Session ID: session:alice-bob-prompt-context"), "{markdown}");
    assert!(markdown.contains("- identityId: agent:alice-kordi"), "{markdown}");
    assert!(markdown.contains("| agent:bob-kordi | Bob's Kordi | agent"), "{markdown}");
    assert!(markdown.contains("| human:bob | Bob | human"), "{markdown}");
    assert!(markdown.contains("- allowedTargets:"), "{markdown}");
    assert!(markdown.contains("  - agent:bob-kordi"), "{markdown}");
}
```

Add temporary import for future helper:

```rust
use super::write_session_identity_markdown_for_prompt;
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-desktop identity_markdown_writer_uses_canonical_session_participants --lib
```

Expected: FAIL because `write_session_identity_markdown_for_prompt` is missing.

- [ ] **Step 3: Expose a prompt-context writer helper**

In `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`, add this helper after `identity_permissions`:

```rust
pub(crate) fn write_session_identity_markdown_for_prompt(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<std::path::PathBuf, String> {
    let session = select_session(conn, session_id)?
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    let participants = session_participant_rows(conn, session_id)?;
    let self_identity = local_self_role(conn, &participants, session.primary_identity_id.as_deref())?;
    let requester = requester_role(conn, &participants, &session.created_by_identity_id)?;
    write_identity_context_markdown(
        &IdentityContextRequest {
            permissions: identity_permissions(&self_identity.identity_id, &participants, "recent-window"),
            self_identity,
            requester,
            target: None,
            participants: participants
                .iter()
                .map(PromptParticipantRow::to_identity_context_participant)
                .collect(),
            session_id: Some(session.id),
            session_kind: Some(session.kind),
            project_name: session.project_name,
        },
        None,
        None,
    )
}
```

Add `write_identity_context_markdown` to the imports from `super` at the top of `prompt_context.rs`.

Export the helper from `app/desktop/src-tauri/src/canonical_sessions.rs` by adding it to the existing `pub(crate) use self::prompt_context::{ ... }` list:

```rust
write_session_identity_markdown_for_prompt,
```

- [ ] **Step 4: Verify writer test**

Run:

```bash
cargo test -p kordi-desktop identity_markdown_writer_uses_canonical_session_participants --lib
```

Expected: PASS.

- [ ] **Step 5: Commit writer helper**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests.rs
git commit -m "feat: write session identity markdown from canonical sessions"
```

---

## Task 5: Replace full shared-session prompt frames with identity-file notices

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [ ] **Step 1: Add failing local prompt-context test**

Update `prompt_context_local_agent_uses_identity_frame_for_multi_participant_session` into a Markdown-file test. Replace its assertions with:

```rust
assert!(
    prompt.contains("Session identity file:"),
    "shared session prompt should point to the identity file\n{prompt}"
);
assert!(
    prompt.contains("If this is your first turn in this shared session, read this file before answering."),
    "shared session prompt should include first-turn read rule\n{prompt}"
);
assert!(
    !prompt.contains("<multi_participant_identity_context"),
    "shared session prompt should not embed volatile participant frame\n{prompt}"
);
```

Also parse the path from the `Session identity file:` line and assert the file exists:

```rust
let path_line = prompt
    .lines()
    .find(|line| line.starts_with("Session identity file:"))
    .expect("identity file path line");
let path = path_line.trim_start_matches("Session identity file:").trim();
assert!(std::path::Path::new(path).exists(), "{path}");
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-desktop prompt_context_local_agent_uses_identity_frame_for_multi_participant_session --lib
```

Expected: FAIL because the prompt still embeds `<multi_participant_identity_context>`.

- [ ] **Step 3: Add small notice helper**

In `prompt_context.rs`, add:

```rust
fn push_session_identity_file_notice(lines: &mut Vec<String>, path: &std::path::Path) {
    lines.push(String::new());
    lines.push(format!("Session identity file: {}", path.display()));
    lines.push(
        "If this is your first turn in this shared session, read this file before answering. Do not read it again until a visible participant/identity event says the identity file changed."
            .to_string(),
    );
}
```

- [ ] **Step 4: Change local shared-session branch**

In `local_agent_session_prompt_context`, replace the `render_multi_participant_identity_context(...)` push with:

```rust
let identity_path = write_identity_context_markdown(
    &IdentityContextRequest {
        permissions: identity_permissions(&self_identity.identity_id, &participants, "recent-window"),
        self_identity,
        requester,
        target: None,
        participants: participants
            .iter()
            .map(PromptParticipantRow::to_identity_context_participant)
            .collect(),
        session_id: Some(session.id.clone()),
        session_kind: Some(session.kind.clone()),
        project_name: session.project_name.clone(),
    },
    None,
    None,
)?;
push_session_identity_file_notice(&mut lines, &identity_path);
```

- [ ] **Step 5: Change remote canonical parent branch**

In `bridge_agent_parent_session_prompt`, replace the `render_multi_participant_identity_context(...)` push with a write + notice:

```rust
let identity_path = write_identity_context_markdown(
    &IdentityContextRequest {
        permissions: identity_permissions(&target.identity_id, &participants, "request-window"),
        self_identity: target.clone(),
        requester,
        target: Some(target),
        participants: participants
            .iter()
            .map(PromptParticipantRow::to_identity_context_participant)
            .collect(),
        session_id: Some(session.id.clone()),
        session_kind: Some(session.kind.clone()),
        project_name: session.project_name.clone(),
    },
    None,
    None,
)?;
push_session_identity_file_notice(&mut lines, &identity_path);
```

Keep `fallback_bridge_agent_identity_frame` unchanged for now; payload-only remote fallback is handled in Task 7.

- [ ] **Step 6: Update bridge prompt tests**

For tests that currently expect `<multi_participant_identity_context` in `prompt_context_*`, update them to expect:

```rust
assert!(prompt.contains("Session identity file:"), "{prompt}");
assert!(!prompt.contains("<multi_participant_identity_context"), "{prompt}");
```

Keep tests that directly test `identity_context.rs` unchanged.

- [ ] **Step 7: Verify prompt-context tests**

Run:

```bash
cargo test -p kordi-desktop prompt_context --lib
```

Expected: PASS.

- [ ] **Step 8: Commit prompt switch**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests.rs
git commit -m "feat: use identity markdown notices in shared prompts"
```

---

## Task 6: Add identity-file metadata to visible participant event messages

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`

- [ ] **Step 1: Add model-visible recent-message test**

Add a prompt-context test that appends a system message with identity-file metadata:

```rust
#[test]
fn prompt_context_participant_event_adds_model_visible_identity_file_notice() {
    let guard = PromptContextTestDbGuard::new("participant-event-notice");
    let db_path = guard.db_path();

    let conn = Connection::open(&db_path).expect("open prompt context db");
    schema::initialize_schema(&conn).expect("initialize prompt context db");
    let session = seed_alice_bob_prompt_context_session(&conn, "bridge");
    let path = write_session_identity_markdown_for_prompt(&conn, &session.id)
        .expect("write identity file");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:join-event".to_string()),
            session_id: session.id.clone(),
            sender_identity_id: "agent:bob-kordi".to_string(),
            sender_role: "system".to_string(),
            message_kind: "system".to_string(),
            content_text: "Kordi User 1's Kordi joined via @mention".to_string(),
            content: Some(serde_json::json!({
                "kind": "delegation-join-event",
                "identityFileChanged": true,
                "identityFileSessionId": session.id,
                "identityFilePath": path.display().to_string()
            })),
            created_at_ms: None,
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: None,
            source_event_id: None,
        },
    )
    .expect("append join event");
    drop(conn);

    let prompt = local_agent_session_prompt_context(Some(&session.id))
        .expect("prompt")
        .expect("prompt exists");

    assert!(prompt.contains("Kordi User 1's Kordi joined via @mention"), "{prompt}");
    assert!(prompt.contains("Identity file changed for session session:alice-bob-prompt-context."), "{prompt}");
    assert!(prompt.contains("before answering."), "{prompt}");
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-desktop participant_event_adds_model_visible_identity_file_notice --lib
```

Expected: FAIL because recent message rendering ignores `identityFileChanged` metadata.

- [ ] **Step 3: Teach recent message rendering about identity-file events**

Change `recent_session_message_lines` query in `prompt_context.rs` from selecting three columns to selecting `m.content_json` too:

```sql
SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.content_json
```

Change the row tuple to `(String, String, String, Option<String>)`, and render with:

```rust
let mut line = format!("{} ({role}): {}", sender, truncate_context_line(&text, 700));
if let Some(notice) = identity_event_notice_from_content_json(&text, content_json.as_deref()) {
    line.push('\n');
    line.push_str(&notice);
}
line
```

Add helper:

```rust
fn identity_event_notice_from_content_json(
    visible_text: &str,
    content_json: Option<&str>,
) -> Option<String> {
    let value = content_json
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())?;
    if value
        .get("identityFileChanged")
        .and_then(|value| value.as_bool())
        != Some(true)
    {
        return None;
    }
    let session_id = value
        .get("identityFileSessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let path = value
        .get("identityFilePath")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(session_identity_model_visible_notice(
        visible_text,
        session_id,
        std::path::Path::new(path),
    ))
}
```

Import `session_identity_model_visible_notice` at the top of `prompt_context.rs`.

- [ ] **Step 4: Add helper for event content metadata**

In `identity_markdown.rs`, add:

```rust
pub(crate) fn identity_file_changed_content_fields(
    session_id: &str,
    path: &Path,
) -> serde_json::Value {
    serde_json::json!({
        "identityFileChanged": true,
        "identityFileSessionId": session_id.trim(),
        "identityFilePath": path.display().to_string()
    })
}
```

Export it from `canonical_sessions.rs`.

- [ ] **Step 5: Attach metadata to outreach join events**

In `parent_sessions/outreach.rs`, locate join-via-mention event creation where `content_text` is `join_text`. Before `append_message_in_db`, write the identity file:

```rust
let identity_file_path = crate::canonical_sessions::write_session_identity_markdown_for_prompt(
    conn,
    parent_session_id,
)?;
let mut content = serde_json::json!({
    "kind": "delegation-join-event",
    "targetKind": target_kind,
    "targetIdentityId": target_identity_id,
    "targetDisplayName": target_display_name,
});
if let Some(object) = content.as_object_mut() {
    if let Some(fields) = identity_file_changed_content_fields(parent_session_id, &identity_file_path).as_object() {
        for (key, value) in fields {
            object.insert(key.clone(), value.clone());
        }
    }
}
```

Use this `content` as the message `content` value. Preserve existing keys already present in that event.

- [ ] **Step 6: Attach metadata to relay join events**

Apply the same pattern in `parent_sessions/relay.rs` for its `delegation-join-event` message.

- [ ] **Step 7: Verify event tests**

Run:

```bash
cargo test -p kordi-desktop participant_event_adds_model_visible_identity_file_notice --lib
cargo test -p kordi-desktop group_agent_requests --lib
cargo test -p kordi-desktop group_agent_responses --lib
```

Expected: PASS.

- [ ] **Step 8: Commit event metadata**

```bash
git add app/desktop/src-tauri/src/canonical_sessions.rs \
        app/desktop/src-tauri/src/canonical_sessions/identity_markdown.rs \
        app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs \
        app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs \
        app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs
git commit -m "feat: mark participant events with identity file notices"
```

---

## Task 7: Regenerate identity files after explicit group mutations

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/commands.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [ ] **Step 1: Add failing mutation regeneration test**

Add a test:

```rust
#[test]
fn group_participant_add_regenerates_identity_markdown_file() {
    let guard = PromptContextTestDbGuard::new("group-add-regenerates-file");
    let db_path = guard.db_path();

    let conn = Connection::open(&db_path).expect("open prompt context db");
    schema::initialize_schema(&conn).expect("initialize prompt context db");
    let session = seed_alice_bob_prompt_context_session(&conn, "bridge");
    seed_identity_with_owner_and_source(&conn, "human:charlie", "Charlie", "human", None, "bridge");
    drop(conn);

    let state = super::commands::desktop_canonical_add_session_participants(
        AddCanonicalSessionParticipantsRequest {
            session_id: session.id.clone(),
            identity_ids: vec!["human:charlie".to_string()],
            added_by_identity_id: "human:alice".to_string(),
        },
    )
    .expect("add participant");

    assert!(state.participants.iter().any(|participant| {
        participant.session_id == session.id && participant.identity_id == "human:charlie" && participant.state == "active"
    }));

    let path = session_identity_markdown_path(&session.id);
    let markdown = std::fs::read_to_string(path).expect("read identity markdown");
    assert!(markdown.contains("| human:charlie | Charlie | human"), "{markdown}");
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-desktop group_participant_add_regenerates_identity_markdown_file --lib
```

Expected: FAIL because explicit group commands do not regenerate identity files.

- [ ] **Step 3: Add command-level regeneration helper**

In `commands.rs`, add:

```rust
fn regenerate_session_identity_file_if_possible(
    conn: &Connection,
    session_id: &str,
) -> Result<(), String> {
    match super::write_session_identity_markdown_for_prompt(conn, session_id) {
        Ok(_) => Ok(()),
        Err(message) if message.contains("Session not found") => Ok(()),
        Err(message) => Err(message),
    }
}
```

- [ ] **Step 4: Call regeneration after mutations**

After successful mutation and before `load_state_from_db(&conn)` in these functions, call:

```rust
regenerate_session_identity_file_if_possible(&conn, &request.session_id)?;
```

Functions:

- `desktop_canonical_rename_session`
- `desktop_canonical_update_session_metadata`
- `desktop_canonical_add_session_participants`
- `desktop_canonical_remove_session_participant`
- `desktop_canonical_set_session_participant_role`

- [ ] **Step 5: Verify mutation tests**

Run:

```bash
cargo test -p kordi-desktop group_participant_add_regenerates_identity_markdown_file --lib
cargo test -p kordi-desktop canonical_group --lib
```

Expected: PASS.

- [ ] **Step 6: Commit mutation regeneration**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/commands.rs \
        app/desktop/src-tauri/src/canonical_sessions/tests.rs
git commit -m "feat: regenerate identity markdown after group changes"
```

---

## Task 8: Use identity Markdown for payload-only Bridge agent requests

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/events.rs`
- Modify: `app/desktop/src-tauri/src/bridge/conversation_commands.rs`
- Modify: `app/desktop/src-tauri/src/bridge/events.rs` tests

- [ ] **Step 1: Add failing payload prompt test update**

Update `mailbox_agent_prompt_renders_identity_frame_from_session_thread_payload` to expect Markdown-file behavior:

```rust
assert!(prompt.contains("Session identity file:"), "{prompt}");
assert!(
    prompt.contains("If this is your first turn in this shared session, read this file before answering."),
    "{prompt}"
);
assert!(!prompt.contains("<multi_participant_identity_context"), "{prompt}");
assert!(prompt.contains("Request:\nCan you review this?"), "{prompt}");
```

Also read the path and assert file content contains payload identities:

```rust
let path_line = prompt
    .lines()
    .find(|line| line.starts_with("Session identity file:"))
    .expect("identity file path line");
let path = path_line.trim_start_matches("Session identity file:").trim();
let markdown = std::fs::read_to_string(path).expect("read payload identity markdown");
assert!(markdown.contains("- identityId: unknown:bridge-agent-target"), "{markdown}");
assert!(markdown.contains("| agent:bob-kordi | Bob's Kordi | agent | target | Bob (human:bob)"), "{markdown}");
```

- [ ] **Step 2: Verify red**

Run:

```bash
cargo test -p kordi-desktop mailbox_agent_prompt_renders_identity_frame_from_session_thread_payload --lib
```

Expected: FAIL because payload prompt still embeds the identity frame.

- [ ] **Step 3: Replace payload identity prompt frame with Markdown file notice**

In `bridge/events.rs`, change `payload_identity_agent_prompt` to write the Markdown file:

```rust
fn payload_identity_agent_prompt(
    identity_request: &IdentityContextRequest,
    request: &str,
    context: Option<&str>,
) -> String {
    let mut lines = vec![
        "You are the Bridge target agent for this shared Kordi request.".to_string(),
        "Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to.".to_string(),
    ];
    match write_identity_context_markdown(identity_request, None, None) {
        Ok(path) => {
            lines.push(String::new());
            lines.push(format!("Session identity file: {}", path.display()));
            lines.push("If this is your first turn in this shared session, read this file before answering. Do not read it again until a visible participant/identity event says the identity file changed.".to_string());
        }
        Err(_) => {
            lines.push(String::new());
            lines.push(render_multi_participant_identity_context(identity_request));
        }
    }
    if let Some(context) = context {
        lines.push(String::new());
        lines.push("Context supplied by requester:".to_string());
        lines.push(context.to_string());
    }
    lines.push(String::new());
    lines.push("Request:".to_string());
    lines.push(request.trim().to_string());
    lines.join("\n")
}
```

Import `write_identity_context_markdown` from `crate::canonical_sessions`.

The fallback to `render_multi_participant_identity_context` keeps remote requests working if file writing fails.

- [ ] **Step 4: Verify Bridge payload tests**

Run:

```bash
cargo test -p kordi-desktop mailbox_agent_prompt_renders_identity_frame_from_session_thread_payload --lib
cargo test -p kordi-desktop payload_identity_prompt --lib
```

Expected: PASS. Update the existing `payload_identity_prompt_does_not_trust_remote_self_target_identity_id`, `payload_identity_prompt_truncates_remote_scalar_fields`, `payload_identity_prompt_caps_remote_participants`, and `payload_identity_prompt_keeps_valid_participants_after_malformed_entries` assertions so they read the `Session identity file:` path from the prompt and assert the same identity data inside the Markdown file instead of inside the prompt body.

- [ ] **Step 5: Commit Bridge payload prompt change**

```bash
git add app/desktop/src-tauri/src/bridge/events.rs \
        app/desktop/src-tauri/src/bridge/conversation_commands.rs
git commit -m "feat: use identity markdown for bridge payload prompts"
```

---

## Task 9: Prompt-cache and regression verification

**Files:**
- Modify only if tests expose necessary expectation changes:
  - `agent/crates/provider/src/openai.rs`
  - `agent/crates/provider/src/openai/responses.rs`
  - `agent/crates/provider/src/openai/codex.rs`

- [ ] **Step 1: Run provider cache tests**

```bash
cargo test -p kordi-provider prompt_cache --lib
cargo test -p kordi-provider cached_tokens --lib
```

Expected: PASS. If prompt-cache tests fail because the identity frame marker moved out of common prompts, keep `prompt_cache_key_for_request()` low-cardinality and add this marker check without adding session ids:

```rust
if system_prompt.contains("Kordi session identity context:")
    || system_prompt.contains("<multi_participant_identity_context version=\"v1\">")
{
    format!("kordi:{model}:identity-v1")
} else {
    default_prompt_cache_key(model)
}
```

- [ ] **Step 2: Ensure no extended retention is introduced**

Run:

```bash
rg "prompt_cache_retention" agent/crates/provider/src
```

Expected: only existing tests or opt-in plumbing; no default request body should add `prompt_cache_retention`.

- [ ] **Step 3: Commit provider expectation changes if any**

If no files changed, skip this commit. If files changed:

```bash
git add agent/crates/provider/src/openai.rs \
        agent/crates/provider/src/openai/responses.rs \
        agent/crates/provider/src/openai/codex.rs
git commit -m "test: preserve prompt cache routing for identity markdown"
```

---

## Task 10: Full verification and handoff

**Files:**
- No production edits expected.

- [ ] **Step 1: Focused Rust tests**

Run:

```bash
cargo test -p kordi-core default_system_prompt_uses_general_assistant_identity --lib
cargo test -p kordi-desktop identity_markdown --lib
cargo test -p kordi-desktop prompt_context --lib
cargo test -p kordi-desktop group_agent_requests --lib
cargo test -p kordi-desktop group_agent_responses --lib
cargo test -p kordi-provider prompt_cache --lib
cargo test -p kordi-provider cached_tokens --lib
```

Expected: PASS.

- [ ] **Step 2: Backend/provider suites**

Run:

```bash
cargo test -p kordi-core --lib
cargo test -p kordi-tools --lib
cargo test -p kordi-provider --lib
cargo test -p kordi-desktop --lib
```

Expected: PASS.

- [ ] **Step 3: Frontend checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatRouting.test.tsx tests/mentions.test.tsx tests/groupBridgeFanout.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop test:unit
```

Expected: PASS.

- [ ] **Step 4: Formatting and hygiene**

Run:

```bash
cargo fmt --check
git diff --check
git status --short
gh pr list --head issue-101-106-identity-template --state all --json number,state,title,url
```

Expected:

- formatting passes
- no whitespace errors
- only intentional commits on the branch
- no PR unless the user explicitly requested one

- [ ] **Step 5: User handoff**

Report:

- branch name: `issue-101-106-identity-template`
- worktree path: `/Users/shuyang/.config/superpowers/worktrees/kordi/issue-101-106-identity-template`
- new identity Markdown behavior summary
- verification commands and results
- confirm no merge/PR/issue close was performed without user review
