# Issue #317 — Phase 1: backend fork command

Tracks the backend, desktop-runtime, and Tauri-command pieces of the
"message fork" feature laid out in
https://github.com/Kordi-AI/kordi/issues/317. The plan is intentionally
narrow: front-end work, the right-panel forks list, and the
`session_search` tool live in later phases (#317 Phases 2–5).

## Goals

- Make `kordi_session::store::fork_session_from_entry` produce sessions
  that durably remember **both** the source session id and the source
  entry id (the user message the fork was anchored to).
- Expose a Tauri command (`desktop_chat_fork_session_from_message`) that
  the desktop UI can call once Phase 2 lands a `Fork` button.
- Surface the fork lineage in canonical session metadata so the right
  detail panel and cross-session search (Phases 3–4) can resolve forks
  without a schema rewrite.

## Non-goals

- No UI: no right-click context menu, no right-panel forks list, no
  composer prefill plumbing.
- No `session_search` tool.
- No `Forward` sibling action (Forward is a separate feature that lives
  on the same right-click surface as `Fork`; backend is out of scope
  for Phase 1).
- No tree visualization CLI command — explicitly deprioritized; revisit
  after the desktop fork flow ships.
- No automatic merge-back, participant propagation, or hidden boundary
  system message (those land in Phase 5).
- No support for forking bridge sessions, group sessions, or sessions
  with a running turn (rejected with a clear error for v1).

## UX direction (informs Phase 2)

- The trigger is a **right-click context menu** on a transcript
  message, not an inline button under the message. The context menu
  hosts both `Fork` and `Forward` (the forward backend ships
  separately).
- Forks contain "previous messages but not following messages" relative
  to the clicked entry. The clicked user message is the boundary — its
  content is returned as `selected_text` so Phase 2 can offer it as
  composer prefill or discard it. Anything after the clicked message in
  the source session is left out.

## Storage shape

`sessions` already has `parent_session_id` (from MIGRATION_V2). Add
MIGRATION_V9 to introduce `parent_session_message_id TEXT` on the same
table. Reasons:

- A single column avoids a `session_forks` table, matching the issue's
  "metadata first, normalize later" guidance.
- Pairing it with `parent_session_id` lets canonical sync rebuild the
  `fork` metadata sub-object on every sync without consulting any other
  source.
- Phase 3's right-panel needs both fields to render
  `forked from <session>::<message>` previews.

`SessionRow` and `create_session_with_parent` grow a parallel optional
parameter so the fork helper can write both fields atomically.

## Backend API

```rust
pub struct ForkSessionResult {
    pub session_id: String,
    pub selected_text: String,
    pub branch_leaf_id: Option<String>,
    pub source_session_id: String,
    pub source_entry_id: String,
}

pub fn fork_session_from_entry(
    conn: &Connection,
    source_session_id: &str,
    entry_id: &str,
    cwd: &str,
) -> Result<ForkSessionResult>;
```

Behavior:

- The selected entry must be a user message; assistant/tool entries
  return an error (`"Invalid entry ID for forking"`). Existing rule.
- `create_session_with_parent` writes `parent_session_id` and
  `parent_session_message_id` together.
- The selected user message is **not** copied. Only its ancestors land
  in the new session, so the user can resend their message or write a
  new one.
- The new session ends with its leaf pointing at the selected message's
  parent (or `None` for a root user message — the new session is
  empty).

## Desktop runtime

Add a free function in `desktop_runtime`:

```rust
pub fn fork_session_from_message(
    source_session_id: &str,
    source_entry_id: &str,
) -> Result<ForkOutcome>;

pub struct ForkOutcome {
    pub session_id: String,
    pub source_session_id: String,
    pub source_entry_id: String,
    pub selected_text: String,
}
```

Implementation:

- Open the global sessions DB (same helper used by `hide_session`,
  `move_session_to_project`).
- Validate the source session exists locally and `session_scope ==
  "chat"` (no bridge/project forks in v1).
- Reuse the source session's `cwd` for the new session.
- Delegate to `kordi_session::store::fork_session_from_entry`.

The Phase 2 frontend will call this through a new Tauri command and
then immediately resume the new session via
`DesktopRuntimeSession::resume(...)`. Keeping the helper as a free
function (not a method on `DesktopRuntimeSession`) matches the existing
`session_exists`/`hide_session`/`move_session_to_project` shape and
avoids fighting borrow rules on the source runtime.

## Tauri command

```rust
#[tauri::command]
pub async fn desktop_chat_fork_session_from_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    message_entry_id: String,
) -> Result<DesktopChatState, String>;
```

Steps:

1. Resolve `cwd` and ensure the source session is loaded into the
   manager (so we can detect a running turn and reuse the runtime).
2. Reject if `session_has_running_turn(&manager, &session_id)` — the
   user has to stop the turn first. Phase 5 may revisit this with a
   coherent snapshot.
3. Call `kordi_cli::desktop_runtime::fork_session_from_message(...)`.
4. Build a `DesktopRuntimeSession::resume(...)` for the new session and
   insert it into `manager.sessions` keyed by the new session id.
5. Build and return a `DesktopChatState` with the new session as
   `active_session_id`.
6. Register the command in `app/desktop/src-tauri/src/lib.rs` next to
   the other `desktop_chat_*` commands.

`message_entry_id` is the desktop-side entry id (already stable today
because the canonical sync emits message ids derived from the local
session store). The frontend will pass it down from the transcript row
in Phase 2.

## Canonical sync

`sync_desktop_chat_state` already calls `open_or_create_session_in_db`
for each visible session. Augment its metadata with a fork sub-object
when the local `SessionRow` carries fork fields:

```json
{
  "fork": {
    "forkedFromSessionId": "<source>",
    "forkedFromMessageId": "<entry>",
    "forkMode": "private-local",
    "contextPolicy": "prefix-through-message",
    "boundary": "inherited-history-reference-only"
  }
}
```

Notes:

- The metadata column is fully overwritten on each sync, so emitting
  the sub-object every time is required (re-derive from
  `kordi_session::store::get_session(...)`).
- Source-session metadata is unchanged; Phase 3 will discover children
  by querying canonical sessions whose `metadata.fork.forkedFromSessionId`
  equals the active session id (or by reading `parent_session_id` from
  local store directly).

## Tests

Backend (`agent/crates/session/src/store/tests.rs` and
`agent/crates/session/src/store/fork_tests.rs` if the file gets large):

- `fork_records_source_session_and_message_id_columns` — new fork has
  both `parent_session_id` and `parent_session_message_id` set.
- `fork_from_root_user_message_creates_empty_branch` — fork from the
  root user entry yields an empty new session whose leaf is `None`.
- `fork_from_assistant_entry_returns_error` — assistant entry rejected.
- `fork_from_unknown_entry_returns_error` — preserves current error
  surface.
- `fork_does_not_mutate_source_session` — source session entry list,
  leaf id, and timestamps are unchanged after fork creation.

Tauri (`app/desktop/src-tauri/src/chat/tests.rs`):

- Sync emits `fork` metadata sub-object for forked sessions.
- Sync omits the sub-object for non-forked sessions.

## Open questions deferred to later phases

- Phase 2: composer prefill semantics — should the fork open with the
  selected user text already in the composer, or only on explicit user
  request? Current backend returns `selected_text` so either works.
- Phase 3: do we expose forks through the existing `participants`
  surface or a separate panel-only endpoint? The fork lineage in
  canonical metadata supports both.
- Phase 5: hidden boundary system message wording, and whether to also
  attach a `CustomMessage` entry at fork creation time so the frontend
  can render a chip without consulting metadata.

## Phase 2 follow-up (landed on this branch)

Phase 2 wires the desktop UI into the Phase 1 surface. Notable choices:

- `DesktopChatMessage` now carries an optional `entry_id` string so the
  frontend has the stable id needed to call
  `desktop_chat_fork_session_from_message`. Today only user messages
  set it; assistant turns aggregate multiple entries and intentionally
  leave `entry_id` empty so the right-click menu hides Fork on them.
- `DesktopChatSessionSummary` and `DesktopChatSessionDetail` gained
  `forkedFromSessionId` / `forkedFromMessageId` so summaries and
  details ferry the same lineage already in canonical metadata. Phase
  3 (right panel) consumes them directly.
- Right-click on a transcript message opens a small `MessageContextMenu`
  overlay (mirrors the existing `SessionContextMenu` look). It hosts
  `Fork from here` only — `Forward` will land alongside its own backend.
- `ChatsPage` rejects fork triggers for drafts and bridge sessions
  before showing the menu; the Tauri command also enforces these
  invariants and rejects when a turn is running.
- On success the page sets the new fork as the active session and
  refreshes chat state from the command's returned `DesktopChatState`.
