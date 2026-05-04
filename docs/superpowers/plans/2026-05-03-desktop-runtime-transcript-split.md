# Desktop Runtime Transcript Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/desktop_runtime.rs` by extracting historical transcript reconstruction into a focused module without changing desktop chat behavior.

**Architecture:** Add `agent/crates/cli/src/desktop_runtime/transcript.rs` for session-entry-to-desktop-message projection. Keep root desktop runtime DTOs and public APIs unchanged; root calls `transcript::load_session_messages` through a private module import.

**Tech Stack:** Rust `kordi-cli`, `kordi_session` active-path entries, `kordi_core::types`, existing desktop runtime Rust unit tests.

---

### Task 1: Extract historical transcript reconstruction

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Create: `agent/crates/cli/src/desktop_runtime/transcript.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test reference**

In `agent/crates/cli/src/desktop_runtime.rs`, update `load_session_messages_preserves_failed_assistant_error` to call `transcript::load_session_messages`. This proves the new transcript module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-cli desktop_runtime::tests::load_session_messages_preserves_failed_assistant_error --no-default-features`

Expected: FAIL with an unresolved `transcript` module/symbol error.

- [x] **Step 3: Move transcript implementation into child module**

Create `agent/crates/cli/src/desktop_runtime/transcript.rs` with:
- `HistoricalTurnBuilder`
- `flush_historical_turn`
- `tool_detail_label`
- `pub(super) fn load_session_messages`
- `user_visible_text_from_blocks`
- `text_from_blocks`
- moved failed-assistant regression test

In `agent/crates/cli/src/desktop_runtime.rs`:
- add `mod transcript;`
- add `use transcript::load_session_messages;`
- remove moved transcript helpers/test.
- remove root imports that were only used by the moved transcript block.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p kordi-cli desktop_runtime::transcript --no-default-features`

Expected: transcript tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Desktop Rust runtime disposition should mention transcript reconstruction extraction.
- Completed slices should include the transcript split.

- [x] **Step 6: Run slice verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
```

Expected: desktop runtime tests PASS; formatting and whitespace checks pass; scan shows `desktop_runtime.rs` reduced.

- [ ] **Step 7: Commit**

Run:

```bash
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/transcript.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-desktop-runtime-transcript-split.md
git commit -m "Extract desktop runtime transcript projection"
```
