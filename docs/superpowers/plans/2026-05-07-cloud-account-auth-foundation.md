# Cloud Account Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server-side foundation for production Kordi Cloud accounts without replacing existing Bridges node API-key auth yet.

**Architecture:** Keep existing `/v1/auth/register` node registration compatible, but add account/device tables, extensible OAuth provider registry types, and optional account/device columns on `registered_nodes`. This PR establishes durable boundaries for future GitHub/Google/X OAuth endpoints and cloud sync.

**Tech Stack:** Rust, Axum, rusqlite, existing Bridges CLI server modules.

---

### Task 1: Account schema and migrations

**Files:**
- Modify: `bridges/cli/src/serve/mod.rs`
- Test: `bridges/cli/src/serve/mod.rs`

- [x] Add failing tests that `init_server_db` creates `cloud_accounts`, `cloud_account_identities`, `cloud_devices`, `cloud_refresh_tokens`, `cloud_audit_events`, and account/device columns on `registered_nodes`.
- [x] Run `cargo test -p bridges serve::tests::server_schema_creates_cloud_account_foundation -- --nocapture` and confirm it fails with missing tables/columns.
- [x] Add schema tables and migration columns.
- [x] Re-run the focused test and confirm it passes.
- [x] Add and pass a legacy-schema migration regression so the account/device index is created only after columns exist.

### Task 2: Extensible OAuth provider registry

**Files:**
- Create: `bridges/cli/src/serve/cloud_auth.rs`
- Modify: `bridges/cli/src/serve/mod.rs`
- Test: `bridges/cli/src/serve/cloud_auth.rs`

- [x] Add failing unit tests for normalizing provider IDs and for registry support of `github`, `google`, and `x`.
- [x] Run `cargo test -p bridges serve::cloud_auth::tests -- --nocapture` and confirm missing module/test failures.
- [x] Implement focused provider types: `OAuthProviderId`, `OAuthProviderDescriptor`, `OAuthProviderRegistry`, `default_oauth_provider_registry`.
- [x] Re-run focused tests and confirm they pass.

### Task 3: Account/device helper operations

**Files:**
- Modify: `bridges/cli/src/serve/cloud_auth.rs`
- Test: `bridges/cli/src/serve/cloud_auth.rs`

- [x] Add failing tests that upserting a provider identity creates/reuses an account and that registering a device belongs to that account.
- [x] Run focused tests and confirm failure.
- [x] Implement `upsert_account_identity` and `register_cloud_device` helpers using explicit SQLite operations.
- [x] Re-run focused tests and confirm pass.

### Task 4: Bridge node linking foundation

**Files:**
- Modify: `bridges/cli/src/serve/auth.rs`
- Modify: `bridges/cli/src/serve/mod.rs`
- Test: `bridges/cli/src/serve/auth.rs`

- [x] Add optional `accountId` and `deviceId` fields to register requests.
- [x] Add failing tests that registration persists account/device links when valid and rejects unknown account/device pairs.
- [x] Run focused auth tests and confirm failure.
- [x] Implement validation and persistence into `registered_nodes.account_id` / `device_id`.
- [x] Re-run focused auth tests and confirm pass.

### Task 5: Documentation and verification

**Files:**
- Create: `docs/changelogs/2026-05-07-cloud-account-auth-foundation.md`

- [x] Document the foundation and explicit non-goals.
- [x] Run `cargo test -p bridges serve:: -- --nocapture`.
- [x] Run `cargo test -p bridges -- --nocapture`.
- [x] Run `cargo fmt --manifest-path bridges/cli/Cargo.toml -- --check`.
- [x] Run `git diff --check`.
