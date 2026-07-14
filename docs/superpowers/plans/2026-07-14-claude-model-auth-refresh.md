# Claude Model and Authentication Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Kordi's Claude catalog, centralize model-specific request behavior, and harden Anthropic environment and OAuth authentication while preserving existing saved profiles.

**Architecture:** Put Claude model behavior in one provider-owned capability module. The registry, CLI selection, runtime thinking controls, and pure request-body builder consume that contract. Keep credential precedence in the CLI resolver and isolate OAuth sequencing, state validation, and expiry calculations behind small testable helpers.

**Tech Stack:** Rust 2024, Tokio, Reqwest, Serde/serde_json, Cargo tests

---

## Guardrails

- Work only in `/Users/shuyang/kordi/.worktrees/issue-678-claude-model-auth` on branch `agent/claude-model-auth-refresh`.
- Keep issue #674's macOS proxy work, Authentication page layout, updater behavior, and other provider catalogs out of scope.
- Do not add a temperature field to `CompletionRequest`; request tests only verify that no unsupported field is emitted.
- Preserve unknown live Claude IDs through Kordi's existing provider-correct runtime synthesis.
- Preserve separate saved OAuth and API-key profiles and explicit user selections.
- Describe Kordi's behavior directly in code comments, commits, issue text, and PR text without naming comparison repositories.
- Run each red test before its implementation and record the expected failure in the task notes.

## Task 1: Add the Claude capability contract and reconcile the built-in catalog

**Files:**

- Create: `agent/crates/provider/src/anthropic/capabilities.rs`
- Modify: `agent/crates/provider/src/anthropic.rs:1-12`
- Modify: `agent/crates/provider/src/registry/models/anthropic.rs:1-140`

- [ ] **Step 1: Add failing capability tests**

Create `agent/crates/provider/src/anthropic/capabilities.rs` with a test module that describes the public contract before adding the implementation:

```rust
#[cfg(test)]
mod tests {
    use super::{
        ClaudeThinkingMode, ThinkingOffBehavior,
        capabilities_for_model, clamp_thinking_level,
    };
    use kordi_core::agent_session::ThinkingLevel;

    #[test]
    fn current_adaptive_families_have_explicit_capabilities() {
        let opus_48 = capabilities_for_model("claude-opus-4-8").unwrap();
        assert_eq!(opus_48.thinking_mode, ClaudeThinkingMode::Adaptive);
        assert!(opus_48.native_xhigh);
        assert!(opus_48.supports_max);
        assert!(!opus_48.supports_temperature);
        assert_eq!(opus_48.thinking_off, ThinkingOffBehavior::Disabled);

        let sonnet_5 = capabilities_for_model("claude-sonnet-5").unwrap();
        assert_eq!(sonnet_5.thinking_mode, ClaudeThinkingMode::Adaptive);
        assert!(sonnet_5.native_xhigh);
        assert!(sonnet_5.supports_temperature);

        let fable_5 = capabilities_for_model("claude-fable-5").unwrap();
        assert_eq!(fable_5.thinking_mode, ClaudeThinkingMode::Adaptive);
        assert!(fable_5.native_xhigh);
        assert_eq!(fable_5.thinking_off, ThinkingOffBehavior::Omit);
    }

    #[test]
    fn legacy_and_unknown_models_stay_conservative() {
        let opus_45 = capabilities_for_model("claude-opus-4-5").unwrap();
        assert_eq!(opus_45.thinking_mode, ClaudeThinkingMode::Budget);
        assert!(!opus_45.native_xhigh);
        assert!(capabilities_for_model("claude-future-live-id").is_none());
        assert_eq!(
            clamp_thinking_level("claude-opus-4-5", ThinkingLevel::Max),
            Some(ThinkingLevel::High),
        );
    }
}
```

Expose the module at the top of `agent/crates/provider/src/anthropic.rs`:

```rust
pub mod capabilities;
mod events;
```

- [ ] **Step 2: Run the capability tests and confirm RED**

Run:

```bash
cargo test -p kordi-provider anthropic::capabilities::tests -- --nocapture
```

Expected: compilation fails because the capability types and functions imported by the tests do not exist yet.

- [ ] **Step 3: Implement the smallest complete capability table**

Add these public types and constants in `capabilities.rs`:

```rust
use kordi_core::agent_session::ThinkingLevel;

pub const DEFAULT_ANTHROPIC_MODEL_ID: &str = "claude-opus-4-8";

pub const ANTHROPIC_SUBSCRIPTION_MODEL_IDS: &[&str] = &[
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeThinkingMode {
    Adaptive,
    Budget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingOffBehavior {
    Disabled,
    Omit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaudeModelCapabilities {
    pub thinking_mode: ClaudeThinkingMode,
    pub native_xhigh: bool,
    pub supports_max: bool,
    pub supports_temperature: bool,
    pub thinking_off: ThinkingOffBehavior,
}
```

Implement `capabilities_for_model`, `thinking_levels`, `clamp_thinking_level`, and `adaptive_effort`. Match exact aliases and dated IDs from `ANTHROPIC_SUBSCRIPTION_MODEL_IDS`; return `None` for unknown live IDs. Use this exact matrix:

| IDs | Thinking mode | Exposed levels | Temperature | Off payload |
|---|---|---|---|---|
| Fable 5 | Adaptive | minimal, low, medium, high, xhigh, max | Supported | Omit |
| Opus 4.6, Sonnet 4.6 | Adaptive | off, minimal, low, medium, high, max | Supported | Disabled |
| Opus 4.7, Opus 4.8 | Adaptive | off, minimal, low, medium, high, xhigh, max | Unsupported | Disabled |
| Sonnet 5 | Adaptive | off, minimal, low, medium, high, xhigh, max | Supported | Disabled |
| Haiku 4.5, Opus 4.1/4.5, Sonnet 4.5 aliases and dated IDs | Budget | off, minimal, low, medium, high | Supported | Disabled |

For adaptive requests, map `minimal` and `low` to `low`, preserve `medium`, `high`, and native `xhigh`, and map `max` to `max`. Clamp unsupported `xhigh` to `high`; preserve `max` for Opus 4.6 and Sonnet 4.6. Preserve an explicit stored `off` for Fable 5 even though it is hidden from the exposed level list, allowing request construction to omit the disabled payload.

- [ ] **Step 4: Run the capability tests and confirm GREEN**

Run:

```bash
cargo test -p kordi-provider anthropic::capabilities::tests -- --nocapture
```

Expected: all capability tests pass.

- [ ] **Step 5: Add an exact failing registry contract test**

Append tests to `agent/crates/provider/src/registry/models/anthropic.rs` that assert the 14 IDs are exactly the shared ordered list and that representative metadata is correct:

```rust
#[cfg(test)]
mod tests {
    use super::builtin_models;
    use crate::anthropic::capabilities::{
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS, DEFAULT_ANTHROPIC_MODEL_ID,
    };
    use crate::registry::ModelInput;

    #[test]
    fn builtin_catalog_matches_the_supported_claude_contract() {
        let models = builtin_models();
        let ids = models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, ANTHROPIC_SUBSCRIPTION_MODEL_IDS.to_vec());
        assert!(ids.contains(&DEFAULT_ANTHROPIC_MODEL_ID));
        assert!(models.iter().all(|model| model.reasoning));
        assert!(models.iter().all(|model| {
            model.input == vec![ModelInput::Text, ModelInput::Image]
        }));
    }

    #[test]
    fn current_catalog_metadata_is_kept_together_with_model_ids() {
        let models = builtin_models();
        let opus_48 = models.iter().find(|model| model.id == "claude-opus-4-8").unwrap();
        assert_eq!((opus_48.context_window, opus_48.max_tokens), (1_000_000, 128_000));
        assert_eq!((opus_48.cost.input, opus_48.cost.output), (5.0, 25.0));

        let sonnet_5 = models.iter().find(|model| model.id == "claude-sonnet-5").unwrap();
        assert_eq!((sonnet_5.context_window, sonnet_5.max_tokens), (1_000_000, 128_000));
        assert_eq!((sonnet_5.cost.input, sonnet_5.cost.output), (2.0, 10.0));

        let fable_5 = models.iter().find(|model| model.id == "claude-fable-5").unwrap();
        assert_eq!((fable_5.context_window, fable_5.max_tokens), (1_000_000, 128_000));
        assert_eq!((fable_5.cost.input, fable_5.cost.output), (10.0, 50.0));
    }
}
```

- [ ] **Step 6: Run the registry test and confirm RED**

Run:

```bash
cargo test -p kordi-provider builtin_catalog_matches_the_supported_claude_contract -- --nocapture
```

Expected: the test reports the old 10-model catalog and old ordering.

- [ ] **Step 7: Replace the built-in catalog**

Replace `builtin_models()` with the shared order and these exact display names:

| ID | Display name |
|---|---|
| `claude-fable-5` | Claude Fable 5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 (latest) |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-opus-4-1` | Claude Opus 4.1 (latest) |
| `claude-opus-4-1-20250805` | Claude Opus 4.1 |
| `claude-opus-4-5` | Claude Opus 4.5 (latest) |
| `claude-opus-4-5-20251101` | Claude Opus 4.5 |
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-opus-4-7` | Claude Opus 4.7 |
| `claude-opus-4-8` | Claude Opus 4.8 |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 (latest) |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-sonnet-5` | Claude Sonnet 5 |

Use these exact metadata groups:

| IDs | Context | Max output | Input/output cost | Cache read/write cost |
|---|---:|---:|---:|---:|
| Fable 5 | 1,000,000 | 128,000 | 10 / 50 | 1 / 12.5 |
| Haiku 4.5 alias + dated | 200,000 | 64,000 | 1 / 5 | 0.1 / 1.25 |
| Opus 4.1 alias + dated | 200,000 | 32,000 | 15 / 75 | 1.5 / 18.75 |
| Opus 4.5 alias + dated | 200,000 | 64,000 | 5 / 25 | 0.5 / 6.25 |
| Opus 4.6/4.7/4.8 | 1,000,000 | 128,000 | 5 / 25 | 0.5 / 6.25 |
| Sonnet 4.5 alias + dated | 1,000,000 | 64,000 | 3 / 15 | 0.3 / 3.75 |
| Sonnet 4.6 | 1,000,000 | 128,000 | 3 / 15 | 0.3 / 3.75 |
| Sonnet 5 | 1,000,000 | 128,000 | 2 / 10 | 0.2 / 2.5 |

Use `model(...)` for every entry so text/image input, reasoning support, Anthropic Messages API, and `https://api.anthropic.com` remain uniform.

- [ ] **Step 8: Run provider tests and commit**

Run:

```bash
cargo test -p kordi-provider anthropic -- --nocapture
cargo test -p kordi-provider registry -- --nocapture
```

Expected: both commands pass.

Commit:

```bash
git add agent/crates/provider/src/anthropic.rs agent/crates/provider/src/anthropic/capabilities.rs agent/crates/provider/src/registry/models/anthropic.rs
git commit -m "feat: refresh Claude model capabilities"
```

## Task 2: Make CLI selection, live ordering, and thinking controls consume the provider contract

**Files:**

- Modify: `agent/crates/cli/src/login/resolver/models.rs:1-220,340-520`
- Modify: `agent/crates/cli/src/runtime_model.rs:320-475,530-680`
- Modify: `agent/crates/cli/src/live_models.rs:120-220` and its test module

- [ ] **Step 1: Add failing resolver and live-order tests**

Update the Anthropic OAuth test in `resolver/models.rs` to assert the complete shared order and default:

```rust
assert_eq!(
    model_ids,
    kordi_provider::anthropic::capabilities::ANTHROPIC_SUBSCRIPTION_MODEL_IDS
        .iter()
        .map(|id| (*id).to_string())
        .collect::<Vec<_>>(),
);
assert_eq!(
    available_model_for_provider(&Settings::default(), "anthropic", None),
    Some("claude-opus-4-8".to_string()),
);
assert_eq!(model_catalog_rank("anthropic", "claude-opus-4-8"), 9);
```

Add a `live_models.rs` test that merges a legacy live ID with the static Anthropic list and asserts the 14 curated IDs keep their shared order while the legacy live ID remains selectable after them.

- [ ] **Step 2: Run the resolver/live tests and confirm RED**

Run:

```bash
cargo test -p kordi-cli anthropic_oauth_candidates_exclude_api_only_models --lib -- --nocapture
cargo test -p kordi-cli merge_live_model_ids --lib -- --nocapture
```

Expected: the resolver still uses its private stale allowlist/default and live merging sorts only by ID.

- [ ] **Step 3: Remove duplicated model policy**

In `resolver/models.rs`:

```rust
use kordi_provider::anthropic::capabilities::{
    ANTHROPIC_SUBSCRIPTION_MODEL_IDS, DEFAULT_ANTHROPIC_MODEL_ID,
};
```

- Delete the local `ANTHROPIC_OAUTH_MODEL_IDS`.
- Return `ANTHROPIC_SUBSCRIPTION_MODEL_IDS` from `active_oauth_model_ids_for_provider`.
- Rank Anthropic IDs with the same constant in `model_catalog_rank`.
- Return `DEFAULT_ANTHROPIC_MODEL_ID` from `preferred_model_for_provider("anthropic")`.
- Extend the test environment helper to unset `ANTHROPIC_OAUTH_TOKEN` as well as `ANTHROPIC_API_KEY`.

In `live_models.rs`, sort by curated rank before the stable ID fallback:

```rust
merged.sort_by(|left, right| {
    login::model_catalog_rank(provider, &left.id)
        .cmp(&login::model_catalog_rank(provider, &right.id))
        .then_with(|| left.id.cmp(&right.id))
});
```

- [ ] **Step 4: Add failing runtime thinking tests**

Add tests in `runtime_model.rs` that obtain current models from `ModelRegistry` and assert:

```rust
assert_eq!(
    request_thinking_value(opus_48, None, ThinkingLevel::Off).as_deref(),
    Some("off"),
);
assert_eq!(
    effective_thinking_level_for_model(opus_48, None, ThinkingLevel::Max),
    ThinkingLevel::Max,
);
assert_eq!(
    effective_thinking_level_for_model(opus_46, None, ThinkingLevel::XHigh),
    ThinkingLevel::High,
);
assert_eq!(
    effective_thinking_level_for_model(opus_46, None, ThinkingLevel::Max),
    ThinkingLevel::Max,
);
assert_eq!(
    effective_thinking_level_for_model(unknown_claude, None, ThinkingLevel::Max),
    ThinkingLevel::High,
);
```

- [ ] **Step 5: Run the thinking tests and confirm RED**

Run:

```bash
cargo test -p kordi-cli request_thinking --lib -- --nocapture
```

Expected: Anthropic `off` is currently omitted and current models are controlled by scattered substring checks.

- [ ] **Step 6: Route Anthropic thinking through the capability module**

Before the generic provider logic in `thinking_levels_for_model` and `effective_thinking_level_for_model`, add an Anthropic branch:

```rust
let provider = login::normalize_provider_for_model_selection(&model.provider);
if model.reasoning && provider == "anthropic" {
    if let Some(levels) =
        kordi_provider::anthropic::capabilities::thinking_levels(&model.id)
    {
        return levels;
    }
}
```

Use `clamp_thinking_level` for known Claude IDs. Keep the existing generic standard fallback for unknown synthesized Claude IDs. In `request_thinking_value`, forward `off` for a reasoning-capable Anthropic model so the provider body builder can apply its per-model disabled-or-omitted rule. Remove Claude-specific checks from `supports_xhigh`.

- [ ] **Step 7: Run focused CLI tests and commit**

Run:

```bash
cargo test -p kordi-cli login::resolver::models::tests --lib -- --nocapture
cargo test -p kordi-cli runtime_model::tests --lib -- --nocapture
cargo test -p kordi-cli live_models::tests --lib -- --nocapture
```

Expected: all focused CLI tests pass.

Commit:

```bash
git add agent/crates/cli/src/login/resolver/models.rs agent/crates/cli/src/runtime_model.rs agent/crates/cli/src/live_models.rs
git commit -m "feat: align Claude selection and thinking controls"
```

## Task 3: Extract and test model-aware Anthropic request construction

**Files:**

- Modify: `agent/crates/provider/src/anthropic.rs:45-155,250-420`

- [ ] **Step 1: Add request fixtures and failing body tests**

In the existing `anthropic.rs` test module, add a request helper and a body helper call:

```rust
fn request(model: &str, thinking: Option<&str>) -> CompletionRequest {
    CompletionRequest {
        system_prompt: "Be precise".to_string(),
        messages: vec![json!({"role": "user", "content": "hello"})],
        tools: Vec::new(),
        extra_tool_schemas: Vec::new(),
        model: model.to_string(),
        max_tokens: Some(16_384),
        stream: true,
        thinking: thinking.map(ToString::to_string),
    }
}
```

Add separate tests for these exact contracts:

- Opus 4.6: adaptive thinking, summarized display, `high` when `xhigh` is clamped, and `max` for explicit `max`.
- Opus 4.7 and 4.8: adaptive thinking, summarized display, native `xhigh`, explicit `max`, and no `temperature` key.
- Sonnet 5 and Fable 5: adaptive thinking with native `xhigh` and explicit `max` preserved.
- Fable 5 with `off`: no `thinking` key.
- Opus 4.8 with `off`: `{"type":"disabled"}`.
- Opus 4.5 with `high`: budget thinking with `budget_tokens: 16384` and a raised `max_tokens` when needed.
- Unknown live ID: never receives adaptive-only fields.
- OAuth: Claude Code identity system block remains first; API-key mode does not add it.

The Opus 4.8 assertion should include:

```rust
assert_eq!(body["thinking"], json!({"type": "adaptive", "display": "summarized"}));
assert_eq!(body["output_config"], json!({"effort": "xhigh"}));
assert!(body.get("temperature").is_none());
```

- [ ] **Step 2: Run body tests and confirm RED**

Run:

```bash
cargo test -p kordi-provider anthropic::tests -- --nocapture
```

Expected: tests fail because no pure body helper exists and current adaptive payloads lack summarized display and current model rules.

- [ ] **Step 3: Extract the pure request-body builder**

Add:

```rust
fn build_anthropic_request_body(
    request: &CompletionRequest,
    auth_mode: ProviderAuthMode,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Value
```

Move system, tools, maximum output, and thinking JSON construction into this helper. Keep cache-control application and tool conversion before the call in `stream`, then use:

```rust
let body = build_anthropic_request_body(
    &request,
    options.auth_mode,
    messages,
    tools,
);
```

For explicit `off`, use `ThinkingOffBehavior`; for adaptive requests, use `adaptive_effort` and emit:

```rust
body["thinking"] = json!({
    "type": "adaptive",
    "display": "summarized",
});
body["output_config"] = json!({ "effort": effort });
```

For known budget models and conservative unknown IDs, keep the existing budget mapping. Do not add a temperature field anywhere.

- [ ] **Step 4: Run provider tests and commit**

Run:

```bash
cargo test -p kordi-provider anthropic::tests -- --nocapture
cargo test -p kordi-provider --lib
```

Expected: all provider tests pass.

Commit:

```bash
git add agent/crates/provider/src/anthropic.rs
git commit -m "feat: build model-aware Anthropic requests"
```

## Task 4: Add Anthropic OAuth environment credentials with deterministic precedence

**Files:**

- Modify: `agent/crates/cli/src/login/resolver/auth_sources.rs:1-150,350-560`
- Modify: `agent/crates/cli/src/login/resolver/oauth_refresh.rs:90-270,630-900`

- [ ] **Step 1: Add failing environment discovery and status tests**

In `auth_sources.rs`, add guarded tests that set both Anthropic variables and assert:

```rust
let summaries = provider_auth_option_summaries("anthropic");
assert_eq!(summaries.len(), 2);
assert!(summaries.iter().any(|summary| {
    summary.source == AuthSource::EnvVar
        && summary.method == ProviderAuthMethod::OAuth
}));
assert!(summaries.iter().any(|summary| {
    summary.source == AuthSource::EnvVar
        && summary.method == ProviderAuthMethod::ApiKey
}));
assert_eq!(
    provider_auth_status_summary("anthropic"),
    "[OAuth + API key configured] • active: OAuth",
);
```

Use the existing global auth environment mutex and RAII guards for `HOME`, `ANTHROPIC_OAUTH_TOKEN`, and `ANTHROPIC_API_KEY`.

- [ ] **Step 2: Add failing resolver precedence tests**

In `oauth_refresh.rs`, cover all precedence boundaries:

1. With both environment variables and an empty store, `resolve_provider_auth("anthropic")` returns OAuth and the OAuth token.
2. `resolve_provider_auth_choice("anthropic", "env:api-key")` returns the API key even when the OAuth token exists.
3. An explicitly active saved API-key profile wins over both environment variables.
4. An explicitly active saved OAuth profile wins over both environment variables.
5. Environment OAuth auth has `credential_provider == "anthropic-oauth"` and `method == OAuth`.

- [ ] **Step 3: Run auth tests and confirm RED**

Run:

```bash
cargo test -p kordi-cli anthropic_environment --lib -- --nocapture
cargo test -p kordi-cli resolves_anthropic --lib -- --nocapture
```

Expected: OAuth environment discovery and resolution fail because only `ANTHROPIC_API_KEY` is recognized.

- [ ] **Step 4: Implement discovery and precedence**

In `env_auth_methods_for_provider`, build the Anthropic methods in OAuth-then-API-key order when their trimmed values are non-empty.

In `resolve_env_provider_auth`, add:

```rust
("anthropic", ProviderAuthMethod::OAuth) => std::env::var("ANTHROPIC_OAUTH_TOKEN")
    .ok()
    .filter(|value| !value.trim().is_empty())
    .map(|credential| ResolvedProviderAuth {
        source: AuthSource::EnvVar,
        credential_provider: provider_storage_key(&normalized, method),
        method,
        credential,
        account_id: None,
        account_label: None,
        authority: None,
    }),
```

Resolve saved explicit profile/method choices before automatic environment fallback. When no explicit choice exists, try environment methods in this order:

```rust
[ProviderAuthMethod::OAuth, ProviderAuthMethod::ApiKey]
```

Retain `resolve_provider_auth_choice` as the explicit environment-method path.

- [ ] **Step 5: Run auth tests and commit**

Run:

```bash
cargo test -p kordi-cli login::resolver::auth_sources::tests --lib -- --nocapture
cargo test -p kordi-cli login::resolver::oauth_refresh::tests --lib -- --nocapture
```

Expected: all resolver and status tests pass, including existing saved-profile tests.

Commit:

```bash
git add agent/crates/cli/src/login/resolver/auth_sources.rs agent/crates/cli/src/login/resolver/oauth_refresh.rs
git commit -m "feat: support Anthropic OAuth environment auth"
```

## Task 5: Harden Anthropic OAuth sequencing, state validation, and expiry

**Files:**

- Modify: `agent/crates/cli/src/oauth/anthropic.rs:1-270`

- [ ] **Step 1: Add failing pure-helper tests**

Add a `#[cfg(test)]` module covering:

```rust
#[test]
fn callback_state_must_match_the_generated_state() {
    let matching = CallbackParams {
        code: "auth-code".to_string(),
        state: "expected-state".to_string(),
    };
    assert!(validate_callback_state(matching, "expected-state").is_ok());

    let mismatched = CallbackParams {
        code: "auth-code".to_string(),
        state: "wrong-state".to_string(),
    };
    let error = validate_callback_state(mismatched, "expected-state").unwrap_err();
    assert_eq!(error.to_string(), "Anthropic OAuth state mismatch");
}

#[test]
fn token_expiry_reserves_five_minutes_without_going_backwards() {
    assert_eq!(buffered_expiry_ms(1_000_000, 3_600), 4_300_000);
    assert_eq!(buffered_expiry_ms(1_000_000, 120), 1_000_000);
}

#[test]
fn refresh_body_does_not_send_scope() {
    let body = refresh_token_body("refresh-token");
    assert_eq!(body["grant_type"], "refresh_token");
    assert!(body.get("scope").is_none());
}
```

Add async sequencing coverage around a generic helper that records `listener-bound` before `authorization-notified`. Also extend parser tests so a bare code has no supplied state, while a URL and `code#state` retain their supplied state.

- [ ] **Step 2: Run OAuth tests and confirm RED**

Run:

```bash
cargo test -p kordi-cli oauth::anthropic --lib -- --nocapture
```

Expected: compilation fails because validation, buffered-expiry, request-body, and sequencing helpers do not exist.

- [ ] **Step 3: Implement listener-before-notification sequencing**

Add a small generic helper whose ordering is directly testable:

```rust
async fn start_then_notify<Start, StartFuture, Notify, Server>(
    start: Start,
    notify: Notify,
) -> Result<Server>
where
    Start: FnOnce() -> StartFuture,
    StartFuture: std::future::Future<Output = Result<Server>>,
    Notify: FnOnce(),
{
    let server = start().await?;
    notify();
    Ok(server)
}
```

Use it in `login_anthropic` so `start_callback_server(CALLBACK_PORT, CALLBACK_PATH)` completes before `callbacks.on_auth` publishes the URL. Keep the progress callback after notification.

- [ ] **Step 4: Validate loopback and manual state before exchange**

Add:

```rust
fn validate_callback_state(
    params: CallbackParams,
    expected_state: &str,
) -> Result<CallbackParams> {
    if params.state != expected_state {
        anyhow::bail!("Anthropic OAuth state mismatch");
    }
    Ok(params)
}
```

For manual bare code, fill the generated state before validation. For pasted URLs or `code#state`, preserve the supplied state and reject mismatches. Pass only validated parameters to `exchange_code`, so both loopback and manual paths fail before any token request.

- [ ] **Step 5: Centralize token bodies and buffered expiry**

Add:

```rust
const TOKEN_EXPIRY_SAFETY_MS: i64 = 5 * 60 * 1000;

fn buffered_expiry_ms(now_ms: i64, expires_in_seconds: i64) -> i64 {
    let lifetime_ms = expires_in_seconds.saturating_mul(1000);
    now_ms.saturating_add(lifetime_ms.saturating_sub(TOKEN_EXPIRY_SAFETY_MS).max(0))
}
```

Use it for authorization-code exchange and refresh responses. Extract `authorization_code_body` and `refresh_token_body`; use those exact values in Reqwest calls. The refresh body must remain limited to `grant_type`, `client_id`, and `refresh_token`.

- [ ] **Step 6: Run OAuth and saved-profile regressions and commit**

Run:

```bash
cargo test -p kordi-cli oauth::anthropic --lib -- --nocapture
cargo test -p kordi-cli login::resolver::oauth_refresh::tests --lib -- --nocapture
```

Expected: state, ordering, expiry, refresh-body, parser, and existing saved-profile tests all pass.

Commit:

```bash
git add agent/crates/cli/src/oauth/anthropic.rs
git commit -m "fix: harden Anthropic OAuth lifecycle"
```

## Task 6: Verify the complete change and prepare the PR

**Files:**

- Review: all files changed since `origin/main`
- Do not modify: `agent/CHANGELOG.md` or other changelog files for this unreleased PR

- [ ] **Step 1: Format and inspect the diff**

Run:

```bash
cargo fmt --all
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

Expected: formatting completes, no whitespace errors appear, and only the approved provider/CLI/tests/design/plan files are changed.

- [ ] **Step 2: Run the required automated verification**

Run each command separately and require exit code 0:

```bash
cargo fmt --all -- --check
cargo test -p kordi-provider
cargo test -p kordi-cli --lib
cargo test -p kordi-cli desktop_runtime --no-default-features --features desktop-runtime
cargo clippy -p kordi-provider -p kordi-cli --all-targets -- -A clippy::never_loop
```

- [ ] **Step 3: Audit acceptance-criteria coverage**

Confirm the final diff contains tests for:

- the exact 14-model catalog, metadata, order, and Opus 4.8 default;
- curated/live merge consistency and legacy live-ID retention;
- adaptive, budget, native-`xhigh`, `max`, reasoning-off, and unknown-model behavior;
- request bodies for Opus 4.6/4.7/4.8, Sonnet 5, Fable 5, and a budget model;
- absence of temperature for Opus 4.7/4.8;
- OAuth environment discovery, status, precedence, and explicit profile preservation;
- callback ordering, state validation, expiry margin, and scope-free refresh body.

- [ ] **Step 4: Scan new material for prohibited attribution and changelog edits**

Run:

```bash
forbidden='p''i'
git diff --unified=0 origin/main...HEAD | rg '^\+[^+]' | rg -niw "$forbidden"
gh issue view 678 --repo Kordi-AI/Kordi --json title,body | rg -niw "$forbidden"
git diff --name-only origin/main...HEAD | rg '(^|/)CHANGELOG'
```

Expected: all three searches produce no output. Existing unrelated repository references are outside this PR; no new line, issue text, changelog, commit, or PR text may add one.

- [ ] **Step 5: Perform a focused code review**

Review `git diff origin/main...HEAD` for duplicated model tables, substring checks that bypass capabilities, auth precedence regressions, token logging, accidental generic-schema changes, and unrelated UI/proxy/updater edits. Fix any finding with a failing regression test first, then rerun Step 2.

- [ ] **Step 6: Prepare the credentialed smoke-test checklist**

Record these unchecked items in the draft PR because repository CI has no real provider credentials:

1. Sign in with a Claude subscription and select Opus 4.8.
2. Send messages with reasoning off, high, and xhigh; confirm a response and no unsupported-field error.
3. Add an Anthropic API key, switch to that profile, send a message, then switch back.
4. Relaunch desktop and confirm the selected profile and model persist.
5. Force the saved OAuth expiry inside the safety window, relaunch, and confirm refresh rotates and persists credentials.
6. Set both Anthropic environment variables in a CLI shell; confirm automatic OAuth selection and explicit API-key selection.

- [ ] **Step 7: Push and open a draft PR**

After all automated checks pass:

```bash
git push -u origin agent/claude-model-auth-refresh
```

Open a draft PR targeting `main`, link `Closes #678`, summarize behavior directly, include exact automated commands/results, and include the credentialed smoke checklist. Do not merge until required CI and credentialed smoke checks pass.
