# OpenAI Codex Model Capabilities Implementation Plan

**Goal:** Implement issue #670 by updating the OpenAI/Codex catalogs and making thinking-level availability and serialization model- and auth-aware.

**Architecture:** Add one OpenAI capability module in `kordi-provider` and consume it from request serializers and the desktop runtime. Extend the shared thinking-level vocabulary through every Rust and TypeScript boundary.

**Tech Stack:** Rust, TypeScript, React, Cargo, pnpm/Vitest.

---

### Task 1: Extend the shared thinking-level vocabulary

**Files:**
- Modify: `agent/crates/core/src/types/session.rs`
- Modify: `shared/rust/protocol/src/lib.rs`
- Modify: `shared/typescript/protocol/src/index.ts`
- Modify: `app/server/src/lib.rs`

1. Add failing parsing, serialization, and conversion assertions for `max`.
2. Run the focused Rust tests and confirm the missing variant failure.
3. Add `Max`/`max` to each shared type and conversion.
4. Re-run the focused tests.

### Task 2: Centralize OpenAI thinking capabilities and wire serialization

**Files:**
- Create: `agent/crates/provider/src/openai/capabilities.rs`
- Modify: `agent/crates/provider/src/openai.rs`
- Modify: `agent/crates/provider/src/openai/responses.rs`
- Modify: `agent/crates/provider/src/openai/codex/request.rs`
- Modify: `agent/crates/provider/src/openai/codex.rs`

1. Add tests for the exact GPT-5.6 level set, GPT-5.5 API/OAuth difference, descending fallback, and API/OAuth effort mapping.
2. Run the provider tests and confirm the new behavior fails.
3. Implement route-aware capability lookup, clamping, and serialization.
4. Route chat completions, Responses, and Codex OAuth through the helper.
5. Re-run provider tests.

### Task 3: Update direct and OAuth model catalogs

**Files:**
- Modify: `agent/crates/provider/src/registry/models/openai.rs`
- Modify: `agent/crates/cli/src/login/resolver/models.rs`

1. Add tests asserting the exact seven-model OAuth catalog, absence of stale and bare IDs, and presence/metadata of the three direct GPT-5.6 variants.
2. Run focused tests and confirm failure.
3. Update both catalogs while retaining `gpt-5.5` as the preferred default.
4. Re-run focused tests.

### Task 4: Make runtime and UI controls auth-aware

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime/model_options.rs`
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Modify: `agent/crates/cli/src/desktop_runtime/session_detail.rs`
- Modify: `agent/crates/cli/src/desktop_runtime/tests.rs`
- Modify: `agent/crates/cli/src/tui/menus/settings.rs`
- Modify: `app/desktop/src/kordi-app/data/composer.ts`
- Modify: `app/desktop/src/kordi-app/components/composer.tsx`
- Modify: `app/desktop/src/features/chat/composerController.shared.ts`
- Modify: relevant desktop tests

1. Add failing Rust and TypeScript tests for route-specific options, `max` labels, and `max -> xhigh -> high` fallback.
2. Pass active auth method into OpenAI capability selection and request normalization.
3. Add `max` to TUI and desktop labels/options and implement ordered frontend fallback.
4. Re-run focused Rust and TypeScript tests.

### Task 5: Verify the complete change

1. Run formatting and diff checks.
2. Run affected Rust crate suites and the CLI library suite.
3. Run desktop type checking and unit tests.
4. Review the final diff against every acceptance criterion in issue #670.
