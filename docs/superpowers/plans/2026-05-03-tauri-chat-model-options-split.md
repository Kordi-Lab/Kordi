# Tauri Chat Model Options Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` and centralize local provider default URL constants by extracting authenticated model-option enrichment helpers.

**Architecture:** Add `app/desktop/src-tauri/src/chat/model_options.rs` for authenticated model options, LM Studio/Ollama running model enrichment, local provider base URL lookup, and local provider port parsing. Keep `chat.rs` command behavior unchanged.

**Tech Stack:** Rust Tauri desktop crate, `kordi_core::settings::Settings`, local auth modules, existing Rust unit tests.

---

### Task 1: Extract local model-option helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/model_options.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write failing module-boundary test reference**

Added a test for provider override base URL selection that referenced `model_options::local_provider_base_url` and `model_options::LM_STUDIO_DEFAULT_BASE_URL` before the module existed.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-desktop chat::tests::local_provider_base_url_prefers_provider_override --no-default-features`

Observed: FAIL with unresolved `model_options` module/symbol errors.

- [x] **Step 3: Move model-option helpers into child module**

Moved authenticated model options, LM Studio/Ollama running model enrichment, local provider base URL lookup, and local provider port parsing into `chat/model_options.rs`. Added named default base URL constants for LM Studio and Ollama.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p kordi-desktop chat::model_options --no-default-features`

Observed: 1 test passed.

- [x] **Step 5: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/model_options.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-model-options-split.md
git commit -m "Extract Tauri chat model option helpers"
```
