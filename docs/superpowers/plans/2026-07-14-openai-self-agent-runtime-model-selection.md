# OpenAI Self-Agent Runtime Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GPT-5.6 Sol the root implicit OpenAI agent default and make canonical self-agent model selections update the exact Rust runtime session.

**Architecture:** Define the OpenAI default once in `kordi-core`, consume it from CLI startup and desktop auth paths, and expose the preferred startup route through the desktop agent profile instead of treating the currently resumed session model as the agent default. Route self-agent composer changes to their canonical session ID, and make the Rust command load or create that exact ID before applying model/thinking changes.

**Tech Stack:** Rust 2024/2021 workspace, Tauri 2, React 19, TypeScript, Node test runner, Cargo tests.

---

### Task 1: Centralize the root OpenAI default on GPT-5.6 Sol

**Files:**
- Modify: `agent/crates/core/src/agent_session/model_arg.rs`
- Modify: `agent/crates/core/src/agent_session/mod.rs`
- Modify: `agent/crates/cli/src/login/resolver/models.rs`
- Modify: `app/desktop/src-tauri/src/auth.rs`

- [ ] **Step 1: Write failing core and resolver tests**

Add tests proving an unspecified OpenAI model resolves to Sol and explicit choices remain explicit:

```rust
#[test]
fn openai_default_model_is_gpt_56_sol() {
    assert_eq!(parse_model_arg(Some("openai"), None).1, "gpt-5.6-sol");
    assert_eq!(parse_model_arg(Some("openai-codex"), None).1, "gpt-5.6-sol");
}

#[test]
fn explicit_openai_model_still_wins() {
    assert_eq!(parse_model_arg(Some("openai"), Some("gpt-5.4")).1, "gpt-5.4");
}
```

Update the OpenAI OAuth resolver assertions so unavailable/implicit model requests expect `gpt-5.6-sol`, and add an explicit `gpt-5.4` startup assertion that remains unchanged.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test -p kordi-core openai_default_model_is_gpt_56_sol -- --nocapture
cargo test -p kordi-cli login::resolver::models::tests::startup_fallback_uses_codex_compatible_model_when_openai_oauth_is_active -- --nocapture
```

Expected: both fail because current root defaults are GPT-5.4/GPT-5.5.

- [ ] **Step 3: Implement one shared root constant**

In `model_arg.rs`, define and use:

```rust
pub const DEFAULT_OPENAI_MODEL_ID: &str = "gpt-5.6-sol";
```

Re-export it from `agent_session::mod`, use it for the `openai` and `openai-codex` branches, consume it from `preferred_model_for_provider`, and replace the desktop Cloud auth snapshot fallback with the same constant. Keep provider-specific explicit settings and all non-OpenAI defaults unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cargo test -p kordi-core agent_session::model_arg -- --nocapture
cargo test -p kordi-cli login::resolver::models::tests -- --nocapture
cargo test -p kordi-desktop auth -- --nocapture
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/core/src/agent_session/model_arg.rs agent/crates/core/src/agent_session/mod.rs agent/crates/cli/src/login/resolver/models.rs app/desktop/src-tauri/src/auth.rs
git commit -m "fix: make GPT-5.6 Sol the OpenAI runtime default"
```

### Task 2: Make the Agent page inherit the preferred runtime route

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime/session_detail.rs`
- Modify: `app/desktop/tests/agentModelRouting.test.tsx`

- [ ] **Step 1: Write failing route-resolution tests**

Extract a small pure helper in the test target API and first test the intended behavior:

```rust
#[test]
fn agent_profile_prefers_root_default_over_current_session_model() {
    assert_eq!(
        agent_profile_default_route(
            "openai",
            "gpt-5.4",
            Some(("openai".to_string(), "gpt-5.6-sol".to_string())),
        ),
        ("openai".to_string(), "gpt-5.6-sol".to_string()),
    );
}

#[test]
fn agent_profile_falls_back_to_current_route_without_a_preference() {
    assert_eq!(
        agent_profile_default_route("ollama", "qwen3", None),
        ("ollama".to_string(), "qwen3".to_string()),
    );
}
```

Add a desktop routing assertion that a missing saved agent model inherits `openai/gpt-5.6-sol` from `DesktopChatState.localAgent`, while an explicit GPT-5.4 agent remains GPT-5.4.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p kordi-cli agent_profile_prefers_root_default_over_current_session_model -- --nocapture
pnpm --dir app/desktop exec tsx --test tests/agentModelRouting.test.tsx
```

Expected: the Rust test fails to compile because the helper does not exist; the desktop assertion documents the existing inheritance boundary.

- [ ] **Step 3: Resolve the profile default from root startup preferences**

Implement:

```rust
fn agent_profile_default_route(
    current_provider: &str,
    current_model: &str,
    preferred: Option<(String, String)>,
) -> (String, String) {
    preferred.unwrap_or_else(|| (current_provider.to_string(), current_model.to_string()))
}
```

In `build_agent_profile_from_setup`, load merged settings, call `preferred_startup_provider_and_model`, and populate `default_provider`/`default_model` from this helper. Keep the current session route in `last_activities`, so session state and agent-default state remain distinct.

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
cargo test -p kordi-cli desktop_runtime::session_detail::tests -- --nocapture
pnpm --dir app/desktop exec tsx --test tests/agentModelRouting.test.tsx
```

Expected: all tests pass; explicit saved agent routes remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/cli/src/desktop_runtime/session_detail.rs app/desktop/tests/agentModelRouting.test.tsx
git commit -m "fix: expose the root model as the agent default"
```

### Task 3: Route self-agent selections to the exact Rust runtime

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/tests/composerInputActions.test.tsx`
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/tests/desktopRuntimeModelSelection.test.mjs`

- [ ] **Step 1: Write failing frontend and Rust-source contract tests**

Add a pure target helper test:

```ts
assert.equal(localAgentComposerConfigTargetSessionId({
  id: 'local-shadow-id',
  canonicalSessionId: 'session:self-agent:cloud-id',
}), 'session:self-agent:cloud-id');
```

Also assert an empty canonical ID falls back to the local conversation ID.

Add a source-contract test that extracts `desktop_chat_update_session_config` and requires `ensure_loaded_or_create_explicit_session`, while rejecting `ensure_loaded_session` inside that command body.

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatSource = readFileSync(new URL('../src-tauri/src/chat.rs', import.meta.url), 'utf8');

test('desktop session config updates load or create the exact requested runtime', () => {
  const body = chatSource.match(
    /pub async fn desktop_chat_update_session_config[\s\S]*?(?=\n#\[tauri::command\])/
  )?.[0] ?? '';

  assert.match(body, /ensure_loaded_or_create_explicit_session/);
  assert.doesNotMatch(body, /ensure_loaded_session\(/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/composerInputActions.test.tsx tests/desktopRuntimeModelSelection.test.mjs
```

Expected: fail because the helper is absent and the Rust command still uses the fallback loader.

- [ ] **Step 3: Implement canonical self-agent targeting**

Export this helper from `ChatsPage.tsx`:

```ts
export function localAgentComposerConfigTargetSessionId(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>,
) {
  return conversation.canonicalSessionId?.trim() || conversation.id.trim() || null;
}
```

Use it for model, auth, and provider callbacks in both the main non-Bridge agent composer and the companion local-agent composer. Do not use it for human direct/group or Bridge-agent composers.

Change `desktop_chat_update_session_config` to resolve the command target with:

```rust
let target_session_id =
    ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
```

Preserve the running-turn guard, model/thinking compatibility logic, persisted session events, and authoritative rebuilt state.

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/composerInputActions.test.tsx tests/desktopRuntimeModelSelection.test.mjs
cargo test -p kordi-desktop chat::tests -- --nocapture
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/composerInputActions.test.tsx app/desktop/src-tauri/src/chat.rs app/desktop/tests/desktopRuntimeModelSelection.test.mjs
git commit -m "fix: update canonical self-agent runtime models"
```

### Task 4: Verify the integrated implementation

**Files:**
- Modify only if a verification failure exposes an in-scope defect.

- [ ] **Step 1: Format and run static checks**

Run:

```bash
cargo fmt --all -- --check
cargo clippy -p kordi-core -p kordi-cli -p kordi-desktop --all-targets -- -D warnings
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: all commands exit zero.

- [ ] **Step 2: Run focused and package tests**

Run:

```bash
cargo test -p kordi-core
cargo test -p kordi-cli
cargo test -p kordi-desktop
pnpm --dir app/desktop test:unit
```

Expected: all suites pass with zero failures.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors and no uncommitted implementation files.

### Task 5: Restart and verify the isolated feature instance

**Files:**
- No repository files.

- [ ] **Step 1: Stop only `user2` and preserve its data**

Use the multi-instance `stopInstance` helper without `--reset`.

- [ ] **Step 2: Relaunch with the local proxy**

Launch `user2` with `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` set to `http://127.0.0.1:7890`, `NO_PROXY=127.0.0.1,localhost,::1`, and the hosted API base set to `https://coordinar.io`.

- [ ] **Step 3: Verify runtime behavior**

Confirm the desktop process inherited the proxy, port `1484` returns HTTP 200, and the OpenAI token endpoint is reachable without a region-blocked response. In the canonical `My Kordi` self-agent session, select GPT-5.6 Sol and verify the selected state remains after desktop-state refresh and the session runtime reports `openai/gpt-5.6-sol`.

- [ ] **Step 4: Bring the feature window forward**

Leave the older `user1` instance and GCloud server untouched.
