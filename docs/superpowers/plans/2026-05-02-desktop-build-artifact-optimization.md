# Desktop Build Artifact Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the dependency surface compiled into the desktop Rust target and add a safe, repeatable cleanup path for inactive worktree `target/` directories.

**Architecture:** Keep shared slash-command metadata in `kordi-core` so desktop-facing `kordi-cli` library code does not need the terminal UI crate. Make `kordi-cli` terminal-only dependencies optional behind the default `cli` feature, and make `kordi-desktop` depend on `kordi-cli` with default features disabled. Add a dry-run-first cleanup script for inactive worktree targets.

**Tech Stack:** Rust/Cargo workspace, Tauri v2 desktop crate, Node ESM scripts with `node:test`.

---

### Task 1: Add dependency-surface and crate-type regression check

**Files:**
- Create: `scripts/check-desktop-dependency-surface.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing dependency-surface check**

Create `scripts/check-desktop-dependency-surface.mjs` that runs:

```bash
cargo tree -p kordi-desktop --no-default-features
```

and fails if the desktop dependency tree contains `kordi-tui`, `clap`, or `crossterm`, or if the desktop crate emits `staticlib` artifacts.

- [ ] **Step 2: Wire the check into package scripts**

Add:

```json
"check:rust:deps": "node scripts/check-desktop-dependency-surface.mjs"
```

and include it in `check:rust:test` before the Rust test commands.

- [ ] **Step 3: Run the check and verify it fails**

Run:

```bash
node scripts/check-desktop-dependency-surface.mjs
```

Expected: FAIL listing `kordi-tui`, `clap`, and/or `crossterm` in the desktop dependency tree.

### Task 2: Remove terminal UI dependencies from desktop's kordi-cli feature set

**Files:**
- Modify: `agent/crates/core/src/lib.rs`
- Create: `agent/crates/core/src/slash_commands.rs`
- Modify: `agent/crates/tui/src/slash_commands.rs`
- Modify: `agent/crates/cli/Cargo.toml`
- Modify: `agent/crates/cli/src/slash.rs`
- Modify: `agent/crates/cli/src/session_bootstrap.rs`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify: `package.json`

- [ ] **Step 1: Move slash command specs to core**

Add `kordi_core::slash_commands` with `SlashCommandSpec`, `shared_slash_commands`, `matches_shared_local_slash_submission`, `install_help_lines`, and `shared_slash_command_help_lines`.

- [ ] **Step 2: Keep the TUI API as a wrapper**

Update `agent/crates/tui/src/slash_commands.rs` to re-export the core slash helpers and only keep `shared_slash_command_select_items()` locally because it returns the TUI-specific `SelectItem` type.

- [ ] **Step 3: Update CLI library code to use core slash metadata**

Update `agent/crates/cli/src/slash.rs` and `agent/crates/cli/src/session_bootstrap.rs` so library code no longer imports `kordi_tui`. Introduce a small local `RuntimeSlashCommandItem` for desktop/runtime slash-menu data.

- [ ] **Step 4: Add kordi-cli features, disable default features from desktop, and stop emitting desktop staticlibs**

Make `clap`, `crossterm`, and `kordi-tui` optional in `agent/crates/cli/Cargo.toml`, add default feature `cli`, add marker feature `desktop-runtime`, remove `staticlib` from the desktop crate types, and set the `kordi-desktop` dependency to:

```toml
kordi-cli = { path = "../../../agent/crates/cli", default-features = false, features = ["desktop-runtime"] }
```

- [ ] **Step 5: Run the dependency-surface check and verify it passes**

Run:

```bash
node scripts/check-desktop-dependency-surface.mjs
```

Expected: PASS and no forbidden terminal dependencies in the desktop tree.

### Task 3: Add safe inactive worktree target cleanup script

**Files:**
- Create: `scripts/clean-inactive-worktree-targets.mjs`
- Create: `scripts/clean-inactive-worktree-targets.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write cleanup script tests first**

Use `node:test` to verify that inactive target dirs are selected, active roots are kept, dry-run mode does not delete, and delete mode removes only inactive targets.

- [ ] **Step 2: Run cleanup tests and verify they fail before implementation**

Run:

```bash
node --test scripts/clean-inactive-worktree-targets.test.mjs
```

Expected: FAIL because the script module does not exist yet.

- [ ] **Step 3: Implement the cleanup script**

Implement a dry-run default CLI with `--delete`, `--worktrees-dir`, and `--keep-root`. Keep roots referenced by active process/cwd/open-target discovery. Export pure helper functions for tests.

- [ ] **Step 4: Run cleanup tests and verify they pass**

Run:

```bash
node --test scripts/clean-inactive-worktree-targets.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Add package scripts**

Add:

```json
"clean:worktree-targets": "node scripts/clean-inactive-worktree-targets.mjs",
"clean:worktree-targets:delete": "node scripts/clean-inactive-worktree-targets.mjs --delete",
"test:scripts": "node --test scripts/*.test.mjs"
```

### Task 4: Document findings and verify

**Files:**
- Create: `docs/development/desktop-rust-build-artifacts.md`

- [ ] **Step 1: Add documentation**

Document why debug artifacts are large, what changed, how to run dependency checks, and how to safely clean inactive worktree targets.

- [ ] **Step 2: Run focused verification**

Run:

```bash
node scripts/check-desktop-dependency-surface.mjs
node --test scripts/clean-inactive-worktree-targets.test.mjs
cargo test -p kordi-core slash_commands
cargo test -p kordi-tui slash_commands
cargo test -p kordi-cli desktop_runtime --no-default-features --features desktop-runtime
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo check -p kordi-desktop --no-default-features
```

Expected: all commands exit 0.

- [ ] **Step 3: Capture before/after measurement command**

Run:

```bash
cargo tree -p kordi-desktop --no-default-features | rg "kordi-tui|clap|crossterm" || true
```

Expected: no matches.
