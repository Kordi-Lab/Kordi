# Bridges Local API Pending State Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `bridges/cli/src/local_api.rs` by extracting request pending-state and delivery-stage bookkeeping without changing local API routes or response shapes.

**Architecture:** Add `bridges/cli/src/local_api/pending.rs` as a child module. Keep Axum route handlers and routing in `local_api.rs`; move delivery stages, pending response records, poll response DTO, pending insert/update/remove helpers, and daemon-facing response/delivery event store functions into the child module with root re-exports for existing external call sites.

**Tech Stack:** Rust Bridges CLI crate, Axum DTOs, Tokio mutexes, existing local API tests.

---

### Task 1: Extract pending response bookkeeping

**Files:**
- Modify: `bridges/cli/src/local_api.rs`
- Create: `bridges/cli/src/local_api/pending.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `bridges/cli/src/local_api.rs` that references `pending::DeliveryStage::from_str("pending_send")` and expects `Some(pending::DeliveryStage::PendingSend)`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p bridges local_api::tests::pending_module_parses_delivery_stage_wire_values --no-default-features
```

Expected: FAIL with unresolved `pending` module/symbol error.

- [x] **Step 3: Move pending helpers into child module**

Create `bridges/cli/src/local_api/pending.rs` and move:

- `DeliveryStage` and its methods
- `PendingResponse`
- `PollResponse`
- `resolve_project_dir`
- `new_request_id`
- `insert_pending`
- `note_pending_stage`
- `note_pending_failure`
- `remove_pending`
- `store_delivery_event`
- `store_response`

Keep `store_delivery_event`, `store_response`, `DeliveryStage`, `PendingResponse`, and `PollResponse` publicly re-exported from `local_api.rs` so daemon/setup/doctor call sites keep using `crate::local_api::*` paths.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `pending.rs` so delivery-stage wire parsing coverage lives with the extracted helper.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p bridges local_api --no-default-features
```

Expected: all local API tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bridges local_api --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add bridges/cli/src/local_api.rs bridges/cli/src/local_api/pending.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-local-api-pending-split.md
git commit -m "Extract bridges local API pending state"
```
