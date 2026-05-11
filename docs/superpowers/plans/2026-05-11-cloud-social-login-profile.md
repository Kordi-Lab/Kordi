# Cloud Social Login Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Google and GitHub OAuth login plus editable Cloud profile support on `main-cloud`.

**Architecture:** The cloud server owns OAuth provider config, state storage, code exchange, account linking/creation, profile persistence, and session issuance. The desktop Cloud login page starts OAuth by requesting an auth URL and then lets the provider/server redirect back with an auth result in the URL fragment; the session hook consumes that result. The existing profile popover becomes an editable Cloud profile surface that PATCHes display name/avatar changes to the server and refreshes canonical Cloud identities through existing sync.

**Tech Stack:** Rust/Axum/sqlx Postgres cloud server, OAuth 2.0 authorization code flow, reqwest for provider HTTP, React/TypeScript desktop app, existing CloudAuthClient/useCloudSession/session storage.

---

### Task 1: Backend OAuth/profile foundations

**Files:**
- Create: `bridges/cloud-server/migrations/0005_oauth_states.sql`
- Modify: `bridges/cloud-server/Cargo.toml`
- Modify: `bridges/cloud-server/src/auth/routes.rs`

- [x] Add OAuth state table with `state_id`, `provider`, `redirect_after`, `code_verifier`, timestamps.
- [x] Add `reqwest` dependency using rustls/json.
- [x] Add provider enum/config helpers for Google and GitHub.
- [x] Add profile patch request validation helpers.
- [x] Add protected `PATCH /v1/cloud/auth/me` returning `AccountResponse`.

### Task 2: Backend OAuth start/callback

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`

- [x] Add `GET /v1/cloud/auth/oauth/:provider/start?redirectAfter=...` returning `{ authUrl }`.
- [x] Add `GET /v1/cloud/auth/oauth/:provider/callback?code=...&state=...`.
- [x] Exchange provider code for access token.
- [x] Fetch provider profile.
- [x] Link by existing provider identity first, then by verified email, otherwise create account.
- [x] Upsert `cloud_account_identities`, update account profile defaults, create device/session, and redirect to `redirectAfter#kordi_cloud_oauth=<base64url AuthResponse>`.

### Task 3: Frontend auth client/session/login

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Modify: `app/desktop/src/features/cloud/useCloudSession.ts`
- Modify: `app/desktop/src/kordi-app/cloud/CloudLoginPage.tsx`
- Modify tests: `app/desktop/tests/cloudAuthClient.test.tsx`, `app/desktop/tests/cloudEdition.test.tsx`

- [x] Add Cloud OAuth provider types and `startOAuth()`/`updateProfile()` methods.
- [x] Add URL-fragment auth result parser.
- [x] `useCloudSession` consumes OAuth fragments, saves token, and exposes `signInWithProvider()` / `updateProfile()`.
- [x] Enable Google/GitHub buttons and remove coming-soon disabled copy.

### Task 4: Editable Cloud profile UI

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify tests: `app/desktop/tests/cloudProfileMenu.test.tsx`

- [x] Add edit mode in Cloud profile popover.
- [x] Let user edit display name, upload avatar as data URL, or generate a random pixel avatar seed.
- [x] Save through `CloudAuthClient.updateProfile()` and refresh Cloud session account state.
- [x] Preserve current read-only profile rows.

### Task 5: Verification and docs

**Files:**
- Modify: `docs/cloud-edition.md`
- Modify deployment docs if env vars are documented there.

- [x] Document OAuth env vars and callback URLs.
- [x] Run `pnpm --dir app/desktop exec tsx --test tests/cloudAuthClient.test.tsx tests/cloudEdition.test.tsx tests/cloudProfileMenu.test.tsx`.
- [x] Run `pnpm --dir app/desktop typecheck`.
- [x] Run `pnpm --dir app/desktop lint`.
- [x] Run `cargo check -p kordi-cloud-server`.
