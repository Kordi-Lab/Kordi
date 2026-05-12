# Cloud Email + Password Auth (Phase 1) Design

## Goal
Ship a real, end-to-end email + password auth flow for the Cloud Edition desktop app, layered on top of the existing `bridges/cli` Rust server and the existing UI on `feature/cloud-edition-login-gate`. The slice is fully usable against a locally running `bridges serve` and stores session tokens in the OS keychain on the desktop side. OAuth providers, email verification, and password reset are explicitly out of scope for this phase; they are tracked as named follow-ups.

## Non-goals (this phase)
- OAuth providers (Google, GitHub, X) — buttons stay disabled.
- Email verification (no SMTP integration).
- Password reset.
- 2FA.
- Cross-replica rate-limit state (Redis or DB-backed). In-memory only this phase.
- Deployment to the GCP VM (`shu_yang@takotako`). Deployment plan ships as a separate spec.

## Architecture

### Branch
`feature/cloud-email-password-auth`, off `main`, with `feature/cloud-account-auth-foundation` and `feature/cloud-edition-login-gate` merged in. Worktree at `/Users/shuyang/kordi-worktrees/cloud-email-password-auth`.

### Server (`bridges/cli`)

#### Schema migration (additive)
Applied via `add_column_if_missing` and a new `add_index_if_missing` helper inside `init_server_db`. No external migration tool; staying with the existing inline pattern.

| Table | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| `cloud_accounts` | `password_hash` | TEXT | yes | argon2 PHC string |
| `cloud_accounts` | `password_algorithm` | TEXT | yes | e.g. `argon2id-v19-m65536-t3-p4` |
| `cloud_accounts` | `password_updated_at` | TEXT | yes | RFC3339; NULL until first password set |

Plus one composite unique index for case-insensitive email lookup:

```
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_email_lower
ON cloud_accounts(LOWER(primary_email))
WHERE primary_email IS NOT NULL;
```

`primary_email` already exists on `cloud_accounts` from the auth-foundation work.

#### New module: `bridges/cli/src/serve/cloud_password.rs`
Pure password handling. No DB. No HTTP.
- `PasswordHasherConfig` — argon2 cost params (default OWASP: m=64MiB, t=3, p=4; tests use m=8KiB, t=1, p=1).
- `hash_password(plaintext, config) -> Result<String, _>` — returns argon2 PHC string.
- `verify_password(hash_str, plaintext) -> Result<bool, _>` — constant-time via `argon2::PasswordVerifier::verify_password`.
- `validate_password_strength(plaintext) -> Result<(), PasswordPolicyError>` — length 8..=128, no all-whitespace, no NUL bytes.
- `validate_email(input) -> Result<String, EmailFormatError>` — trim + lowercase + simple regex (`^[^@\s]+@[^@\s]+\.[^@\s]+$`); returns the normalized form.

#### New module: `bridges/cli/src/serve/cloud_session.rs`
Session token issuance and lookup, separate from `cloud_auth.rs` so DB-CRUD is decoupled from auth-flow logic.
- `issue_session(conn, account_id, device_id, lifetime) -> Result<IssuedSession, _>` — generates 32 random bytes, base64url-encodes as `kordi_cs_<...>`, SHA-256 hash stored in `cloud_refresh_tokens.token_hash`, returns the plaintext (caller returns to client; never persisted).
- `lookup_session(conn, plaintext_token) -> Result<Option<CloudSessionRow>, _>` — hashes input, finds non-revoked row whose `expires_at > now`, returns `{account_id, device_id, expires_at, token_id}`.
- `revoke_session(conn, token_id) -> Result<(), _>` — sets `revoked_at = now()`.
- `bump_expiry(conn, token_id, new_lifetime) -> Result<(), _>` — sliding-window refresh on `/me`.

Session token format: `kordi_cs_` + 43-char base64url (32 bytes encoded). Default lifetime 30 days.

#### New module: `bridges/cli/src/serve/cloud_auth_middleware.rs`
Mirrors the existing `auth_middleware` pattern in `auth.rs`.
- Reads `Authorization: Bearer <token>` header.
- Calls `cloud_session::lookup_session`.
- On match: bumps expiry (30-day sliding) and injects `CloudSession { account_id, device_id, token_id }` request extension.
- On miss / expired / revoked: returns 401 with `{error_code: "invalid_session"}`.

#### New module: `bridges/cli/src/serve/cloud_rate_limit.rs`
Pluggable in-memory limiter. Two limiters:
- Per-IP: 10 attempts / 60s, sliding window. Backing store: `Mutex<HashMap<IpAddr, VecDeque<Instant>>>`.
- Per-email: 5 failed attempts / 15min → 15min lockout. Backing store: `Mutex<HashMap<String, FailureWindow>>`.

Errors return HTTP 429 with `{error_code: "rate_limited", retry_after_seconds}`. State resets on process restart — known production gap.

#### New routes (added to `cloud_auth::routes()`, merged into the main router)

| Method | Path | Body / Headers | Returns | Errors |
|---|---|---|---|---|
| POST | `/v1/cloud/auth/signup` | `{email, password, display_name?, avatar_seed?}` | 201 `{account, session, expires_at}` | 400 `weak_password`, 400 `invalid_email`, 409 `email_in_use`, 429 `rate_limited` |
| POST | `/v1/cloud/auth/login` | `{email, password}` | 200 `{account, session, expires_at}` | 401 `invalid_credentials`, 429 `rate_limited` |
| POST | `/v1/cloud/auth/logout` | Bearer | 204 | 401 `invalid_session` |
| GET | `/v1/cloud/auth/me` | Bearer | 200 `{account}` | 401 `invalid_session` |

Body limits: 4 KB request body cap on auth routes (rejecting absurd inputs).

`account` shape:
```
{ account_id, display_name, primary_email, avatar_url, password_set: bool }
```

#### Audit log
Insert into `cloud_audit_events` (existing table) on:
- `account.created` — on signup, with `metadata_json = {ip, user_agent}`.
- `auth.login.success` — on login, with `metadata_json = {ip, user_agent}`.
- `auth.login.failure` — on login with wrong password (account lookup succeeded), with `metadata_json = {ip, reason}`.
- `auth.logout` — on logout.

#### Cargo.toml additions
- `argon2 = "0.5"` — password hashing.
- `password-hash = "0.5"` — already a transitive dep; ensure direct.

That's it. No new auth crates beyond argon2.

### Desktop (`app/desktop`)

#### OS-keychain Tauri command
- New Rust deps in `app/desktop/src-tauri/Cargo.toml`: `keyring = "2"` (cross-platform OS keychain wrapper).
- New module `app/desktop/src-tauri/src/cloud_session.rs` exposing three Tauri commands:
  - `cloud_session_store(token: String, account_id: String, expires_at: String) -> Result<(), String>` — stores under service `"com.kordi.cloud-session"`, account `"default"`. JSON-encodes `{token, account_id, expires_at}`.
  - `cloud_session_load() -> Result<Option<CloudSessionEntry>, String>` — returns `None` if entry missing.
  - `cloud_session_clear() -> Result<(), String>` — removes the entry.
- Capabilities: append the three commands to `app/desktop/src-tauri/capabilities/default.json` so the webview can invoke them.

The keyring crate maps to:
- macOS Keychain Services
- Windows Credential Manager
- Linux Secret Service / kwallet

When the OS keystore is unavailable (e.g. Linux without a keystore daemon), commands return a structured error `keychain_unavailable` so the desktop falls back gracefully (signed-out state) and shows an inline message.

#### New TS modules
- `app/desktop/src/features/cloud/authClient.ts`
  - `signup({email, password, displayName, avatarSeed}) -> Promise<AuthResult>`
  - `login({email, password}) -> Promise<AuthResult>`
  - `logout(token) -> Promise<void>`
  - `me(token) -> Promise<CloudAccount>`
  - Reads base URL from `import.meta.env.VITE_KORDI_CLOUD_API_BASE` (default `http://127.0.0.1:17080`). Uses `fetch`. Surfaces structured error codes in `AuthError` instances.
- `app/desktop/src/features/cloud/session.ts`
  - `loadSession(): Promise<StoredSession | null>` — invokes `cloud_session_load`.
  - `saveSession(s: StoredSession): Promise<void>` — invokes `cloud_session_store`.
  - `clearSession(): Promise<void>` — invokes `cloud_session_clear`.
  - Outside Tauri (e.g. in the browser preview), falls back to a localStorage stub with a console-warning so devs notice. Production builds always have Tauri available.
- `app/desktop/src/features/cloud/useCloudSession.ts` (hook)
  - Returns `{status, account, signIn, signUp, signOut, error}` where `status` ∈ `'loading' | 'signed-out' | 'authenticated'`.
  - On mount: `loadSession()` → if present, `me(token)` → if 200, status `authenticated`; if 401, clear keychain, status `signed-out`.
  - `signIn`/`signUp` call authClient, then save session, then re-fetch me.
  - `signOut` calls authClient.logout (best-effort) then `clearSession()`.

#### Wiring `CloudLoginPage`
- `onSubmit` becomes a real handler:
  - Validates client-side (email regex, password length).
  - Calls `signIn` or `signUp` from `useCloudSession`.
  - Shows loading state on the submit button (text → "Signing in…" / "Creating account…", disabled while in flight).
  - Renders inline error under the form (e.g. "Email already in use", "Invalid email or password").
- Submit button is enabled when both inputs are non-empty AND email passes regex AND password ≥ 8 chars.
- Persisted avatar `seed` on signup is sent to the server in `avatar_seed`. Server stores it in `cloud_accounts.avatar_url` as `kordi-pixel-avatar://<seed>` so the frontend's `IdentityAvatar` can rehydrate later. This keeps the avatar persistent across devices once signed in.

#### Wiring `KordiApp`
- `KordiApp` reads `cloudSessionStatus` from `useCloudSession()` (when edition is cloud) instead of the hard-coded `'signed-out'`. Existing `shouldShowCloudLoginGate` logic stays the same; it just receives a real status now.

## Testing

### Server (Rust)
- `cloud_password` unit tests: hash round-trip, wrong password rejected, malformed PHC rejected, weak passwords rejected, email validation cases.
- `cloud_session` unit tests: issue + lookup, expired token rejected, revoked token rejected, slide-window expiry update.
- `cloud_auth` route tests (in-process axum `Router::oneshot`):
  - Signup happy path (201 + `account_id` returned + audit row written).
  - Signup with duplicate email returns 409.
  - Signup with weak password returns 400 + `weak_password`.
  - Login happy path (200 + new session token).
  - Login wrong password returns 401 + audit row written.
  - Login rate-limit kicks in after 5 failures (per-email lockout).
  - `/me` with valid token returns account; with invalid returns 401.
  - Logout invalidates the token (subsequent `/me` returns 401).
- `cloud_rate_limit` unit tests: window slide, separate limiters don't interfere.

### Desktop (TS)
- `authClient.test.ts` (new): mocks `fetch`, verifies request shape and error parsing for every route.
- `cloudSession.test.ts` (new): stubs the Tauri `invoke` global, verifies save/load/clear flow and graceful fallback.
- `cloudEdition.test.tsx` (extended): assert that with a cleared session, the login gate renders; with a stubbed authenticated session, the app frame renders (and the gate does not).
- Existing 545 tests stay green.

### Manual smoke
1. `cargo run -p bridges-cli -- serve --port 17080 --db /tmp/bridges-cloud.db`
2. `VITE_KORDI_EDITION=cloud VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17080 pnpm --dir app/desktop tauri:dev`
3. Sign up → see authenticated app shell.
4. Reload → still authenticated (keychain persists).
5. Logout → returns to gate.
6. Login with wrong password 6 times → rate-limit error after #5.

## Production gaps (tracked as follow-ups)

| # | Gap | Why it matters | Follow-up |
|---|---|---|---|
| 1 | Rate limit state in-memory | Resets on restart, no cross-replica sharing | Switch to a SQLite-backed counter when we deploy to >1 instance |
| 2 | No email verification | Lets anyone claim any email | Add SMTP (Postmark/Resend) + `cloud_email_verifications` table + verification middleware before sensitive ops |
| 3 | No password reset | Locked-out users can't recover | Same SMTP infra as above + reset-token table |
| 4 | No deployment to `shu_yang@takotako` | Slice only runs locally | Separate spec: Dockerfile / systemd unit, Caddy/Nginx, TLS, CI/CD |
| 5 | No CSP-hardening on Tauri webview | Keychain mitigates token theft, but XSS in webview is still a concern | Audit Tauri capabilities + tighten CSP to disallow inline scripts |
| 6 | No password breach check (HIBP k-anonymity) | Users can choose breached passwords | Optional addition; calls out to Have I Been Pwned API on signup/change |

## Verification gate before merging
- `cargo test -p bridges-cli` green.
- `pnpm --dir app/desktop typecheck && lint && test:unit` green.
- Manual smoke flow above completed locally.
- Spec self-review run on this document (no placeholders, no contradictions).
