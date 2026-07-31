# Maintainability boundaries

Issues #235 and #693 track long-term refactors for overlong modules and mixed-responsibility files. Treat them as a sequence of small, behavior-preserving PRs. Do not attempt to split every hotspot in one change.

The completed #693 acceptance matrix and reproducible end-state measurements are
recorded in [issue-693-maintainability-closure.md](issue-693-maintainability-closure.md).

## Soft limits

These limits are planning signals, not automatic failures:

- Production source above **1,000 LOC** needs an owner plan or an explicit defer reason.
- Test files above **1,000 LOC** should be split by domain/scenario, with shared builders moved into test-support modules.
- CSS above **500 LOC** should be split by responsibility before adding large new rule groups.
- Generated, vendor, build, and lock files are excluded from manual refactor work.

Use the scan script to refresh the list:

```bash
pnpm maintainability:audit
pnpm maintainability:audit -- --json
pnpm maintainability:scan -- --min-lines 500 --limit 60
pnpm maintainability:scan -- --min-lines 1000 --limit 40
```

The audit inventories git-tracked source and reports production, test, and generated
code separately. Its category rules and output schema are contract-tested, and CI
runs it before the no-growth ratchets. The older hotspot-only scan skips
generated/build/vendor paths including `target/`, `node_modules/`, `dist/`,
`.git/`, and `app/desktop/src-tauri/gen/`.

## Automated no-growth ratchet

Run the same changed-code guard used by CI:

```bash
pnpm maintainability:check
```

The local command compares the working tree, staged changes, committed branch changes, and untracked source files with the merge base of `origin/main`. CI passes the exact pull-request or push range.

Existing debt is allowed to stay the same or shrink. The check fails when a changed source file reaches 500 lines or when an existing 500+ line hotspot grows. Split the added responsibility into a focused sibling module instead of increasing a mixed-responsibility unit. Do not raise the threshold or add a path exclusion to make an unrelated PR pass.

## Module boundary guidance

### Desktop Rust runtime and chat glue

Keep Tauri command handlers thin. Move behavior into services or pure helpers with narrow APIs:

- DTOs and command payloads: command-facing modules only.
- Session lifecycle: create/resume/archive/delete/move behavior and persistence decisions.
- Turn execution: start/cancel/stream state, live turn snapshots, transcript refresh policy.
- Message projection: runtime transcript to UI/canonical DTO mapping.
- Attachments: path storage, metadata extraction, prompt expansion.
- Bridge sync: local runtime to canonical/bridge synchronization should remain separate from command handlers.

### Desktop frontend state and shell

Keep rendering, state orchestration, and side effects separated:

- `useKordiAppModel` should compose focused hooks/selectors instead of owning feature logic directly.
- Pages should receive explicit view models and callbacks; complex derivations should live in feature helpers.
- Transcript components should split row projection, markdown/tool rendering, attachments, and message chrome.
- Desktop bridge/chat actions should keep optimistic state helpers pure and side effects in action hooks.

### Bridges CLI and server modules

Separate CLI parsing from command behavior and route resources:

- CLI commands should dispatch to command-family modules.
- Local API routes should be grouped by resource/workflow.
- Persistence and sync policy should be testable without process-level setup.

### Tests and fixtures

Split test files by scenario domain. Preserve regression names when moving tests. Move large builders into `fixtures` or `test_support` modules only when at least two test files need them.

### Styles

Split shell CSS by responsibility without redesigning:

- base layout and app frame
- navigation/sidebar
- chat/transcript
- composer
- modals/overlays
- utilities and one-off compatibility rules

Keep tokens and theme overrides separate from component-specific rules.

## Current hotspot disposition

This table records the current disposition of the high-priority #235/#693 areas.

| Area | File | Disposition |
| --- | --- | --- |
| Desktop Rust runtime | `agent/crates/cli/src/desktop_runtime.rs` | Stable UI/command DTOs, turn preparation/execution, attachment helpers, model option/thinking helpers, historical transcript projection, session catalog helpers, session detail/profile projection, and the remaining root tests have been extracted. The 915-line root now owns session runtime composition/configuration behind stable public exports. |
| Desktop Rust chat | `app/desktop/src-tauri/src/chat.rs` | Stable Tauri DTOs, process-local blank-draft lifecycle, persisted-session activation/state projection, attachment/artifact helpers, live-turn state helpers, agent runner/preparation logic, canonical sync projection, message route helpers, local model-option/readiness helpers, session action helpers, and remaining root tests have been extracted. The 901-line root is now a stable Tauri command-composition boundary. |
| Desktop Agent Builder | `app/desktop/src-tauri/src/chat/agent_builder.rs` | Models, durable storage, workspace validation/fingerprinting, atomic workspace lifecycle, runtime setup/smoke execution, skill publishing, and regression tests are isolated behind focused modules. The 302-line root is a thin command-composition and status-projection boundary. |
| Desktop LM Studio auth | `app/desktop/src-tauri/src/auth/lm_studio.rs` | Catalog/model parsing, JSON traversal, HTML normalization, model-id validation, environment assembly, and CLI/app path discovery have been extracted. The root file is now under the 1,000-line scan threshold; future slices can focus on load-context orchestration only when behavior changes require touching it. |
| Canonical sessions | `app/desktop/src-tauri/src/canonical_sessions.rs` | Canonical session and command regression tests are partitioned by scenario; typed catalog/message-page/full-state read models, identity/session persistence and migration, identity/session request helpers, group participant/admin mutations, message lookup/dedup, and title reconciliation policy have been extracted. The 855-line composition root and 774-line command root are below the 1,000-line scan threshold. |
| Bridge config/state | `app/desktop/src-tauri/src/bridge/mod.rs` | Defer broad split. Extract config/state summary helpers before moving command handlers. |
| Bridge network | `app/desktop/src-tauri/src/bridge/network.rs` | Defer until relay/realtime tests are stable. Split client construction from request policy. |
| Bridge mailbox | `app/desktop/src-tauri/src/bridge/mailbox.rs` | Mailbox event/thread helpers and parser implementation have been extracted, and inline tests moved to a file module. The mailbox root is now below the 1,000-line scan threshold. |
| Cloud collaboration state | `app/desktop/src/features/cloud/useCloudCollaborationState.ts` | Availability, execution, self-agent sync, transport, reconciliation, account, catalog, session action, group control, message sync, and read-model lifecycles are owned by focused modules. The remaining composition hook is 498 lines. |
| Frontend app model | `app/desktop/src/app/useKordiAppModel.ts` | Domain callbacks and state owners are composed through focused controllers. The exported composition hook is 25 lines. |
| Kordi app type barrel | `app/desktop/src/kordi-app/types.ts` | Message, transcript artifact, queued message, and live-turn snapshot types have been moved to a focused child module; the root type barrel is now below the 1,000-line scan threshold. |
| Transcript UI | `app/desktop/src/kordi-app/components/transcript.tsx` | Attachment previews and live-turn/tool-timeline rendering have been isolated. Next safe slice: separate remaining message chrome/contact rows only when behavior changes require it. |
| Workspace sidebar | `app/desktop/src/pages/WorkspaceSidebar.tsx` | Navigation, chat, profile, updater, and support-panel surfaces are split into focused modules. The remaining component is 385 lines and consumes cohesive contracts. |
| Desktop Ollama auth | `app/desktop/src-tauri/src/auth/ollama.rs` | Model/catalog parsing, model-id normalization, embedding filtering, and parser tests have been extracted. The root file is now below the 1,000-line scan threshold; future slices can focus on environment/path helpers only when behavior changes require touching them. |
| Model control centers | `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx`, `app/desktop/src/kordi-app/auth/OllamaModelControlCenter.tsx` | Defer broad split. Split provider API/state-machine helpers before presentational components. |
| Chats page | `app/desktop/src/pages/ChatsPage.tsx` | Main/companion workspaces, pane primitives, controllers, routing, and composer behavior are split by interaction surface. The remaining component is 298 lines and consumes cohesive contracts. |
| Desktop chat state | `app/desktop/src/features/chat/useDesktopChatState.ts` | Queue persistence, live-turn snapshot helpers, and refresh/cache reducers have been extracted to focused modules. Next safe slice: split live-turn polling/completion orchestration or notification side effects. |
| Desktop API client | `app/desktop/src/lib/desktop.ts` | Defer broad split. Group exports by resource only when consumers can move in the same PR. |
| Bridges CLI commands | `bridges/cli/src/commands.rs` | Setup/runtime-selection, project lifecycle, identity lifecycle, and doctor diagnostics command logic have been extracted. Continue one command family per PR with command-level tests; next safe slice: move session or outbound ask/debate command helpers. |
| Bridges local API | `bridges/cli/src/local_api.rs` | Pending request state, delivery-stage tracking, poll response DTOs, daemon-facing response/delivery event storage, and send/ask/broadcast/debate/publish route handlers have been extracted. The root local API file is now below the 1,000-line scan threshold; continue splitting peer/status or transport helpers only when behavior changes require touching them. |
| Bridges daemon/server | `bridges/cli/src/daemon.rs`, `bridges/cli/src/serve/auth.rs`, `bridges/cli/src/main.rs`, `bridges/cli/src/sync_engine.rs` | Daemon startup, mailbox, inbound, and shutdown phases are split into named lifecycle modules; the remaining `run` orchestration is about 160 lines. Other production hotspots remain tracked by #235. |
| Cloud HTTP auth/routes | `bridges/cloud-server/src/auth/routes.rs` | The root is a 215-line router-composition boundary. Resource handlers, persistence, and policy live in focused modules under `auth/routes/`. |
| Cloud Agent runs | `bridges/cloud-server/src/cloud_agent_runtime/runs.rs` | The root composes stable exports; authorization, envelopes, prompts, claims, leases, durable delivery, terminal completion/failure transitions, and typed domain failures each have one focused child module. HTTP status/error-body mapping remains at the route boundary. |
| Local app server | `app/server/src/lib.rs` | The root retains only state construction, route composition, and serving. HTTP handlers/error mapping, typed session projection, protocol mapping, Bridge health, configuration, turn execution, and regression tests live in focused modules. |
| Authentication storage | `agent/crates/cli/src/login/store.rs` | The 174-line facade composes serialized models, generic profile selection/updates, legacy migration, atomic persistence, GitHub Copilot state, and external regression tests behind the existing auth-store API. |
| Large tests | repository-wide | All tracked test files are below 1,000 lines. Desktop, canonical-session, Cloud collaboration, Cloud server E2E, and release-publisher scenarios are partitioned without dropping test statements or scenario names. |
| CSS | `app/desktop/src/styles/` | Shell and theme styles are split by feature ownership. Every stylesheet is at most 480 lines, with normalized selector/declaration parity tests protecting the behavior-preserving split. |

## Completed slices

- `agent/crates/cli/src/login/store.rs`: versioned auth-store records, tagged credential entries, profile/config records, public profile summaries, and secret-redacting debug implementations moved to `agent/crates/cli/src/login/store/models.rs`; serde field names/defaults/flattening and debug output remain unchanged.
- `agent/crates/cli/src/login/store.rs`: the nine auth redaction, validation, persistence, profile-selection, multi-account, and legacy-migration scenarios moved verbatim to `agent/crates/cli/src/login/store/tests.rs`; test names and `login::store::tests::*` paths remain unchanged.
- `agent/crates/cli/src/login/store.rs`: provider normalization, storage-key mapping, credential matching, profile lookup/summaries, active-method resolution, and active-selection repair moved to `agent/crates/cli/src/login/store/profile_selection.rs`. The module is a pure in-memory policy boundary; loading, saving, and public facade paths remain in the root while serialized profile IDs and selection precedence remain unchanged.
- `agent/crates/cli/src/login/store.rs`: timestamped API-key and OAuth profile upserts, OAuth account matching, and stable profile-id generation moved to `agent/crates/cli/src/login/store/profile_updates.rs`. The root continues to orchestrate load/select/save operations, while multi-account matching and existing identifiers retain their prior behavior.
- `agent/crates/cli/src/login/store.rs`: legacy Anthropic OAuth relocation, flat-entry conversion, provider-config conversion, selection repair, and schema-version normalization moved to `agent/crates/cli/src/login/store/migrations.rs`. The migration remains idempotent and preserves legacy profile IDs, account deduplication, serde schema, and automatic load/save invocation.
- `agent/crates/cli/src/login/store.rs`: auth-path resolution, validation, load-time migration, process locking, secret-file permissions, temporary-file creation, and atomic replacement moved to `agent/crates/cli/src/login/store/persistence.rs`. Public facade paths, default-on-read behavior, migration-before-write semantics, and the `0600` Unix contract remain unchanged.
- `agent/crates/cli/src/login/store.rs`: GitHub Copilot enterprise authority configuration, persisted status projection, API-base/model-cache lookup, runtime headers, and authority normalization moved to `agent/crates/cli/src/login/store/github_copilot.rs`. Existing public exports and provider-config/OAuth fallback precedence remain unchanged; the generic facade retains only cross-provider orchestration.
- `app/server/src/lib.rs`: Axum extractors/handlers, response errors, typed session-error mapping, turn request validation/reservation, and background-execution dispatch moved to `app/server/src/http.rs`; route paths, response shapes, status codes, title timing, and active-turn cleanup remain unchanged, leaving the root as composition only.
- `app/server/src/lib.rs`: session listing/detail/fork reads, title and fork-count projection, preview lookup, and fork creation moved to `app/server/src/session_projection.rs`; the module now returns typed bad-request/not-found/internal failures, and the HTTP boundary preserves existing status codes and response text without string matching.
- `app/server/src/lib.rs`: client-header metadata mapping, workspace-name projection, stored-entry timeline conversion, and bounded message previews moved to `app/server/src/protocol_mapping.rs`; protocol version, header defaults, timeline roles/states, and preview text remain unchanged.
- `app/server/src/lib.rs`: Bridge status wire types, transport contract/client, local session-store health, and service-summary projection moved to `app/server/src/bridge_health.rs`; status request paths, service states, detail text, and heartbeat selection remain unchanged.
- `app/server/src/lib.rs`: Bridge daemon port discovery, executable resolution, sibling-binary detection, and source-workspace fallback command construction moved to `app/server/src/configuration.rs`; environment precedence, default port, legacy variable fallback, and launch arguments remain unchanged.
- `app/server/src/lib.rs`: turn execution DTOs, executor contract, process spawning, model/thinking CLI projection, command diagnostics, and bounded output formatting moved to `app/server/src/turn_execution.rs`; command resolution remains a separate configuration concern and HTTP turn behavior is unchanged.
- `app/server/src/lib.rs`: the nine bootstrap, session, fork, and turn endpoint regression scenarios moved verbatim to `app/server/src/tests.rs`; test names and `tests::*` paths remain unchanged while production behavior stays untouched.
- `app/desktop/src-tauri/src/chat.rs`: persisted session discovery/resume, explicit session activation, internal-session filtering, active runtime projection, and canonical state sync moved to `app/desktop/src-tauri/src/chat/session_lifecycle.rs`; fallback ordering, session ids, in-memory handles, canonical sync gating, and returned chat state remain unchanged.
- `app/desktop/src-tauri/src/chat.rs`: blank-title policy, transient draft creation/state projection, and first-write materialization moved to `app/desktop/src-tauri/src/chat/transient_drafts.rs`; the `draft:local-chat` sentinel, empty-draft filtering, first-send persistence, and command-visible state remain unchanged.
- `app/desktop/src-tauri/src/chat.rs`: command response/request DTOs for chat state, turns, routes, artifacts, stored attachments, and fork results moved to `app/desktop/src-tauri/src/chat/models.rs`; Tauri command signatures, camelCase serialization, defaults, and root re-export paths remain unchanged.
- `agent/crates/cli/src/desktop_runtime.rs`: attachment-aware turn preparation, `TurnConfig` construction, background execution/event streaming, and completion projection moved to `agent/crates/cli/src/desktop_runtime/turn_execution.rs`; public session methods, cancellation/event behavior, transcript writes, and returned detail shape remain unchanged.
- `agent/crates/cli/src/desktop_runtime.rs`: the serialized desktop chat model, attachment, transcript, project, session detail, task/context, and fork-result DTOs moved to `agent/crates/cli/src/desktop_runtime/models.rs`; public re-exports, camelCase field names, defaults, and command-facing type paths remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: public run operations now return the typed `RunResult`/`RunError` boundary from `bridges/cloud-server/src/cloud_agent_runtime/runs/errors.rs`; `bridges/cloud-server/src/cloud_agent_runtime/routes.rs` owns the unchanged `404 agent_run_not_found` and `500 server_error` HTTP mapping, while private SQL helpers remain persistence details.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: complete/fail request validation, failure-message policy, response-body selection, terminal run transitions, direct sync publication, and scheduled-task completion projection moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/completion.rs`; public paths, error text, response routing, SQL transitions, and scheduled-task status behavior remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: direct-session peer routing, scheduled-run detection, group recipient/direction projection, durable group fan-out, scheduled direct response insertion, and sync-event delivery moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/delivery.rs`; recipient sets, directions, message shapes, SQL writes, and sync-event payloads remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: runner lease DTOs, ordinary/canary lease transitions, running-state transition, provider-auth availability projection, and shared runner response rows moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/leases.rs`; public paths, lease duration, SQL locking/order, serde names, and response shapes remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: claim DTO validation, account-scoped request lookup, idempotent claim reuse, sandbox assignment, prompt resolution, and queued-run insertion moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/claims.rs`; public paths, serde names, SQL conflict behavior, and response shapes remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: bounded history loading, message-to-prompt projection, quote/forward context, shared-agent prompt assembly, and final fallback prompt composition moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/prompt_history.rs`; history ordering/limit, prompt text, SQL predicates, and claim behavior remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: Cloud group/direct/agent-response wire types, prefix codecs, response-envelope projection, and persisted group-envelope lookups moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/envelopes.rs`; JSON field names, encoded prefixes, SQL ordering, and the public response encoder path remain unchanged.
- `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`: contact authorization, shared-agent target extraction, participant membership checks, and active participant-conversation policy moved to `bridges/cloud-server/src/cloud_agent_runtime/runs/authorization.rs`; public helper paths, SQL predicates, and boolean authorization results remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: the 10 Factory prompt, path, validation, fingerprint, atomic-update, and legacy-migration scenarios moved verbatim to `app/desktop/src-tauri/src/chat/agent_builder/tests.rs`; test names and `chat::agent_builder::tests::*` paths remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: built-skill bundle traversal, publication readiness transition, install-scope parsing, reviewed bundle installation, default-disabled policy, and resource reload moved to `app/desktop/src-tauri/src/chat/agent_builder/publishing.rs`; Tauri command names, bundle limits, installed metadata, and return DTOs remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: Factory runtime profile construction, session-id resolution, cached runtime create/resume, and isolated candidate smoke-turn execution moved to `app/desktop/src-tauri/src/chat/agent_builder/runtime.rs`; existing helper paths, safe tool filtering, prompts, temporary-session cleanup, and report summaries remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: safe draft paths, initial seed materialization, legacy workspace migration, atomic optimistic updates, and structured draft writes moved to `app/desktop/src-tauri/src/chat/agent_builder/workspace.rs`; editable paths, seed defaults, stale-fingerprint rejection, staging rollback, and serialized draft content remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: bounded workspace reads, safe path/frontmatter validation, deterministic content fingerprinting, and draft contract projection moved to `app/desktop/src-tauri/src/chat/agent_builder/validation.rs`; size limits, accepted draft schema, validation errors, and fingerprint bytes remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: draft-id validation, durable draft path resolution, JSON metadata/test-report persistence, active-draft discovery, and the process-local mutation lock moved to `app/desktop/src-tauri/src/chat/agent_builder/storage.rs`; on-disk names, JSON shapes, UUID validation, timestamps, and caller-visible errors remain unchanged.
- `app/desktop/src-tauri/src/chat/agent_builder.rs`: public Tauri DTOs and internal persisted draft records moved to `app/desktop/src-tauri/src/chat/agent_builder/models.rs`; camelCase serialization, field defaults, public type paths, and command signatures remain unchanged.
- `app/desktop/src-tauri/src/canonical_sessions/commands.rs`: SQLite row projection, bounded transcript pages, session catalog summaries, and compatibility full-state loading moved behind the typed `app/desktop/src-tauri/src/canonical_sessions/commands/catalog.rs` boundary. Existing command names, DTOs, query ordering, and page limits remain unchanged; the command root is now 774 lines.
- `app/desktop/src-tauri/src/canonical_sessions/commands.rs`: catalog, membership, and message-delivery regression scenarios moved under `app/desktop/src-tauri/src/canonical_sessions/commands/catalog_tests/`; all seven test functions and assertions are preserved while every scenario file remains below 500 lines.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: canonical session upsert, participant-role persistence, local group-self enforcement, and session row projection moved behind `app/desktop/src-tauri/src/canonical_sessions/persistence/sessions.rs`; SQL, stored metadata, title precedence, and caller-visible DTOs remain unchanged.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: cloud-profile adoption, identity-reference migration, and stable local human/delegate identity lifecycle moved to `app/desktop/src-tauri/src/canonical_sessions/identity_migration.rs`. Transaction boundaries, schema, IDs, and stored JSON remain unchanged.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: canonical message insert/upsert, source-event deduplication, cloud-self echo reconciliation, transactional write locking, and row projection moved to `app/desktop/src-tauri/src/canonical_sessions/persistence/messages.rs`. SQL, content hashing, timestamps, error strings, source precedence, and root helper paths remain unchanged.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: canonical identity validation, upsert, and row projection moved behind `app/desktop/src-tauri/src/canonical_sessions/persistence/identities.rs`; callers retain the same scoped functions and DTOs.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: session-title source precedence and metadata reconciliation moved to the pure `app/desktop/src-tauri/src/canonical_sessions/title_policy.rs` boundary. Existing Tauri commands and stored metadata shapes remain unchanged.
- `app/desktop/src/features/chat/useDesktopChatState.ts`: queued-message localStorage persistence moved to `app/desktop/src/features/chat/queuedDesktopMessages.ts` with focused tests in `app/desktop/tests/queuedDesktopMessages.test.tsx`.
- `app/desktop/src/features/chat/useDesktopChatState.ts`: live-turn snapshot/echo/completed-message helpers moved to `app/desktop/src/features/chat/desktopLiveTurns.ts` with focused tests in `app/desktop/tests/desktopLiveTurns.test.tsx`.
- `app/desktop/src/features/chat/useDesktopChatState.ts`: refresh-state merge, store pruning, and mapped-message cache reducers moved to `app/desktop/src/features/chat/desktopChatStateReducers.ts` with focused tests in `app/desktop/tests/desktopChatStateReducers.test.tsx`.
- Desktop routing/read-model coverage is partitioned into scenario-owned suites and shared fixtures; the original 321 statements from the seven final oversized suites were preserved exactly while each replacement file remains below 500 lines.
- `app/desktop/src/styles/shell.css`: popover, bubble, transcript, sidebar, and page selectors moved to `app/desktop/src/styles/shell-popovers.css`, `app/desktop/src/styles/shell-bubbles.css`, `app/desktop/src/styles/shell-transcript.css`, `app/desktop/src/styles/shell-sidebar.css`, and `app/desktop/src/styles/shell-pages.css`; CSS tests now read the split shell bundle through `app/desktop/tests/helpers/readDesktopStyles.ts`.
- `agent/crates/cli/src/desktop_runtime.rs`: attachment metadata, prompt attachment expansion, and image-loading helpers moved to `agent/crates/cli/src/desktop_runtime/attachments.rs` with focused Rust tests.
- `app/desktop/src-tauri/src/chat.rs`: attachment storage/download and artifact preview/directory helpers moved to `app/desktop/src-tauri/src/chat/attachments.rs` and `app/desktop/src-tauri/src/chat/artifacts.rs` with focused Rust tests.
- `app/desktop/src-tauri/src/canonical_sessions/tests.rs`: desktop sync, direct message sync, group message sync, group agent request, and group agent response scenarios moved to child modules under `app/desktop/src-tauri/src/canonical_sessions/tests/`, leaving common helpers and core canonical session tests in the root test module.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: stable session ids, display-name lookups, receiver/title helpers, optional/status/json normalization, and canonical identity/avatar id derivation moved to `app/desktop/src-tauri/src/canonical_sessions/identity_helpers.rs` while root re-exports preserve existing child module imports.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: group session validation, rename/metadata/member mutations, admin resolution, admin authorization, and active-participant checks moved to `app/desktop/src-tauri/src/canonical_sessions/group_participants.rs` while root re-exports preserve existing command/test imports.
- `app/desktop/src-tauri/src/canonical_sessions.rs`: similar agent-message matching, delegation join lookup, and session message count helpers moved to `app/desktop/src-tauri/src/canonical_sessions/message_lookup.rs`, reducing lookup and deduplication responsibilities in the root module.
- `agent/crates/cli/src/turn_runner/tests.rs`: provider-failure, tool-execution, and compaction scenarios moved to child modules under `agent/crates/cli/src/turn_runner/tests/`, leaving shared fake providers/tools in the root test module.
- `agent/crates/cli/src/extensions/tests.rs`: parsing/result, package-resource, and command/runtime scenarios moved to child modules under `agent/crates/cli/src/extensions/tests/`, leaving shared imports and `node_available()` in the root test module.
- `app/desktop/src/kordi-app/components/transcript.tsx`: attachment preview URL derivation, native open/download actions, image/file cards, and `AttachmentPreview` moved to `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`.
- `app/desktop/src/kordi-app/components/transcript.tsx`: live-turn cards, visible-turn merge helpers, delayed live status, tool timeline rows, and tool transcript detail blocks moved to `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx` while preserving existing transcript exports.
- `agent/crates/cli/src/desktop_runtime.rs`: model option cache/loading, model resolution, auth-choice matching, and thinking-control helpers moved to `agent/crates/cli/src/desktop_runtime/model_options.rs` while preserving public desktop runtime exports.
- `agent/crates/cli/src/desktop_runtime.rs`: historical session-entry transcript projection moved to `agent/crates/cli/src/desktop_runtime/transcript.rs`, while root runtime APIs continue to load desktop chat messages through the same private helper.
- `agent/crates/cli/src/desktop_runtime.rs`: session title repair, session summaries, project group listing, registered project creation, runtime cwd lookup, and project info loading moved to `agent/crates/cli/src/desktop_runtime/session_catalog.rs`, while public runtime catalog APIs remain re-exported from the root module.
- `agent/crates/cli/src/desktop_runtime.rs`: agent profile projection, session detail/summary assembly, context window/cache status helpers, focus subtitle, thinking labels, and message timestamp labels moved to `agent/crates/cli/src/desktop_runtime/session_detail.rs`.
- `agent/crates/cli/src/desktop_runtime.rs`: remaining inline root tests moved to `agent/crates/cli/src/desktop_runtime/tests.rs`, bringing the root runtime module under the 1,000-line scan threshold while preserving the same `desktop_runtime::tests::*` module path.
- `app/desktop/src-tauri/src/chat.rs`: live-turn snapshot locking, turn event application, running-turn pruning, and tool-output helper functions moved to `app/desktop/src-tauri/src/chat/turns.rs` without changing Tauri command DTOs or command names.
- `app/desktop/src-tauri/src/chat.rs`: Bridge-agent temporary execution session, route normalization, fallback selection, and `run_bridge_agent_prompt` moved to `app/desktop/src-tauri/src/chat/bridge_agent_runner.rs`, while crate-visible chat exports remain unchanged for Bridge mailbox call sites.
- `app/desktop/src-tauri/src/chat.rs`: Bridge session directory sanitization, Bridge-agent session cwd derivation, local/non-local mention gating, Bridge outreach prompt context application, and reach_out runtime installation moved to `app/desktop/src-tauri/src/chat/bridge_outreach.rs`.
- `app/desktop/src-tauri/src/chat.rs`: completed-session canonical sync projection, active agent-tail omission while live turns run, and canonical sync regression tests moved to `app/desktop/src-tauri/src/chat/canonical_sync.rs`.
- `app/desktop/src-tauri/src/chat.rs`: authenticated desktop model option enrichment, LM Studio/Ollama running-model merges, local provider default base URL constants, local provider port parsing, and provider readiness checks moved to `app/desktop/src-tauri/src/chat/model_options.rs`.
- `app/desktop/src-tauri/src/chat.rs`: archive/delete/move session target resolution, fallback active-session selection, home path expansion, and project-root input resolution moved to `app/desktop/src-tauri/src/chat/session_actions.rs`; Tauri command macro functions remain in the root module.
- `app/desktop/src-tauri/src/chat.rs`: desktop message route normalization and model/auth/thinking route application moved to `app/desktop/src-tauri/src/chat/message_route.rs`.
- `app/desktop/src-tauri/src/chat.rs`: remaining inline root tests moved to `app/desktop/src-tauri/src/chat/tests.rs`, preserving the same `chat::tests::*` module path and bringing the root chat module under the 1,000-line scan threshold.
- `app/desktop/src-tauri/src/auth/lm_studio.rs`: catalog page parsing, installed/running model JSON traversal, loaded-instance parsing, model-id normalization, and model argument validation moved to `app/desktop/src-tauri/src/auth/lm_studio/parsing.rs` with the parser-focused Rust tests.
- `app/desktop/src-tauri/src/auth/lm_studio.rs`: environment DTO assembly, LM Studio app/home/bin discovery, CLI path resolution, shell PATH repair helpers, and plist parsing moved to `app/desktop/src-tauri/src/auth/lm_studio/environment.rs`; the root LM Studio auth module is now below the 1,000-line scan threshold.
- `app/desktop/src-tauri/src/auth/ollama.rs`: installed/running model JSON traversal, catalog/tag HTML parsing, model-id normalization, model argument validation, embedding filtering, and parser-focused tests moved to `app/desktop/src-tauri/src/auth/ollama/parsing.rs`; the root Ollama auth module is now below the 1,000-line scan threshold.
- `app/desktop/src/app/useKordiAppModel.ts`: pure mention query/filtering, avatar seed, canonical session pruning, metadata, participant-space identity, native-shell detection, and participant-space create-key helpers moved to `app/desktop/src/app/useKordiAppModelHelpers.ts` with focused unit tests.
- `app/desktop/src/app/useKordiAppModel.ts`: Bridge mention-target projection moved to `app/desktop/src/app/useKordiAppModelBridgeMentions.ts`, leaving the root hook to memoize chat/project mention targets from the extracted pure builder.
- `app/desktop/src/kordi-app/types.ts`: message, transcript artifact, queued-message, and live-turn snapshot types moved to `app/desktop/src/kordi-app/types/message.ts`, with root re-exports preserving existing imports and a boundary test covering the split.
- `bridges/cli/src/commands.rs`: setup/runtime-selection helpers and `cmd_setup` moved to `bridges/cli/src/commands/setup.rs`, while `crate::commands::cmd_setup` remains re-exported from the root command module.
- `bridges/cli/src/commands.rs`: project create/invite/join/member commands and shareable invite helpers moved to `bridges/cli/src/commands/projects.rs`, while root command re-exports preserve existing CLI call sites.
- `bridges/cli/src/commands.rs`: registration, identity status/revoke/rotate commands, and identity lifecycle diagnostic helpers moved to `bridges/cli/src/commands/identity_commands.rs`, while root command re-exports preserve existing CLI call sites.
- `bridges/cli/src/commands.rs`: doctor service/coordination/runtime/project/peer diagnostics moved to `bridges/cli/src/commands/doctor.rs`, while root command re-exports preserve existing CLI call sites.
- `bridges/cli/src/local_api.rs`: delivery-stage parsing, pending response records, poll response DTOs, pending insert/update/remove helpers, and daemon-facing `store_delivery_event`/`store_response` functions moved to `bridges/cli/src/local_api/pending.rs`; root re-exports preserve existing daemon and CLI call sites.
- `bridges/cli/src/local_api.rs`: send/ask/broadcast/debate/publish request DTOs, response DTOs, default broadcast message type, and route handlers moved to `bridges/cli/src/local_api/messages.rs`; route URLs and local API JSON shapes are unchanged, and the root file is now below the 1,000-line scan threshold.
- `app/desktop/src-tauri/src/bridge/mailbox.rs`: response-done checks, processing-placeholder detection, partial response buffering decisions, session-thread metadata helpers, group relay target extraction, response payload shaping, and mailbox-event parsing moved to `app/desktop/src-tauri/src/bridge/mailbox_events.rs`; inline mailbox tests moved to `app/desktop/src-tauri/src/bridge/mailbox/tests.rs` while preserving `bridge::mailbox::tests::*` paths.

## PR checklist for future splits

- [ ] The PR names the exact hotspot and responsibility being extracted.
- [ ] Public command/API names and UI behavior are unchanged unless a separate issue scopes behavior change.
- [ ] Tests are moved or added before production code moves when behavior could regress.
- [ ] The old module either shrinks or gains a documented reason for temporary growth.
- [ ] Validation includes the narrow test suite plus any affected app/Rust checks.
