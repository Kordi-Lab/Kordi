# Claude Model and Authentication Refresh Design

**Status:** Approved for implementation on 2026-07-14
**Issue:** #678

## Goal

Refresh Kordi's built-in Claude catalog, make request construction model-aware for current Claude reasoning behavior, and harden Anthropic authentication without changing unrelated provider or desktop flows.

## Constraints

- Describe Kordi behavior directly in code comments, commits, release notes, and pull-request text without naming comparison repositories.
- Preserve separate Claude subscription and Anthropic API-key profiles.
- Preserve explicit user profile and auth-method selections.
- Keep the proxy/VPN work tracked by #674 out of this change.
- Do not add a new temperature control to Kordi's generic completion request.
- Do not redesign the Authentication user interface.

## Current Problems

1. The built-in Anthropic registry is stale and still defaults to Claude Opus 4.6.
2. Model discovery, the subscription allowlist, and built-in metadata can disagree about which Claude models are selectable.
3. Request construction recognizes adaptive thinking only for Claude Opus 4.6 and Sonnet 4.6.
4. Thinking-level availability and payload mapping are split across CLI and provider substring checks.
5. Environment authentication recognizes `ANTHROPIC_API_KEY` but not `ANTHROPIC_OAUTH_TOKEN`.
6. Anthropic OAuth opens the browser before the callback listener is bound, does not validate returned state, and stores the full token lifetime without a safety margin.

## Architecture

### 1. Central Claude capability module

Create `agent/crates/provider/src/anthropic/capabilities.rs` as the single source of truth for known Claude request behavior.

The module exposes:

- the ordered subscription-compatible model IDs;
- the default Anthropic model ID;
- a lookup function returning `ClaudeModelCapabilities` for a model ID;
- supported reasoning levels for each known model family;
- request-level effort mapping;
- whether a model uses adaptive or budget-based thinking;
- whether reasoning-off should emit `thinking.type=disabled` or omit `thinking`;
- whether a model supports temperature.

The capability structure remains provider-specific. Extending the generic `Model` schema would create broad serialization and custom-provider migration work that is not required for this refresh.

Known adaptive models are:

- Claude Opus 4.6, 4.7, and 4.8;
- Claude Sonnet 4.6 and 5;
- Claude Fable 5.

Native `xhigh` is exposed for Opus 4.7, Opus 4.8, Sonnet 5, and Fable 5. `max` is mapped according to each known model's capability entry. Opus 4.7 and 4.8 are marked as not supporting temperature. Fable 5 omits an explicit disabled-thinking payload; other known reasoning models emit it when reasoning is off.

Unknown live Claude IDs keep the existing conservative runtime fallback. They are not granted high-end reasoning levels unless the capability table recognizes them.

### 2. Catalog reconciliation

Replace the built-in Anthropic list with the current 14-model target catalog and make Claude Opus 4.8 the default:

- `claude-fable-5`
- `claude-haiku-4-5`
- `claude-haiku-4-5-20251001`
- `claude-opus-4-1`
- `claude-opus-4-1-20250805`
- `claude-opus-4-5`
- `claude-opus-4-5-20251101`
- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-opus-4-8`
- `claude-sonnet-4-5`
- `claude-sonnet-4-5-20250929`
- `claude-sonnet-4-6`
- `claude-sonnet-5`

Each entry includes the current display name, cost, context window, maximum output, image support, and reasoning flag.

Legacy IDs removed from the built-in list remain usable by existing saved sessions because Kordi already synthesizes provider-correct runtime models for unknown IDs. If the authenticated models endpoint still returns a legacy ID, live discovery can add it back for that account.

### 3. Consistent selection and thinking controls

`agent/crates/cli/src/login/resolver/models.rs` consumes the provider module's ordered subscription-compatible IDs instead of maintaining a second list. The same order drives catalog ranking and the default selection.

`agent/crates/cli/src/runtime_model.rs` asks the provider capability module which reasoning levels to expose. It forwards `off` for known Anthropic reasoning models so the provider can apply the correct disabled-or-omitted behavior. Unsupported `xhigh` or `max` requests clamp through the same capability contract used by payload construction.

Live discovery continues to merge authenticated model IDs, but selection validation and model options use the same subscription-compatible list. A model must not appear selectable and then fail a later static allowlist check.

### 4. Testable Anthropic request construction

Extract the JSON request-body construction in `agent/crates/provider/src/anthropic.rs` into a pure helper. The streaming network path calls this helper after message and tool conversion.

The helper handles:

- Claude Code identity system blocks for subscription auth;
- ordinary system blocks for API-key auth;
- converted tools and hosted web search;
- cache control;
- adaptive thinking with `display: "summarized"` and mapped effort;
- legacy budget-based thinking;
- reasoning-off behavior;
- model output defaults.

Kordi currently has no temperature field in `CompletionRequest`, so no temperature is emitted. Capability metadata records the restriction for Opus 4.7 and 4.8, and request regression tests assert that their bodies contain no temperature field. This avoids adding an unrelated temperature feature.

### 5. Environment auth precedence

Add `ANTHROPIC_OAUTH_TOKEN` as an OAuth/Bearer environment source.

Resolution order is:

1. explicitly selected saved profile;
2. explicitly selected environment method;
3. active saved method/profile;
4. `ANTHROPIC_OAUTH_TOKEN`;
5. `ANTHROPIC_API_KEY`.

When both environment variables exist and the user has not made an explicit selection, the OAuth token wins. Auth summaries expose both environment choices and identify the OAuth token as OAuth rather than as an API key. Saved OAuth and API-key profile behavior is unchanged.

### 6. OAuth lifecycle hardening

For Anthropic OAuth:

- bind the callback listener before publishing the authorization URL;
- validate callback state before token exchange;
- accept a manually pasted bare code by pairing it with the locally generated state;
- reject a manually pasted URL or code/state pair with a mismatched state;
- compute stored expiry with a five-minute safety margin, clamped so short-lived credentials are immediately refreshable rather than negative;
- keep refresh requests free of a scope field;
- persist rotated access and refresh tokens through the existing auth-store path.

The shared callback-server API remains unchanged because the behavior required here can be enforced in the Anthropic flow without broadening the OpenAI scope of this PR.

## Error Handling

- A mismatched OAuth state returns a clear `Anthropic OAuth state mismatch` error and never reaches token exchange.
- Missing manual authorization input remains a cancellation error.
- Token endpoint failures retain HTTP status and response body in the surfaced error.
- Unknown models use conservative reasoning behavior instead of receiving adaptive-only fields.
- Existing retry and stream error propagation remain unchanged.

## Testing Strategy

All behavioral changes follow red-green-refactor cycles.

### Provider tests

- exact catalog IDs, ordering, metadata, and default;
- capability lookup for adaptive, budget-based, native-`xhigh`, `max`, temperature, and reasoning-off cases;
- request bodies for Opus 4.6, 4.7, 4.8, Sonnet 5, Fable 5, and a legacy budget model;
- absence of temperature for Opus 4.7 and 4.8;
- conservative fallback for an unknown live Claude ID.

### CLI tests

- subscription model filtering and order;
- default selection of Opus 4.8;
- desktop reasoning-level options match request capabilities;
- environment OAuth-token discovery, status, and precedence;
- explicit saved/API-key selections still override environment defaults;
- callback state validation for loopback and manual input;
- expiry safety-window calculation.

### Verification

- `cargo fmt --all -- --check`
- `cargo test -p kordi-provider`
- `cargo test -p kordi-cli --lib`
- `cargo test -p kordi-cli desktop_runtime --no-default-features --features desktop-runtime`
- `cargo clippy -p kordi-provider -p kordi-cli --all-targets -- -A clippy::never_loop`

A credentialed manual smoke test is documented for Claude subscription sign-in, Anthropic API-key switching, relaunch, and forced refresh. It is not automated because repository CI has no provider credentials.

## Non-Goals

- macOS proxy persistence;
- Authentication page layout changes;
- updater or release-channel changes;
- generic provider capability-schema redesign;
- new temperature controls;
- changes to OpenAI, GitHub Copilot, or other provider model catalogs.
