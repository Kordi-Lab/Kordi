# Tauri Chat Bridge Agent Runner Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by extracting Bridge-agent execution routing into a focused module without changing Tauri command behavior.

**Architecture:** Add `app/desktop/src-tauri/src/chat/bridge_agent_runner.rs` for temporary Bridge agent execution sessions, route normalization, fallback selection, and `run_bridge_agent_prompt`. Re-export the existing crate-visible runner API from `chat.rs` so Bridge mailbox call sites remain unchanged.

**Tech Stack:** Rust Tauri desktop crate, `DesktopRuntimeSession`, existing turn snapshot helpers, existing Rust unit tests.

---

### Task 1: Extract Bridge agent runner

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/bridge_agent_runner.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test reference**

In `app/desktop/src-tauri/src/chat.rs`, update `bridge_agent_fallback_route_distinguishes_auth_choice_from_default_route` to use `bridge_agent_runner::BridgeAgentRunRoute` and `bridge_agent_runner::should_try_bridge_agent_fallback`. This proves the new module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-desktop chat::tests::bridge_agent_fallback_route_distinguishes_auth_choice_from_default_route --no-default-features`

Expected: FAIL with an unresolved `bridge_agent_runner` module/symbol error.

- [x] **Step 3: Move Bridge agent runner into child module**

Create `app/desktop/src-tauri/src/chat/bridge_agent_runner.rs` with:
- `DesktopBridgeAgentModelRouting`
- `BridgeAgentRunRoute`
- `normalize_bridge_agent_routing_value`
- `bridge_agent_route_key`
- `should_try_bridge_agent_fallback`
- `ensure_bridge_agent_execution_session`
- `run_bridge_agent_prompt_once`
- `run_bridge_agent_prompt`
- moved fallback route test

In `app/desktop/src-tauri/src/chat.rs`:
- add `mod bridge_agent_runner;`
- add `pub(crate) use bridge_agent_runner::{run_bridge_agent_prompt, DesktopBridgeAgentModelRouting};`
- remove moved runner code/test from the root module.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p kordi-desktop chat::bridge_agent_runner --no-default-features`

Expected: Bridge agent runner tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Desktop Rust chat disposition should mention Bridge-agent runner extraction.
- Completed slices should include the runner split.

- [x] **Step 6: Run slice verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
```

Expected: chat tests PASS; formatting and whitespace checks pass; scan shows `chat.rs` reduced.

- [ ] **Step 7: Commit**

Run:

```bash
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/bridge_agent_runner.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-bridge-agent-runner-split.md
git commit -m "Extract Tauri chat bridge agent runner"
```
