# Bridges CLI Project Commands Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue reducing the overlong `bridges/cli/src/commands.rs` hotspot by extracting project lifecycle command logic without changing public command names.

**Architecture:** Keep `bridges::commands` as the public facade. Add `bridges/cli/src/commands/projects.rs` as a private child module for project create/invite/join/members commands and shareable invite parsing. Re-export `cmd_create`, `cmd_invite`, `cmd_join`, and `cmd_members` from `commands.rs`.

**Tech Stack:** Rust workspace crate `bridges`, blocking `reqwest`, existing local DB/query/workspace helpers, existing invite parsing unit tests.

---

### Task 1: Extract project command family from `commands.rs`

**Files:**
- Modify: `bridges/cli/src/commands.rs`
- Create: `bridges/cli/src/commands/projects.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing test/API reference**

In `bridges/cli/src/commands.rs`, update the existing shareable invite tests to reference `projects::encode_shareable_invite` and `projects::resolve_join_invite`. This proves the new project command module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p bridges commands::tests::shareable_invite_round_trips`

Expected: FAIL with an unresolved `projects` module/symbol error.

- [x] **Step 3: Move project implementation into child module**

Create `bridges/cli/src/commands/projects.rs` with:
- `ShareableInvite`
- `ResolvedInvite`
- shareable invite encode/decode/resolve helpers
- `cmd_create`
- `cmd_invite`
- `cmd_join`
- `cmd_members`
- moved invite parsing tests

In `bridges/cli/src/commands.rs`:
- add `mod projects;`
- add `pub use projects::{cmd_create, cmd_invite, cmd_join, cmd_members};`
- remove moved project helpers and tests from the root module.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p bridges commands::projects --no-default-features`

Expected: project command helper tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Bridges CLI commands disposition should mention project lifecycle extraction.
- Completed slices should include the project command family split.

- [x] **Step 6: Run slice verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bridges commands --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
```

Expected: commands tests PASS; formatting and whitespace checks pass; scan shows `bridges/cli/src/commands.rs` reduced again.

- [ ] **Step 7: Commit**

Run:

```bash
git add bridges/cli/src/commands.rs bridges/cli/src/commands/projects.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-cli-project-commands-split.md
git commit -m "Extract bridges CLI project commands"
```
