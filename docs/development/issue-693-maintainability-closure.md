# Issue #693 maintainability closure

This document records the reproducible end state of the behavior-preserving work
tracked by GitHub issue #693. It is an acceptance record, not a claim that every
large production file in the repository has been eliminated. Remaining
production hotspots stay visible in the audit and continue under #235.

## Reproduce the inventory

From the repository root:

```bash
pnpm maintainability:audit
pnpm maintainability:audit -- --json
pnpm maintainability:check
```

The audit classifies git-tracked source as production, test, or generated code.
The changed-code check compares staged, working-tree, untracked, and committed
branch changes with the merge base of `origin/main`. CI supplies the exact pull
request or push range.

At the #693 closure tip, the JSON inventory reports:

| Category | Files | Lines | At least 500 | At least 1,000 | At least 1,500 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production | 1,071 | 270,921 | 128 | 35 | 9 |
| Test | 370 | 82,693 | 30 | 0 | 0 |
| Generated | 0 | 0 | 0 | 0 | 0 |

The repository grew while the program was in progress, so total file/line counts
are not a direct before/after measure. The meaningful guardrails are the
category split, zero tracked tests at 1,000 lines, and the no-growth ratchet for
remaining production debt.

## Acceptance matrix

| #693 acceptance criterion | Evidence |
| --- | --- |
| Reproducible categorized audit and required changed-code check | `scripts/report-maintainability-audit.mjs`, its contract tests, `scripts/check-maintainability-ratchet.mjs`, `pnpm maintainability:check`, and CI wiring from #759 and #827. |
| TypeScript/TSX ESLint and React Hooks coverage | `app/desktop/eslint.config.js` applies `typescript-eslint` and React Hooks rules to the application tree; `pnpm --dir app/desktop lint` is part of `pnpm check:frontend` and `pnpm check:ci` (#759). |
| Warning-free Rust workspace | `cargo clippy --workspace --all-targets -- -D warnings` is enforced locally and in CI (#770 and #771). The remaining local `allow` attributes include a reason and point to follow-up #235. |
| Hotspot no-growth policy | The changed-code ratchet fails when a changed source reaches 500 lines or an existing 500+ line hotspot grows. Its baseline, range handling, and untracked-file behavior are contract-tested (#759). |
| Priority frontend units below 500 lines | `useCloudCollaborationState` is 498 lines, `useKordiAppModel` is 25, `ChatsPage` is 298, and `WorkspaceSidebar` is 385. `app/desktop/tests/priorityUnitSizeContract.test.ts` makes the 500-line boundary executable. The splits are in #772–#819 and #821. |
| Cohesive UI contracts, no priority boundary above 50 unrelated fields | Shell, composer, Chats page/session pane, and sidebar contracts are grouped by owned domain. `shellCompositionContract.test.ts`, `composerControllerContract.test.ts`, `chatsPageContract.test.ts`, and `workspaceSidebarContract.test.ts` enforce the 50-field limit (#803 and #806–#809). |
| Cloud auth router is composition only | `bridges/cloud-server/src/auth/routes.rs` is a 215-line router boundary. Resource handlers, persistence adapters, and policy are focused modules under `auth/routes/` (#822). |
| Listed Rust functions reduced to orchestration | Bridges daemon `run` is 159 lines (#825); transcript `load_session_messages` is 20 lines (#824); TUI `apply_command` is 34 lines (#823). The obsolete legacy parent-session outreach path is absent from the current Cloud runtime rather than retained as a parallel implementation. |
| Verified duplicate workflows consolidated | Active-path context is owned by `kordi_session::context::active_path_context_state` (#763); provider stream collection by the `Provider::complete` default (#764); platform binary resolution by `bridges/scripts/platform-binary.js` (#765); composer provider/model/auth selection by `composerModelSelection.ts` (#766); main/companion agent routing by `resolveCollaborationAgentRoutingUpdate` (#767); and Linux installer lifecycle by `install-bridges-linux-common.sh` (#768). Each has focused contract coverage. |
| One protocol source of truth | The Rust protocol crate under `shared/rust/protocol` is authoritative. The unused TypeScript mirror was removed and `scripts/protocol-source-of-truth.test.mjs` prevents a second hand-maintained schema (#769). |
| Large tests partitioned without coverage loss | Canonical sessions, Cloud collaboration, desktop routing/read models, Cloud server E2E, TUI color behavior, and release publishing are split by scenario (#826 and #828–#833). Exact test names/statements were preserved during mechanical partitions; the audit reports zero tracked test files at 1,000 lines. |
| Stable contracts and complete gates | Structural moves retain public exports, command names, serialized shapes, route URLs, test names, and normalized CSS declarations. The final gate set below covers unit, integration, type, lint, build, formatting, Clippy, scripts, maintainability, suppression, and hygiene checks. |

## Priority boundary measurements

The frontend measurements use the TypeScript AST from the start through the end
of each top-level declaration, inclusive:

| Unit | Declaration lines | File lines |
| --- | ---: | ---: |
| `useCloudCollaborationState` | 498 | 769 |
| `useKordiAppModel` | 25 | 31 |
| `ChatsPage` | 298 | 357 |
| `WorkspaceSidebar` | 385 | 437 |

The Cloud route root is 215 lines. Every stylesheet under
`app/desktop/src/styles/` is at most 480 lines. CSS ownership was split with
normalized selector/declaration parity coverage in #830, so this was not a
visual redesign.

## Test partition record

- The seven final oversized desktop suites retained all 321 original test
  statements exactly; replacement test files are at most 457 lines.
- Cloud runtime and auth E2E suites retain 21 named scenarios each and share
  setup without sharing scenario policy.
- The release-publisher suite retains all 39 original test statements exactly.
- The categorized inventory is the final repository-wide guard: tracked test
  files at or above 1,000 lines are zero.

## Final verification

Run these commands on the integrated stack before merging:

```bash
pnpm check:ci
cargo test -p kordi-cloud-server --all-targets
env -u NO_COLOR cargo test -p kordi-tui
NO_COLOR=1 cargo test -p kordi-tui
pnpm --dir app/desktop test:visual
git diff --check
```

`pnpm check:ci` is the repository aggregate: desktop lint, typecheck, unit
tests, and build; Rust formatting, Clippy with denied warnings, and core tests;
script contracts; the maintainability ratchet; suppression validation; and
hygiene checks. The additional commands exercise Cloud server integration
targets, both TUI color modes, and visual contracts.

## Residual debt

The closure audit still reports 35 production files at or above 1,000 lines.
Those files are not hidden, excluded, or waived by #693. They are protected from
silent growth by `pnpm maintainability:check` and remain candidates for small,
owned #235 follow-ups. #693 closes the named priority boundaries, verified
duplicates, test/style organization, and enforceable quality gaps without a
big-bang rewrite or product behavior change.
