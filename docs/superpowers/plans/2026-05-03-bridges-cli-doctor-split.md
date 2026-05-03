# Bridges CLI Doctor Commands Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `bridges/cli/src/commands.rs` closer to the soft limit by extracting Bridges doctor diagnostics into a focused command module without changing CLI behavior.

**Architecture:** Keep `bridges::commands` as the public facade. Add `bridges/cli/src/commands/doctor.rs` for diagnostic checks, hints, reporting, and `cmd_doctor`. Re-export `cmd_doctor` from `commands.rs`; let the doctor module call existing root helpers for member/project resolution and identity helpers through narrow module paths.

**Tech Stack:** Rust workspace crate `bridges`, blocking `reqwest`, existing local API status DTOs, existing Rust unit tests.

---

### Task 1: Extract doctor diagnostics command family from `commands.rs`

**Files:**
- Modify: `bridges/cli/src/commands.rs`
- Create: `bridges/cli/src/commands/doctor.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing test/API reference**

In `bridges/cli/src/commands.rs`, update the existing doctor tests to call `doctor::doctor_service_check`, `doctor::peer_hints`, and `doctor::doctor_peer_check`. This proves the new module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p bridges commands::tests::doctor_service_check_marks_running_status_as_ok`

Expected: FAIL with an unresolved `doctor` module/symbol error.

- [x] **Step 3: Move doctor implementation into child module**

Create `bridges/cli/src/commands/doctor.rs` with:
- `doctor_service_check`
- `doctor_coordination_check`
- `doctor_runtime_check`
- `peer_hints`
- `doctor_project_check`
- `doctor_peer_check`
- `print_doctor_report`
- `cmd_doctor`
- moved doctor helper tests

In `bridges/cli/src/commands.rs`:
- add `mod doctor;`
- add `pub use doctor::cmd_doctor;`
- remove moved doctor helpers/tests from the root module.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p bridges commands::doctor --no-default-features`

Expected: doctor helper tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Bridges CLI commands disposition should mention doctor diagnostics extraction.
- Completed slices should include the doctor command family split.

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
git add bridges/cli/src/commands.rs bridges/cli/src/commands/doctor.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-cli-doctor-split.md
git commit -m "Extract bridges CLI doctor commands"
```
