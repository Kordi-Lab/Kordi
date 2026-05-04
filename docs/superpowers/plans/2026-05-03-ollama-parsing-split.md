# Ollama Parsing Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/auth/ollama.rs` by extracting Ollama model/catalog parsing and model-id normalization helpers without changing desktop auth behavior.

**Architecture:** Add `app/desktop/src-tauri/src/auth/ollama/parsing.rs` as a child module. Keep Tauri command functions, process orchestration, and HTTP requests in `ollama.rs`; move pure model parsing, catalog parsing, model-id validation/normalization, and parser tests into the child module.

**Tech Stack:** Rust Tauri desktop crate, `serde_json`, existing Ollama auth tests.

---

### Task 1: Extract pure Ollama parsing helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/auth/ollama.rs`
- Create: `app/desktop/src-tauri/src/auth/ollama/parsing.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/auth/ollama.rs` that references `parsing::canonical_ollama_model_id("llama3.2")` and expects `"llama3.2:latest"`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop auth::ollama::tests::parsing_module_canonicalizes_implicit_latest --no-default-features
```

Expected: FAIL with unresolved `parsing` module/symbol error.

- [x] **Step 3: Move parsing helpers into child module**

Create `app/desktop/src-tauri/src/auth/ollama/parsing.rs` and move:

- `collect_ollama_model_ids`
- `collect_installed_models`
- `filter_running_model_ids_to_installed`
- `installed_model_from_object`
- `is_ollama_chat_model_object`
- `is_embedding_family`
- `is_embedding_model_id`
- `sanitize_chat_model_arg`
- `sanitize_model_arg`
- `is_safe_model_id`
- `canonical_ollama_model_id`
- `parse_ollama_catalog_models`
- `parse_ollama_catalog_variants`
- `attr_after`
- `first_paragraph_text`
- `collect_badge_values`
- `test_value`
- `first_size_text`
- `first_context_text`
- `first_input_text`
- `first_token_with_suffix`
- `string_field`
- `size_field`
- `format_bytes`
- `html_text`

Expose only helpers used by `ollama.rs` as `pub(super)` and keep internal parsing helpers private.

- [x] **Step 4: Move parser-focused tests**

Move these existing tests from root into `parsing.rs`:

- `running_model_filter_excludes_deleted_stale_runtime_entries`
- `running_model_filter_matches_implicit_latest_installed_models`
- `installed_model_parser_excludes_embedding_models`
- `running_model_parser_canonicalizes_and_excludes_embeddings`
- `catalog_parser_skips_embedding_families`
- `tag_parser_extracts_exact_variants`

Move the Step 1 temporary/root test into the new module.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop auth::ollama --no-default-features
```

Expected: all Ollama auth tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop auth::ollama --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/auth/ollama.rs app/desktop/src-tauri/src/auth/ollama/parsing.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-ollama-parsing-split.md
git commit -m "Extract Ollama parsing helpers"
```
