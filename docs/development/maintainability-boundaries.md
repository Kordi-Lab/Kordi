# Maintainability boundaries

Issue #235 tracks long-term refactors for overlong modules and mixed-responsibility files. Treat it as a sequence of small, behavior-preserving PRs. Do not attempt to split every hotspot in one change.

## Soft limits

These limits are planning signals, not automatic failures:

- Production source above **1,000 LOC** needs an owner plan or an explicit defer reason.
- Test files above **1,500 LOC** should be split by domain/scenario, with shared builders moved into test-support modules.
- CSS above **1,000 LOC** should be split by responsibility before adding large new rule groups.
- Generated, vendor, build, and lock files are excluded from manual refactor work.

Use the scan script to refresh the list:

```bash
pnpm maintainability:scan -- --min-lines 500 --limit 60
pnpm maintainability:scan -- --min-lines 1000 --limit 40
```

The script skips generated/build/vendor paths including `target/`, `node_modules/`, `dist/`, `.git/`, and `app/desktop/src-tauri/gen/`.

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

This table documents why the high-priority files from #235 are deferred from a single broad refactor and what the next small PR should target.

| Area | File | Disposition |
| --- | --- | --- |
| Desktop Rust runtime | `agent/crates/cli/src/desktop_runtime.rs` | Attachment helpers and model option/thinking helpers have been extracted. Next safe slice: extract session-title helpers or turn execution DTOs with tests. |
| Desktop Rust chat | `app/desktop/src-tauri/src/chat.rs` | Attachment/artifact helpers have been extracted. Next safe slice: move live-turn snapshot helpers or session action helpers behind existing Tauri command names. |
| Canonical sessions | `app/desktop/src-tauri/src/canonical_sessions.rs` | Canonical session tests are now partitioned by scenario. Next safe slice: split command-facing DTOs from persistence helpers first. |
| Bridge config/state | `app/desktop/src-tauri/src/bridge/mod.rs` | Defer broad split. Extract config/state summary helpers before moving command handlers. |
| Bridge network | `app/desktop/src-tauri/src/bridge/network.rs` | Defer until relay/realtime tests are stable. Split client construction from request policy. |
| Bridge mailbox | `app/desktop/src-tauri/src/bridge/mailbox.rs` | Defer broad split. Extract mailbox payload parsing and scheduling helpers first. |
| Frontend app model | `app/desktop/src/app/useKordiAppModel.ts` | Defer broad split. Continue extracting feature selectors/effects as adjacent work touches them. |
| Transcript UI | `app/desktop/src/kordi-app/components/transcript.tsx` | Attachment previews and live-turn/tool-timeline rendering have been isolated. Next safe slice: separate remaining message chrome/contact rows only when behavior changes require it. |
| Workspace sidebar | `app/desktop/src/pages/WorkspaceSidebar.tsx` | Defer broad split. Extract participant-space row groups and menu actions separately. |
| Model control centers | `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx`, `app/desktop/src/kordi-app/auth/OllamaModelControlCenter.tsx` | Defer broad split. Split provider API/state-machine helpers before presentational components. |
| Chats page | `app/desktop/src/pages/ChatsPage.tsx` | Defer broad split. Extract composer footer/routing controls when behavior changes require touching them. |
| Desktop chat state | `app/desktop/src/features/chat/useDesktopChatState.ts` | Queue persistence, live-turn snapshot helpers, and refresh/cache reducers have been extracted to focused modules. Next safe slice: split live-turn polling/completion orchestration or notification side effects. |
| Desktop API client | `app/desktop/src/lib/desktop.ts` | Defer broad split. Group exports by resource only when consumers can move in the same PR. |
| Bridges CLI commands | `bridges/cli/src/commands.rs` | Defer broad split. Move one command family per PR with command-level tests. |
| Bridges local API | `bridges/cli/src/local_api.rs` | Defer broad split. Split route handlers by resource without changing URLs. |
| Bridges daemon/server | `bridges/cli/src/daemon.rs`, `bridges/cli/src/serve/auth.rs`, `bridges/cli/src/main.rs`, `bridges/cli/src/sync_engine.rs` | Defer until command/local API splits reduce shared coupling. |
| Large tests | `app/desktop/src-tauri/src/bridge/storage/tests.rs` | Canonical session, turn-runner, and extension tests are split into child modules, and chat-start plus bridge canonical read-model coverage has been split out of `chatRouting.test.tsx`. Continue partitioning large tests by domain before production moves in the same area. |
| CSS | `app/desktop/src/styles/shell.css`, `app/desktop/src/styles/theme-overrides.css` | Shell CSS is split into popover, bubble, transcript, sidebar, and page layers. Next safe slice: split remaining layout/control shell rules or `theme-overrides.css` with screenshot/manual smoke checks. |

## Completed slices

- `app/desktop/src/features/chat/useDesktopChatState.ts`: queued-message localStorage persistence moved to `app/desktop/src/features/chat/queuedDesktopMessages.ts` with focused tests in `app/desktop/tests/queuedDesktopMessages.test.tsx`.
- `app/desktop/src/features/chat/useDesktopChatState.ts`: live-turn snapshot/echo/completed-message helpers moved to `app/desktop/src/features/chat/desktopLiveTurns.ts` with focused tests in `app/desktop/tests/desktopLiveTurns.test.tsx`.
- `app/desktop/src/features/chat/useDesktopChatState.ts`: refresh-state merge, store pruning, and mapped-message cache reducers moved to `app/desktop/src/features/chat/desktopChatStateReducers.ts` with focused tests in `app/desktop/tests/desktopChatStateReducers.test.tsx`.
- `app/desktop/tests/chatRouting.test.tsx`: chat-start/sidebar routing tests moved to `app/desktop/tests/chatStartRouting.test.tsx`, and bridge runtime/visibility read-model coverage moved to `app/desktop/tests/canonicalBridgeRuntimeReadModel.test.tsx` and `app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx`, while preserving test names.
- `app/desktop/src/styles/shell.css`: popover, bubble, transcript, sidebar, and page selectors moved to `app/desktop/src/styles/shell-popovers.css`, `app/desktop/src/styles/shell-bubbles.css`, `app/desktop/src/styles/shell-transcript.css`, `app/desktop/src/styles/shell-sidebar.css`, and `app/desktop/src/styles/shell-pages.css`; CSS tests now read the split shell bundle through `app/desktop/tests/helpers/readDesktopStyles.ts`.
- `agent/crates/cli/src/desktop_runtime.rs`: attachment metadata, prompt attachment expansion, and image-loading helpers moved to `agent/crates/cli/src/desktop_runtime/attachments.rs` with focused Rust tests.
- `app/desktop/src-tauri/src/chat.rs`: attachment storage/download and artifact preview/directory helpers moved to `app/desktop/src-tauri/src/chat/attachments.rs` and `app/desktop/src-tauri/src/chat/artifacts.rs` with focused Rust tests.
- `app/desktop/src-tauri/src/canonical_sessions/tests.rs`: desktop sync, direct message sync, group message sync, group agent request, and group agent response scenarios moved to child modules under `app/desktop/src-tauri/src/canonical_sessions/tests/`, leaving common helpers and core canonical session tests in the root test module.
- `agent/crates/cli/src/turn_runner/tests.rs`: provider-failure, tool-execution, and compaction scenarios moved to child modules under `agent/crates/cli/src/turn_runner/tests/`, leaving shared fake providers/tools in the root test module.
- `agent/crates/cli/src/extensions/tests.rs`: parsing/result, package-resource, and command/runtime scenarios moved to child modules under `agent/crates/cli/src/extensions/tests/`, leaving shared imports and `node_available()` in the root test module.
- `app/desktop/src/kordi-app/components/transcript.tsx`: attachment preview URL derivation, native open/download actions, image/file cards, and `AttachmentPreview` moved to `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`.
- `app/desktop/src/kordi-app/components/transcript.tsx`: live-turn cards, visible-turn merge helpers, delayed live status, tool timeline rows, and tool transcript detail blocks moved to `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx` while preserving existing transcript exports.
- `agent/crates/cli/src/desktop_runtime.rs`: model option cache/loading, model resolution, auth-choice matching, and thinking-control helpers moved to `agent/crates/cli/src/desktop_runtime/model_options.rs` while preserving public desktop runtime exports.

## PR checklist for future splits

- [ ] The PR names the exact hotspot and responsibility being extracted.
- [ ] Public command/API names and UI behavior are unchanged unless a separate issue scopes behavior change.
- [ ] Tests are moved or added before production code moves when behavior could regress.
- [ ] The old module either shrinks or gains a documented reason for temporary growth.
- [ ] Validation includes the narrow test suite plus any affected app/Rust checks.
