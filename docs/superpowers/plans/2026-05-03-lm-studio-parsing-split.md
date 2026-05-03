# LM Studio Parsing Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/auth/lm_studio.rs` by extracting LM Studio catalog/model parsing and model-id normalization helpers without changing desktop auth behavior.

**Architecture:** Add `app/desktop/src-tauri/src/auth/lm_studio/parsing.rs` as a child module of the existing Tauri auth module. Keep Tauri command functions and process/network orchestration in `lm_studio.rs`; move pure parsing, JSON traversal, HTML text normalization, model-id safety/normalization, and parser-focused tests into the child module.

**Tech Stack:** Rust Tauri desktop crate, `serde_json`, existing LM Studio auth tests.

---

### Task 1: Extract pure LM Studio parsing helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/auth/lm_studio.rs`
- Create: `app/desktop/src-tauri/src/auth/lm_studio/parsing.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/auth/lm_studio.rs` that references `parsing::canonical_lm_studio_model_id("google/gemma-4-e4b:6")` and expects `"google/gemma-4-e4b"`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop auth::lm_studio::tests::parsing_module_strips_numeric_runtime_suffix --no-default-features
```

Expected: FAIL with unresolved `parsing` module/symbol error.

- [x] **Step 3: Move parsing helpers into child module**

Create `app/desktop/src-tauri/src/auth/lm_studio/parsing.rs` and move:

- `LmStudioLoadedModelInstance`
- `parse_catalog_models`
- `parse_catalog_variants`
- `extract_after`
- `extract_model_sizes`
- `extract_updated`
- `html_text`
- `parse_installed_models`
- `parse_model_ids`
- `parse_loaded_model_instances`
- `collect_installed_models`
- `collect_model_ids`
- `collect_rest_loaded_llm_model_ids`
- `collect_loaded_model_instances`
- `loaded_model_instance_from_object`
- `model_max_context_length_from_value`
- `object_matches_lm_studio_model`
- `installed_model_from_object`
- `string_field`
- `is_lm_studio_chat_model_object`
- `is_lm_studio_embedding_model_id`
- `u64_field`
- `context_length_field`
- `max_context_length_field`
- `size_field`
- `format_bytes`
- `canonical_lm_studio_model_id`
- `lm_studio_model_match_key`
- `lm_studio_model_ids_match`
- `is_safe_model_id`
- `sanitize_model_arg`

Expose only the functions/types used by `lm_studio.rs` as `pub(super)` and keep helper-only functions private.

- [x] **Step 4: Move parser-focused tests**

Move these existing tests from the root test module into `parsing.rs`:

- `lms_ps_parser_prefers_canonical_model_key_over_runtime_identifier`
- `embedding_models_are_excluded_from_chat_model_ids`
- `rest_loaded_model_parser_keeps_only_loaded_llms`
- `lms_ps_parser_captures_context_lengths_for_reload_decisions`
- `installed_model_max_context_matches_base_and_variant_ids`
- `lm_studio_model_matching_ignores_runtime_suffix_and_variant_suffix`
- `canonical_lm_studio_model_id_strips_numeric_runtime_suffix`

Move the Step 1 temporary/root test into the parsing module or remove it once covered by the existing canonical-id test.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop auth::lm_studio --no-default-features
```

Expected: all LM Studio auth tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop auth::lm_studio --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/auth/lm_studio.rs app/desktop/src-tauri/src/auth/lm_studio/parsing.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-lm-studio-parsing-split.md
git commit -m "Extract LM Studio parsing helpers"
```
