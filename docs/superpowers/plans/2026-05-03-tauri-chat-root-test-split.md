# Tauri Chat Root Test Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `app/desktop/src-tauri/src/chat.rs` below the 1,000-line scan threshold by moving its remaining inline root tests into an adjacent child module.

**Architecture:** Replace the inline `#[cfg(test)] mod tests { ... }` block in `chat.rs` with `#[cfg(test)] mod tests;`, and create `app/desktop/src-tauri/src/chat/tests.rs` containing the same tests. Production code remains unchanged.

**Tech Stack:** Rust Tauri desktop crate, existing chat tests.

---

### Task 1: Split root chat tests

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/tests.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary change**

Replace the inline test module in `app/desktop/src-tauri/src/chat.rs` with:

```rust
#[cfg(test)]
mod tests;
```

Do not create `app/desktop/src-tauri/src/chat/tests.rs` yet.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop chat::tests --no-default-features
```

Expected: FAIL with `file not found for module tests`.

- [x] **Step 3: Move the tests into the child file**

Create `app/desktop/src-tauri/src/chat/tests.rs` with the original inline test module contents, excluding the outer `mod tests { ... }` wrapper and preserving `use super::*;`.

- [x] **Step 4: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop chat --no-default-features
```

Expected: all chat tests pass.

- [x] **Step 5: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/tests.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-root-test-split.md
git commit -m "Split Tauri chat root tests"
```
