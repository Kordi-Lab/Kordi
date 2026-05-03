# Bridges CLI Setup Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the overlong `bridges/cli/src/commands.rs` hotspot by extracting setup/runtime-selection command logic into a focused child module without changing CLI behavior.

**Architecture:** Keep `bridges::commands` as the public command surface. Add `bridges/cli/src/commands/setup.rs` as a private child module that owns setup prompts, runtime detection/validation, daemon setup verification, and `cmd_setup`; re-export `cmd_setup` from `commands.rs` so callers keep using `crate::commands::cmd_setup`.

**Tech Stack:** Rust workspace crate `bridges`, blocking `reqwest`, existing `ClientConfig`/`DaemonConfig`, existing Rust unit tests.

---

### Task 1: Extract setup command family from `commands.rs`

**Files:**
- Modify: `bridges/cli/src/commands.rs`
- Create: `bridges/cli/src/commands/setup.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing test/API reference**

In `bridges/cli/src/commands.rs`, update the existing setup helper tests to reference `setup::preferred_runtime`, `setup::RuntimeCandidate`, `setup::validate_setup_runtime`, and `setup::skill_destination_for_runtime`. This proves the new module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p bridges commands::tests::preferred_runtime_uses_existing_supported_runtime`

Expected: FAIL with an unresolved `setup` module/symbol error.

- [x] **Step 3: Move setup implementation into child module**

Create `bridges/cli/src/commands/setup.rs` with:
- `RuntimeCandidate`
- runtime support/endpoint helpers
- runtime detection and prompt helpers
- `validate_setup_runtime`
- daemon status wait helper
- skill destination/install check helpers
- `pub(super) fn cmd_setup(...)`
- moved setup-focused tests

In `bridges/cli/src/commands.rs`:
- add `mod setup;`
- add `pub use setup::cmd_setup;`
- remove the moved setup helpers/tests from the root module.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p bridges commands::setup --no-default-features`

Expected: setup tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Bridges CLI commands disposition should mention setup/runtime-selection extracted.
- Completed slices should include `bridges/cli/src/commands.rs` setup extraction.

- [ ] **Step 6: Run slice verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bridges commands --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
```

Expected: commands tests PASS; formatting and whitespace checks pass; scan shows `bridges/cli/src/commands.rs` reduced.

- [ ] **Step 7: Commit**

Run:

```bash
git add bridges/cli/src/commands.rs bridges/cli/src/commands/setup.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-cli-setup-split.md
git commit -m "Extract bridges CLI setup commands"
```
