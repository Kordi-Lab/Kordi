# Desktop Runtime Root Test Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `agent/crates/cli/src/desktop_runtime.rs` below the 1,000-line scan threshold by moving its remaining inline tests to an adjacent child test module.

**Architecture:** Replace the inline `#[cfg(test)] mod tests { ... }` block in `desktop_runtime.rs` with `#[cfg(test)] mod tests;`, and create `agent/crates/cli/src/desktop_runtime/tests.rs` containing the same tests. Production APIs and helper visibility remain unchanged.

**Tech Stack:** Rust CLI crate, existing desktop runtime tests.

---

### Task 1: Split root desktop runtime tests

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Create: `agent/crates/cli/src/desktop_runtime/tests.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary change**

Replace the inline test module in `agent/crates/cli/src/desktop_runtime.rs` with:

```rust
#[cfg(test)]
mod tests;
```

Do not create `agent/crates/cli/src/desktop_runtime/tests.rs` yet.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-cli desktop_runtime::tests --no-default-features
```

Expected: FAIL with `file not found for module tests`.

- [x] **Step 3: Move the tests into the child file**

Create `agent/crates/cli/src/desktop_runtime/tests.rs` with the original inline test module contents, excluding the outer `mod tests { ... }` wrapper and preserving `use super::*;`.

- [x] **Step 4: Run targeted tests**

Run:

```bash
cargo test -p kordi-cli desktop_runtime --no-default-features
```

Expected: all desktop runtime tests pass.

- [x] **Step 5: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/tests.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-desktop-runtime-root-test-split.md
git commit -m "Split desktop runtime root tests"
```
