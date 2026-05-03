# Tauri Chat Provider Readiness Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by moving local-provider readiness checks next to local provider model-option helpers.

**Architecture:** Move `ensure_provider_ready_for_send` into `app/desktop/src-tauri/src/chat/model_options.rs`, where local provider base URL and port helpers already live. Keep send/start command behavior unchanged by importing the helper from the child module.

**Tech Stack:** Rust Tauri desktop crate, LM Studio/Ollama auth helpers, existing chat tests.

---

### Task 1: Extract provider readiness helper

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Modify: `app/desktop/src-tauri/src/chat/model_options.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/chat.rs` that awaits `model_options::ensure_provider_ready_for_send("ollama", "", std::path::Path::new("."))` and expects an error containing `no local model is selected`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop chat::tests::model_options_reports_empty_local_model_before_server_check --no-default-features
```

Expected: FAIL with unresolved `ensure_provider_ready_for_send` in `model_options`.

- [x] **Step 3: Move provider readiness helper**

Move `ensure_provider_ready_for_send` from `chat.rs` into `chat/model_options.rs`, make it `pub(super)`, and keep using `local_provider_port` internally.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `model_options.rs`.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop chat::model_options --no-default-features
cargo test -p kordi-desktop chat --no-default-features
```

Expected: model options and chat tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/model_options.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-provider-readiness-split.md
git commit -m "Extract Tauri chat provider readiness helper"
```
