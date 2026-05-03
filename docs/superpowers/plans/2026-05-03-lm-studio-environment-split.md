# LM Studio Environment Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `app/desktop/src-tauri/src/auth/lm_studio.rs` below the overlong-file threshold by extracting LM Studio environment/path discovery helpers without changing command behavior.

**Architecture:** Add `app/desktop/src-tauri/src/auth/lm_studio/environment.rs` for environment DTO assembly, CLI path resolution, LM Studio app/home/bin discovery, plist version parsing, shell PATH repair helpers, and path formatting. Keep Tauri command functions and network/process orchestration in `lm_studio.rs`; import environment helpers from the child module.

**Tech Stack:** Rust Tauri desktop crate, standard library file/process helpers, existing LM Studio auth tests.

---

### Task 1: Extract LM Studio environment helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/auth/lm_studio.rs`
- Create: `app/desktop/src-tauri/src/auth/lm_studio/environment.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/auth/lm_studio.rs` that references `environment::plist_string_value("<key>CFBundleVersion</key><string>1&amp;2</string>", "CFBundleVersion")` and expects `Some("1&2".to_string())`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop auth::lm_studio::tests::environment_module_decodes_plist_string_values --no-default-features
```

Expected: FAIL with unresolved `environment` module/symbol error.

- [x] **Step 3: Move environment helpers into child module**

Create `app/desktop/src-tauri/src/auth/lm_studio/environment.rs` and move:

- `lm_studio_environment`
- `ResolvedCommandPath`
- `lms_command`
- `resolve_lms_path`
- `find_lm_studio_home_dir`
- `find_lm_studio_bin_dir`
- `find_lm_studio_app_path`
- `lm_studio_app_version`
- `plist_string_value`
- `lms_version`
- `shell_command_path`
- `add_lm_studio_bin_to_shell_path`
- `shell_configs_containing_path`
- `home_dir`
- `path_to_string`

Expose only helpers used by `lm_studio.rs` as `pub(super)` and keep path-detail helpers private.

- [x] **Step 4: Move the plist test into the child module**

Move the Step 1 temporary/root test into `environment.rs` so environment parsing coverage lives with the extracted helper.

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
git add app/desktop/src-tauri/src/auth/lm_studio.rs app/desktop/src-tauri/src/auth/lm_studio/environment.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-lm-studio-environment-split.md
git commit -m "Extract LM Studio environment helpers"
```
