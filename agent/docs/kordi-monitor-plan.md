# kordi-monitor extraction plan

## Goal

`crates/kordi-monitor` is the reusable backend home for Kordi monitoring logic that should not live in CLI/TUI controller code.

It should own:
- derived usage/token/cost/cache summaries
- compact formatting helpers for monitor-oriented output
- context-window resolution/status helpers
- KV-cache Phase 1 request-metrics logic
- request-metrics sinks/logging helpers

It should **not** own:
- TUI widgets/layout/styling
- DB access
- auth/account display logic
- provider protocol parsing
- persisted transcript/message schema

## Dependency rule

- `kordi-monitor` **may depend on** `kordi-core`
- `kordi-core` must **not depend on** `kordi-monitor`

That means:
- persisted/shared schema stays in `kordi-core`
- provider-native parsing stays in `kordi-provider`
- derived monitor logic lives in `kordi-monitor`

## Ownership split

### `kordi-core`
Owns:
- canonical persisted message/usage/cost schema
- minimal shared enums needed across persisted/runtime/provider surfaces
- session/runtime base data

### `kordi-provider`
Owns:
- provider-native stream/event parsing
- raw provider usage extraction
- provider-specific usage signals

### `kordi-monitor`
Owns:
- derived usage totals and summaries
- token/cost/cache formatting helpers
- context-window resolution logic
- request metrics snapshot/tracker/finalization logic
- divergence/reuse estimation
- request metrics sinks (for example JSONL)

### `kordi-cli` / `kordi-tui`
Own:
- DB/runtime/auth input gathering
- command routing
- TUI rendering/layout
- final user-facing assembly of monitor text into views/commands

## Implemented so far in the current stack

### Phase 0 — scaffold
Landed in scaffold PR #118:
- `crates/kordi-monitor`
- initial shared crate exports
- issue/plan alignment for #119

### Phase 1 — formatting/session/context isolation
Landed in PR #120:
- `kordi-monitor::formatting`
- `kordi-monitor::session`
- `kordi-monitor::context`
- CLI `/info` and footer/controller code now call reusable `kordi-monitor` helpers instead of owning the pure monitor math directly

### Phase 2 — request-metrics engine extraction
Landed in PR #121:
- `kordi-monitor::request_metrics::canonical`
- `kordi-monitor::request_metrics::divergence`
- `kordi-monitor::request_metrics::tracker`
- `kordi-monitor::request_metrics::sink`
- provider-agnostic request snapshot/state/timing/usage types

### Phase 3 — runtime wiring
Landed in PR #122:
- turn-runner prepare/finalize flow wired to `kordi-monitor`
- shared `CacheMetricsSource` moved into `kordi-core`
- provider usage events and collected responses retain cache provenance
- assistant persistence now uses resolved cache usage
- request metrics JSONL emission is wired through explicit configured paths

## Current crate layout

```text
crates/kordi-monitor/
  src/
    lib.rs
    cache_metrics.rs
    formatting.rs
    usage.rs
    session.rs
    context.rs
    request_metrics/
      mod.rs
      canonical.rs
      divergence.rs
      sink.rs
      tracker.rs
```

## Remaining cleanup work

### 1. Legacy compatibility surface cleanup in `kordi-core`
Still remaining:
- reduce or further isolate duplicate legacy monitor vocabulary in:
  - `crates/core/src/agent/data.rs`
  - `crates/core/src/agent_loop/types.rs`
- keep those surfaces compatibility-focused and avoid growing new monitor logic there
- prefer `kordi-monitor` / `agent_session_runtime` for all new work

### 2. Docs/comments/examples alignment
Still remaining:
- point future contributors toward `kordi-monitor` as the canonical derived-monitor home
- keep issue #119 as the live implementation tracker/checklist

## Non-goals

- no TUI visual redesign here
- no frontend color/styling logic in `kordi-monitor`
- no provider event parsing move into `kordi-monitor`
- no DB access move into `kordi-monitor`

## Success criteria

This work is successful when:
- monitor computation is no longer primarily CLI-controller-owned
- `kordi-monitor` is the reusable backend home for derived monitor logic
- `kordi-core` still owns persisted canonical data types
- provider parsing stays in `kordi-provider`
- future monitor/cache work naturally lands in `kordi-monitor` instead of new CLI helper files

## Tracking

Use issue #119 as the live implementation checklist and PR tracker.
