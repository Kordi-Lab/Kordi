# Tauri Chat Bridge Outreach Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by extracting Bridge outreach mention gating and reach_out runtime installation helpers without changing message-send behavior.

**Architecture:** Add `app/desktop/src-tauri/src/chat/bridge_outreach.rs` for Bridge session directory sanitization, Bridge-agent session cwd derivation, local/non-local mention detection, prompt-context application, and reach_out runtime wiring. Keep Tauri command functions in `chat.rs`; import the helper used before send/start.

**Tech Stack:** Rust Tauri desktop crate, Bridge manager, desktop runtime session, existing chat tests.

---

### Task 1: Extract Bridge outreach helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/bridge_outreach.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/chat.rs` that references `bridge_outreach::text_mentions_non_local_target("@Kordi hi", &["Kordi".to_string()])` and expects `false`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop chat::tests::bridge_outreach_module_ignores_local_agent_mentions --no-default-features
```

Expected: FAIL with unresolved `bridge_outreach` module/symbol error.

- [x] **Step 3: Move Bridge outreach helpers into child module**

Create `app/desktop/src-tauri/src/chat/bridge_outreach.rs` and move:

- `sanitize_bridge_segment`
- `bridge_agent_session_cwd`
- `normalize_mention_label`
- `mention_text_starts_with_label`
- `text_explicitly_mentions_label`
- `local_agent_mention_labels`
- `text_mentions_non_local_target`
- `text_mentions_local_agent`
- `reach_out_target_allowed_by_user_text`
- `prepare_desktop_session_for_send`
- `install_reach_out_runtime`

Re-export `bridge_agent_session_cwd` from the root module for the existing Bridge-agent runner child module.

- [x] **Step 4: Move outreach tests**

Move these existing tests from root into `bridge_outreach.rs`:

- `local_agent_mentions_do_not_enable_bridge_outreach`
- `reach_out_requires_current_explicit_non_local_target`

Move the Step 1 temporary/root test into the new module or remove it once covered by the existing local-agent mention test.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop chat --no-default-features
```

Expected: all chat tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/bridge_outreach.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-bridge-outreach-split.md
git commit -m "Extract Tauri chat bridge outreach helpers"
```
