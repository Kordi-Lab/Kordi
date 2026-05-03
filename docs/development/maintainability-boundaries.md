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
| Desktop Rust runtime | `agent/crates/cli/src/desktop_runtime.rs` | Defer broad split. Start with extracted pure attachment/session-title helpers or turn execution DTOs with tests. |
| Desktop Rust chat | `app/desktop/src-tauri/src/chat.rs` | Defer broad split. Next safe slice: move live-turn snapshot helpers or session action helpers behind existing Tauri command names. |
| Canonical sessions | `app/desktop/src-tauri/src/canonical_sessions.rs` | Defer until tests are partitioned. Split command-facing DTOs from persistence helpers first. |
| Bridge config/state | `app/desktop/src-tauri/src/bridge/mod.rs` | Defer broad split. Extract config/state summary helpers before moving command handlers. |
| Bridge network | `app/desktop/src-tauri/src/bridge/network.rs` | Defer until relay/realtime tests are stable. Split client construction from request policy. |
| Bridge mailbox | `app/desktop/src-tauri/src/bridge/mailbox.rs` | Defer broad split. Extract mailbox payload parsing and scheduling helpers first. |
| Frontend app model | `app/desktop/src/app/useKordiAppModel.ts` | Defer broad split. Continue extracting feature selectors/effects as adjacent work touches them. |
| Transcript UI | `app/desktop/src/kordi-app/components/transcript.tsx` | Defer broad split. Next safe slice: isolate attachment/markdown/tool rows with snapshot-style rendering tests. |
| Workspace sidebar | `app/desktop/src/pages/WorkspaceSidebar.tsx` | Defer broad split. Extract participant-space row groups and menu actions separately. |
| Model control centers | `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx`, `app/desktop/src/kordi-app/auth/OllamaModelControlCenter.tsx` | Defer broad split. Split provider API/state-machine helpers before presentational components. |
| Chats page | `app/desktop/src/pages/ChatsPage.tsx` | Defer broad split. Extract composer footer/routing controls when behavior changes require touching them. |
| Desktop chat state | `app/desktop/src/features/chat/useDesktopChatState.ts` | Defer broad split. Extract live-turn store utilities and queue persistence helpers first. |
| Desktop API client | `app/desktop/src/lib/desktop.ts` | Defer broad split. Group exports by resource only when consumers can move in the same PR. |
| Bridges CLI commands | `bridges/cli/src/commands.rs` | Defer broad split. Move one command family per PR with command-level tests. |
| Bridges local API | `bridges/cli/src/local_api.rs` | Defer broad split. Split route handlers by resource without changing URLs. |
| Bridges daemon/server | `bridges/cli/src/daemon.rs`, `bridges/cli/src/serve/auth.rs`, `bridges/cli/src/main.rs`, `bridges/cli/src/sync_engine.rs` | Defer until command/local API splits reduce shared coupling. |
| Large tests | `app/desktop/src-tauri/src/canonical_sessions/tests.rs`, `app/desktop/tests/chatRouting.test.tsx`, `agent/crates/cli/src/turn_runner/tests.rs`, `agent/crates/cli/src/extensions/tests.rs`, `app/desktop/src-tauri/src/bridge/storage/tests.rs` | Prefer splitting before production moves in the same domain. Preserve test names and move reusable fixtures only after duplication appears. |
| CSS | `app/desktop/src/styles/shell.css`, `app/desktop/src/styles/theme-overrides.css` | Defer visual-risky moves. Split by responsibility with before/after screenshots or manual smoke checks. |

## PR checklist for future splits

- [ ] The PR names the exact hotspot and responsibility being extracted.
- [ ] Public command/API names and UI behavior are unchanged unless a separate issue scopes behavior change.
- [ ] Tests are moved or added before production code moves when behavior could regress.
- [ ] The old module either shrinks or gains a documented reason for temporary growth.
- [ ] Validation includes the narrow test suite plus any affected app/Rust checks.
