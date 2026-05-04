# Bridges CLI Identity Commands Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue reducing the overlong `bridges/cli/src/commands.rs` hotspot by extracting identity lifecycle command logic without changing public command names.

**Architecture:** Keep `bridges::commands` as the public facade. Add `bridges/cli/src/commands/identity_commands.rs` for registration, remote identity status, revoke, rotate, and identity lifecycle doctor check helpers. Re-export public command functions from `commands.rs`; expose narrow `pub(super)` helpers only where the root doctor command still needs them.

**Tech Stack:** Rust workspace crate `bridges`, blocking `reqwest`, existing identity/keypair helpers, existing Rust unit tests.

---

### Task 1: Extract identity command family from `commands.rs`

**Files:**
- Modify: `bridges/cli/src/commands.rs`
- Create: `bridges/cli/src/commands/identity_commands.rs`
- Modify: `bridges/cli/src/commands/setup.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing test/API reference**

In `bridges/cli/src/commands.rs`, update `doctor_identity_check_reports_revoked_node_as_error` to construct `identity_commands::RemoteIdentityStatus` and call `identity_commands::doctor_identity_check`. This proves the new module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p bridges commands::tests::doctor_identity_check_reports_revoked_node_as_error`

Expected: FAIL with an unresolved `identity_commands` module/symbol error.

- [x] **Step 3: Move identity implementation into child module**

Create `bridges/cli/src/commands/identity_commands.rs` with:
- `RegisteredNode`
- `register_node_with_verifying_key`
- `cmd_register`
- `RemoteIdentityStatus`
- `RemoteReplaceResp`
- `fetch_remote_identity_status`
- `doctor_identity_check`
- `cmd_identity_status`
- `cmd_identity_revoke`
- `cmd_identity_rotate`
- moved identity lifecycle test

In `bridges/cli/src/commands.rs`:
- add `mod identity_commands;`
- add `pub use identity_commands::{cmd_identity_revoke, cmd_identity_rotate, cmd_identity_status, cmd_register};`
- update `cmd_doctor` to call `identity_commands::fetch_remote_identity_status` and `identity_commands::doctor_identity_check`.
- remove moved identity command code/tests.

In `bridges/cli/src/commands/setup.rs`, keep using `super::cmd_register` so the root re-export remains the stable command API.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p bridges commands::identity_commands --no-default-features`

Expected: identity command helper tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Bridges CLI commands disposition should mention identity lifecycle extraction.
- Completed slices should include the identity command family split.

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
git add bridges/cli/src/commands.rs bridges/cli/src/commands/identity_commands.rs bridges/cli/src/commands/setup.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-cli-identity-split.md
git commit -m "Extract bridges CLI identity commands"
```
