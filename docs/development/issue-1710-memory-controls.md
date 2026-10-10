# Issue 1710: Memory and runtime state controls

Status: proposal, 2026-10-07. Tracks [#1710](https://github.com/Kordi-Lab/Kordi/issues/1710).

## Summary

Kordi has two memory layers and no way for a person to review, edit, delete,
or switch off either of them. This plan adds one Memory section to the desktop
account settings and a matching iPhone screen, moves memories to the signed-in
account so every device and every cloud run reads the same memories, enforces
the memory switch and the sensitive-content rule in the harness on the Mac and
in the cloud runner, and gives the account a route that clears its server-side
replay state. The desktop settings surface ships first behind a preview flag
so the product shape can be reviewed before the storage and runtime changes
land.

| PR | Scope | Depends on |
|---|---|---|
| 0 | Desktop Memory settings tab with an in-memory preview client (this branch) | nothing |
| 1 | Server: `cloud_account_memories` store, memory routes, memory settings, `memoryVersion` capability flag, opt-out and sensitive guards, audit, database-backed tests | nothing |
| 2 | Mac runtime: write-through to the account, local cache refresh, signed-out queue, one-time upload of existing memory files | 1 |
| 3 | Harness enforcement on the Mac and in the cloud runner: memory switch, tool removal, prompt section, runner tool policy change | 1, 2 |
| 4 | Desktop real client replacing the preview client, plus the iPhone Memory screen | 1, 2 |
| 5 | Replay state route and deletion register entries for memories and replay state | 1, #1685 for the register |
| 6 | Documentation: memory layers, where they live, what each control deletes; Privacy page link once #1682 lands | 1 to 5 |

## Current state, verified on `main`

- `reflection_lessons` (session schema v5, `agent/crates/session/src/schema.rs`)
  stores `lesson_id`, scope, `scope_id`, `artifact_path`, source, timestamps,
  and `archived_at`. The memory text lives only in
  `reflection-lessons/<scope>/<scope-id>.md` as `- <timestamp> [<source>] <text>`
  lines (`agent/crates/cli/src/reflection_runtime.rs`). Row and line are not
  linked by id.
- All of this is local to one Mac. Nothing in `reflection_lessons` or the
  `reflection-lessons/` files reaches the server, other devices, or cloud runs.
- `archive_reflection_lesson` exists in
  `agent/crates/session/src/reflection_lessons.rs` with no caller outside its
  tests. Archiving a row would not change the file the agent reads.
- `session_bootstrap.rs` builds `ToolContext` with `reflection: Some(...)` and
  appends the "Scoped lesson artifacts" prompt section whenever the `reflection`
  tool is in the active set. `run.rs` does the same for the CLI path.
- The cloud runner's tool policy blocks `reflection`, so cloud runs neither
  save nor read memories today.
- The desktop shows the files as pinned "Session lessons" and "Project
  lessons" artifacts (`desktop_runtime/session_detail.rs`). Read only.
- `cloud_agent_omp_state` (migration `0106_omp_runtime_state.sql`) is keyed by
  `run_id` with `owner_account_id`, so an account-scoped delete is a single
  statement. There is no route that exposes or clears it.
- Account actions write to `cloud_audit_events` through `write_audit` in
  `bridges/cloud-server/src/auth/routes/support.rs`.
- `Settings` (`agent/crates/core/src/settings.rs`) has no save helper. The
  global file path comes from `global_settings_path()` in `config.rs`. PR 3
  adds a `save_global` that writes the merged struct back.
- `app/desktop/src/pages/SettingsPage.tsx` has no importer. The live settings
  surface is `CloudAccountSettingsDialog`, so the issue's instruction to add a
  `memory` section to `kordi-app/data/settings.tsx` is stale. The Memory tab
  lives in the dialog, next to Notifications and Appearance.
- #1682 (privacy page), #1685 (deletion register), #1686 (capability gating),
  and #1687 (AI opt-out) are open. This plan names the hooks it needs from each
  and does not block on them except where stated.

## Decisions

- **Product word.** Product copy says memory. Internal names stay
  `reflection`/`lesson` until the storage moves in PR 1, so the diff stays
  reviewable.
- **Memories belong to the account, not the Mac.** When the person is signed
  in, the cloud server is the source of truth. A `cloud_account_memories`
  table holds `memory_id`, `owner_account_id`, `scope`, `scope_id`,
  `scope_label`, `source`, `text`, `created_at`, `updated_at`, and
  `archived_at`. The routes are:
  - `GET /v1/cloud/memory`: the account's non-archived memories.
  - `POST /v1/cloud/memory`: save one memory.
  - `PATCH /v1/cloud/memory/{memory_id}`: edit the text.
  - `DELETE /v1/cloud/memory/{memory_id}`: delete one memory.
  - `DELETE /v1/cloud/memory`: forget all, returning `{ "archived": n }`.
  - `GET` and `PUT /v1/cloud/memory/settings`: `{ memoryEnabled, excludeSensitive }`.

  Every write is audited through `write_audit`. The capabilities response
  gains `memoryVersion: 1`; clients hide the Memory section without it.
- **The Mac keeps a cache, not a second truth.** When signed in, the Mac
  runtime writes new memories through `POST /v1/cloud/memory` and, at session
  start, refreshes the local `reflection_lessons` rows and the
  `reflection-lessons/<scope>/<scope-id>.md` files from the server list. The
  agent-facing file path and prompt section do not change. Signed out, it
  saves locally and uploads those rows at the next sign-in. Existing files on a
  Mac are uploaded once on the first sign-in after the update; the three-line
  fixture test applies to that upload. A cache rewrite writes to a sibling
  temporary file and renames it, so a crash leaves either the old or the new
  file, never a partial one.
- **Cloud runs use the same memories.** The cloud runner's tool policy stops
  blocking `reflection`. The runner reads and writes the account's memories
  through the same routes with the run's account scope. The opt-out quote
  guard and the sensitive keyword guard run on the server on every `POST` and
  `PATCH`, and on the Mac before the request, so both paths reject the same
  text.
- **Memory off means not read, not deleted.** The settings block in
  `agent/crates/core/src/settings.rs` becomes
  `"memory": { "memory_enabled": true, "exclude_sensitive": true }` and
  mirrors the account settings for the signed-out case. When memory is off,
  the harness sets `reflection: None`, removes `reflection` from the tool
  selection before `ToolRegistry::from_builtin_and_extensions`, and skips
  `build_reflection_lesson_artifacts_system_prompt_section`. The runner does
  the same from the account setting. Memories stay stored. Turning the switch
  back on reads them again on every device. The settings copy says exactly
  this.
- **Sensitive content is a tool rule and a guard on both paths.** The
  `reflection` tool description and the prompt section gain one sentence
  listing the excluded categories. The guard rejects memory text that matches
  a small keyword list (health conditions and medication, financial account
  and card patterns, credentials and token patterns, relationship and identity
  attribute terms) with an error that names the category and asks for a
  memory about the task instead. The guard is deliberately narrow and
  documented as a floor, not a classifier.
- **Opt-out members are never quoted.** A memory containing a verbatim run of
  twelve or more words from any member who turned off AI use (#1687) is
  rejected. The comparison is on whitespace-normalised, case-folded text. The
  Mac checks against the opted-out texts it already receives; the server
  checks against its own copy of the scope's messages.
- **iPhone gets the same Memory screen.** It uses the same routes to read,
  edit, delete, and forget memories, to flip both switches, and to clear
  replay state.
- **Memories are in the deletion register.** They are recorded in the
  register from #1685 and removed when the account is deleted.
- **Replay state is cleared, not shown.** The server route deletes every
  `cloud_agent_omp_state` row with the caller's `owner_account_id`, writes one
  `cloud_audit_events` row with the deleted count, and returns the count. The
  settings page describes the state in one sentence and offers the clear
  action. Nothing in the state is rendered to the person because it is a
  provider message log, not content the person wrote.
- **Capability gating, not version sniffing.** Desktop and iPhone show the
  Memory section and the Replay state section only when `memoryVersion` is
  present in `AuthCapabilitiesResponse`
  (`bridges/cloud-server/src/auth/routes/types.rs`), following #1686.
- **Preview flag until the real client exists.** PR 0 renders the tab only
  when `VITE_KORDI_MEMORY_PREVIEW=1`, through `memoryClientForEnvironment()`.
  PR 4 replaces the environment lookup with a client backed by the account
  memory routes and keeps the preview client for `tests/visual`.
- **Bridge memory is named, not managed.** `bridges/cli/src/conversation_memory.rs`
  stays CLI only and stays on the Mac. The settings page has one read-only row
  under "On this Mac only" so people know it exists and where it is managed.

## PR 0: desktop Memory settings tab (this branch)

Files:

- `app/desktop/src/features/memory/memoryModel.ts`: types, `LESSON_MAX_CHARS`,
  source and scope labels, grouping, date labels, `validateLessonText`,
  `forgetConsequences`, `MemorySyncState`, `syncStatusLabel`.
- `app/desktop/src/features/memory/memoryClient.ts`: `MemoryClient`,
  `createPreviewMemoryClient`, `memoryClientForFlag`,
  `memoryClientForEnvironment`.
- `app/desktop/src/features/memory/MemorySettingsPanel.tsx`: the panel.
- `app/desktop/src/pages/CloudAccountSettingsDialog.tsx`: `memory` tab, Brain
  icon, `memoryClient` prop.
- `app/desktop/tests/memorySettingsPanel.test.tsx`: model, client flag, panel
  behaviour, sync status, nav visibility.
- `app/desktop/tests/visual/memorySettings.html` and `.tsx`: login-free preview
  opened through `KORDI_DEV_PREVIEW_PATH`.

Panel, top to bottom:

1. **Memory.** The sync caption ("Synced with <account> · <when>") and the
   two switches, "Let Kordi save memories" and "Keep sensitive details out of
   memories", with no explanatory copy. Both switches are on by default.
2. **Saved memories.** Grouped under Conversations, Projects, Groups. Each row
   shows the text, the source ("From a correction", "From a repeated failure",
   "From an outcome", "Added by hand"), the conversation or project label, and
   the date. Edit opens an inline editor with a 500 character counter. Delete
   asks once. "Forget everything" asks once and states the count and that the
   memories are deleted from the account and every signed-in device. When
   memory is off, a note says existing memories are kept but not read.
3. **Replay state.** Shown only when the client reports it available. One
   sentence of description from the issue, the run count, and "Clear replay
   state" with a confirmation.
4. **On this Mac only.** One read-only row naming bridge conversation memory
   and where it is managed.

The `MemoryClient` interface is the contract for PR 4:

| Method | Route (PR 4) |
|---|---|
| `settings()` | `GET /v1/cloud/memory/settings` when signed in; global settings file when signed out |
| `updateSettings(patch)` | `PUT /v1/cloud/memory/settings` when signed in; global settings file when signed out |
| `listLessons()` | `GET /v1/cloud/memory` |
| `updateLesson(id, text)` | `PATCH /v1/cloud/memory/{memory_id}` |
| `archiveLesson(id)` | `DELETE /v1/cloud/memory/{memory_id}` |
| `forgetAll()` | `DELETE /v1/cloud/memory` |
| `syncState()` | signed-in account label, and the time of the last successful list or write |
| `replayState()` | capabilities fetch plus `GET` count, or `available: false` |
| `clearReplayState()` | `DELETE /v1/cloud/agent-runs/omp-state` (PR 5) |

## PR 1: server memory store

- Migration creating `cloud_account_memories` with the columns listed under
  Decisions, indexed on `(owner_account_id, scope, scope_id)` for non-archived
  rows.
- The six memory routes and the two settings routes, all scoped to the
  signed-in account. Text is normalised and limited to 500 characters, the
  same rule as `validateLessonText`.
- The sensitive keyword guard and the opt-out quote guard on every `POST` and
  `PATCH`, returning an error that names the reason.
- `write_audit` on every write, with the memory id or the archived count.
- `memoryVersion: 1` in the capabilities response.
- Database-backed tests: list, save, edit, delete, forget all, settings round
  trip, one keyword hit, one twelve-word quote, one eleven-word near miss that
  passes, and one audit row per write.

## PR 2: Mac runtime write-through

- Schema migration adds `lesson_text TEXT` to the local `reflection_lessons`
  so the cache holds the text, not only the file.
- Signed in, `save_reflection_lesson` posts to `POST /v1/cloud/memory` and
  writes the returned row to the cache. At session start the runtime lists
  the account's memories, replaces the cached rows, and rewrites each
  `reflection-lessons/<scope>/<scope-id>.md` file from them. The file keeps
  its header and the `- <timestamp> [<source>] <text>` line format, so the
  prompt section, the pinned artifacts, and the `read` path do not change.
- Signed out, memories are saved to the cache with a pending-upload marker
  and uploaded at the next sign-in.
- One-time upload: on the first sign-in after the update, each distinct
  `(scope, scope_id)` file is parsed in order and its lines uploaded. A
  fixture with three appended lines must produce three server rows with the
  right text, source, and order.
- Tests cover the write-through, the refresh replacing a stale cache, the
  signed-out queue, and the one-time upload running once.

## PR 3: harness enforcement

- `Settings.memory: MemorySettings { memory_enabled: bool, exclude_sensitive: bool }`
  with defaults true, true, serialised as shown under Decisions.
  `Settings::save_global` writes `global_settings_path()` atomically. Signed
  in, the block mirrors the account settings.
- `session_bootstrap.rs` and `run.rs` branch on `memory_enabled` as described
  under Decisions. A test asserts the tool is absent from
  `tool_registry.active_tools()` and the prompt has no "Scoped lesson
  artifacts" section.
- `ReflectionTool::description` and the prompt section gain the sensitive
  categories sentence when `exclude_sensitive` is true.
  `reflection_runtime::build_reflection_runtime` takes a `ReflectionGuards`
  value holding the keyword guard flag and the opted-out member texts, and
  rejects before any request or write, matching the server guards.
- The cloud runner's tool policy allows `reflection`, reads the account's
  memories through the routes at run start, writes through `POST`, and drops
  the tool and prompt section when the account setting is off. Runner tests
  cover both switch states.

## PR 4: desktop client and iPhone screen

- A `createAccountMemoryClient()` backed by the routes in the table above,
  which `memoryClientForEnvironment()` returns when the account reports
  `memoryVersion`. Signed out, `settings()` and `updateSettings()` go through
  a desktop command that reads and writes the global settings file.
- The iPhone Memory screen, reachable from account settings, with the same
  sections and copy: read, edit, delete, forget, both switches, and replay
  state.
- Desktop and iPhone tests for capability gating and the sync row.

## PR 5: replay state and deletion register

- `DELETE /v1/cloud/agent-runs/omp-state` for the signed-in account, returning
  `{ "deleted": n }`, audited through `write_audit`. Database-backed test.
- Deletion register entries from #1685 for `cloud_account_memories` and
  `cloud_agent_omp_state`, so both are removed when the account is deleted.

## PR 6: documentation

- `docs/memory.md`: the two layers, where each lives (account memories versus
  bridge memory on the Mac), how the Mac cache works, what each control
  removes, and that replay state was never part of sync replay, digests, or
  other members' context.
- Link the Memory tab from the desktop Privacy page when #1682 lands.

## Acceptance mapping

| Issue criterion | Where it is proved |
|---|---|
| Read, edit, delete, forget from Settings; next turn on any device no longer sees it | PR 1 route tests, PR 2 cache refresh test, PR 4 client tests, panel test |
| Memory off removes tool and prompt section on the Mac and in cloud runs | PR 3 bootstrap test, PR 3 runner test |
| Opt-out quote rejected on both paths | PR 1 server guard test, PR 3 Mac guard test |
| Sensitive keyword rejected on both paths | PR 1 server guard test, PR 3 Mac guard test |
| Three-line fixture uploads as three rows | PR 2 upload test |
| Same memories on every device and cloud run | PR 2 write-through test, PR 3 runner test |
| Clear replay state deletes rows and audits; older servers hide the control | PR 5 route test, PR 4 capability test |
| Memories and replay state removed on account deletion | PR 5 register test |
| Copy passes `pnpm check:english` | every PR |

## Out of scope

Unchanged from the issue: bridge memory management, a global memory scope,
and automatic rewriting of memories when a quoted message is later deleted.

## Open questions for review

1. Should "Keep sensitive details out of memories" be a visible switch at
   all, or always on? The preview shows it as a switch so the choice can be
   made by looking at it.
2. The keyword guard will have false positives. Is an error with a category
   name the right failure, or should the memory be saved with the matching
   span removed?
3. Replay state shows a run count only. Is a per-conversation list worth the
   extra route, given the state is a provider message log?
4. Should a memory saved while signed out be uploaded automatically at
   sign-in, or should the person confirm the upload once?
