# Cloud Message Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring issue #317 message forking to the app-server/cloud contract and lightweight React UI while matching the merged desktop fork UX.

**Architecture:** Reuse the existing `kordi_session` fork backend added by PR #335 for local session forks, expose it through `app/server` HTTP endpoints, and extend shared protocol DTOs so cloud clients can render fork lineage. UI changes stay lightweight and reuse existing desktop transcript/sidebar components where available.

**Tech Stack:** Rust Axum app-server, shared Rust/TypeScript protocol packages, React/TypeScript desktop UI components, Node test runner, Cargo tests.

---

### Task 1: Shared fork protocol

**Files:**
- Modify: `shared/rust/protocol/src/lib.rs`
- Modify: `shared/typescript/protocol/src/index.ts`

- [ ] Add `SessionSummary` lineage fields: `parent_session_id`, `parent_session_message_id`, `fork_count`.
- [ ] Add `ForkSessionRequest`, `ForkSessionResponse`, and `SessionForksPage` DTOs.
- [ ] Keep all new fields optional except response `session`.

### Task 2: App-server fork endpoints

**Files:**
- Modify: `app/server/src/lib.rs`

- [ ] Add `GET /v1/sessions/:session_id` returning `SessionDetail`.
- [ ] Add `GET /v1/sessions/:session_id/forks` returning `SessionForksPage`.
- [ ] Add `POST /v1/sessions/:session_id/forks` accepting `ForkSessionRequest` and returning `ForkSessionResponse`.
- [ ] Use `store::fork_session_from_entry` for creation.
- [ ] Add tests for successful fork creation, lineage fields in lists/details, and invalid source message handling.

### Task 3: Lightweight fork UI affordances

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify as needed: `app/desktop/src/pages/WorkspaceSidebar.tsx`, `app/desktop/src/pages/ChatsPage.tsx`

- [ ] Ensure the transcript exposes the same fork icon/action affordance from PR #335 for app-server-backed sessions.
- [ ] Ensure forked-from notices and fork-count chips render from protocol lineage fields where available.
- [ ] Keep visual treatment consistent with desktop fork UX; no heavy layout rewrite.
- [ ] Add/update frontend tests for fork icon and lineage notice rendering.

### Task 4: Verification and PR update

**Commands:**
- `cargo test -p kordi-app-server fork -- --nocapture` if package name exists; otherwise `cargo test -p kordi-server fork -- --nocapture` or targeted `cargo test fork -- --nocapture` from repo root.
- `pnpm --dir app/desktop typecheck`
- targeted frontend tests touched by fork UI.

---

## Self-review

- Scope covers backend contract, cloud/app-server endpoints, and lightweight UI affordance.
- No hosted cloud UI source exists in this repo; UI work reuses existing desktop React surfaces per user instruction.
- No placeholders remain; implementation should be TDD with targeted tests before behavior changes.
