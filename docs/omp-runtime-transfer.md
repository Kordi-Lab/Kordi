# OMP hosted runtime transfer: provider and route contract

This is the first gate for moving hosted agent execution to [oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP). The account selector is part of the run route, not a property of the provider. One Kordi account may hold multiple OpenAI API keys and multiple Codex sign-ins. A session chooses exactly one saved account and one model.

## Purpose and boundary

1. The app saves each credential as an encrypted provider snapshot with a stable, non-secret `authChoice`, an optional display `label`, and a `provider`. Saving a new choice preserves the other choices. Replacing the same choice revokes its previous snapshot.
2. A run route carries `defaultAuthProvider`, `defaultAuthChoice`, `defaultModel`, and `thinking`. The hosted server resolves the exact provider family and choice for the run owner. A missing or revoked choice fails closed. It never selects a different saved account to satisfy a requested choice.
3. The server gives the worker decrypted material only for the claimed run. The worker passes the selected credential and model to OMP for that run. No credential or refresh token enters synchronized messages, route notices, UI metadata responses, logs, or artifacts.
4. Codex device authorization can start on iPhone. The server stores the refresh token in the encrypted snapshot and refreshes it before a run when needed. Other provider authorization methods need their own refresh policy before hosted OMP rollout.
5. Revoking one profile removes only that profile. Desktop logout revokes snapshots issued by the same device; an account added on iPhone or another desktop remains saved.

The run-route bridge lives in `bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs`. `experiments/omp-provider-routing` runs two things: the original synthetic probe (`worker.ts`/`probe-cli.ts`), which still uses a mock model and makes no external call, and `live-server.ts`, which adds the OMP catalog endpoint, a real hosted route test (`runLiveHostedTurn`, which does call the real provider through OMP when run against a live worker), and the login-session worker described below. Neither switches the deployed runner: the existing Rust runner still executes production turns.

## Catalog and merge rule

### Pinned catalog

`shared/omp-catalog/omp-provider-catalog.json` is a checked-in snapshot of `@oh-my-pi/pi-catalog@18.2.11`. It lists **74 provider rows**, of which **70 carry at least one text model**; the other four (`local`, `openai-codex-device`, `typesafe`, `web`) have none. `openai-codex-device` is login-only: no models, and its credential is stored under `openai-codex` (`storeCredentialsAs`). Across all 74 rows the login `kind` splits as 42 `api-key`, 13 `env-only`, 8 `custom`, 8 `oauth-code`, and 3 `device-code`; the derived `auth.kind` splits as 49 `api-key`, 8 `custom`, 8 `oauth-code`, 6 `native`, and 3 `device-code`.

Each provider row carries top-level `baseUrl` and `api` (`string | null`): the base URL and OMP transport `api` kind of its default bundled text model, which is where a claimed credential for that row is sent. `baseUrl` is `null` when OMP only has a template (`{region}`, `<account>`) or a non-https scheme, so nothing guesses a host.

Each provider's `login` object carries the same 16 fields: `kind`, `name`, `instructions`, `prompt`, `placeholder`, `authUrl`, `validates`, `pasteKey`, `manualOnly`, `callbackPort`, `callbackPath`, `hook`, `apiKeyFormat`, `envVars`, `storeCredentialsAs`, `acceptsApiKeyMethod`. `callbackPath` is OMP's loopback callback path for `oauth-code` logins that listen on `callbackPort` (for example `/auth/callback` for `openai-codex`), and `null` otherwise.

`acceptsApiKeyMethod` is one shared rule, `acceptsHostedApiKey` in `login-policy.ts`: always for `api-key`; for `env-only` when OMP names an environment variable and the provider does not authenticate natively (the Bedrock providers use AWS credential chains a pasted key cannot drive); and for `oauth-code`/`device-code`/`custom` when the rule accepts a pasted key or reads a `*_API_KEY` variable. The worker's `/login/start` and `/validate-key` enforce it, and the catalog derives `auth.acceptsApiKey` (always equal to it) and `auth.kind` (`env-only` becomes `api-key` or `native`) from it, so a client is never offered a key step the worker then refuses. `bedrock-mantle`, `google-vertex`, `local`, `web`, and `minimax-cn` therefore publish `auth.kind: "native"` and `acceptsApiKey: false`.

`catalog-builder.ts` builds this snapshot from `bundledProviderCatalog()` (`live-server.ts`) plus the pinned dependency version, sorts providers by id, and strips any display-text segment (a trailing parenthetical or trailing word) that is written entirely in non-Latin script, so the checked-in file stays English-only; a strip that would empty a required field falls back to the provider id. `export-catalog.ts` (`bun run export-catalog`) writes the file and refuses to write any value that looks like an embedded secret. `catalog-sync.test.ts` rebuilds the catalog in memory from the installed dependency and fails `bun test` if it no longer deep-equals the checked-in file, so a version bump without re-exporting is caught.

### Merge rule (clients)

On every surface - desktop `app/desktop/src/kordi-app/auth/ompCatalog.ts`/`model.ts`, and iOS `ProviderAuthentication.swift`/`AppModel.swift` - the OMP catalog is the source list, not a Kordi-defined one:

- Each client bundles the pinned catalog (`pinnedOmpCatalog` on desktop, `OMPProviderCatalog.pinned` on iOS) and, when signed in, asks the server's public `/v1/cloud/agent-provider-auth/catalog` route to refresh it. That route only proxies the worker's own `GET /catalog`; it adds no providers of its own. A failed or empty refresh keeps the pinned list (`refreshOmpCatalog`), and a hosted entry missing `login` steps keeps the pinned steps for that provider.
- OMP wins on overlap: id, display name, model list, default model, and auth policy all come from the catalog entry (`ompProvider()`/`buildOmpDisplayProviders` on desktop, `fromCatalog()` on iOS). Kordi adds saved accounts, the "configured" flag, and interactive sign-in adapters for `openai-codex`, `anthropic`, and `github-copilot` (`kordiSignInProviderIds`).
- `ollama`, `lm-studio`, and `custom` are rows Kordi adds to the merged list. OMP does define `ollama` and `lm-studio` (provider definitions and auth policies for locally discovered models), but neither is in its bundled provider list, so the pinned catalog has no row for them; `custom` is Kordi-only. `custom` stores an account name, public HTTPS base URL, model id, and key as its own encrypted snapshot.
- OpenAI is one display row backed by two OMP providers: `openai-codex` for ChatGPT sign-in and `openai` for API keys. Desktop's `buildAuthDisplayProviders` and iOS's `merged()` collapse them by canonical id.
- Short display names strip a trailing parenthetical qualifier and a trailing plan-tier suffix such as "Plus/Pro" (desktop `providerCopy.splitProviderName`, e.g. "Antigravity (Gemini 3, Claude, GPT-OSS)" -> "Antigravity"). This is a client-side display rule, separate from the catalog's own non-Latin-script stripping above.
- Desktop's merged settings list has **72 rows** for the pinned catalog: 70 catalog entries with models, minus 1 for the OpenAI/ChatGPT merge, plus `custom`, `lm-studio`, and `ollama` (`authProviderConfig.spec.ts`'s `expectedProviderRows`, `authCatalogMerge.test.ts`). iOS builds the equivalent list with `ProviderAuthenticationDefinition.merged(catalog:savedProviderIDs:)`, wired from `AppModel.authenticationProviderDefinitions`.

## Login sessions

### Worker contract (`experiments/omp-provider-routing`)

`live-server.ts` runs the hosted login-session worker defined in `login-session-types.ts`, `login-session-store.ts`, `login-step-bridge.ts`, and `login-session-routes.ts`. It binds `127.0.0.1:17331` by default (`KORDI_OMP_ROUTE_WORKER_HOST`/`_PORT`; a comment states it must stay on an internal network and never be exposed publicly) and checks a bearer token with a constant-time SHA-256 comparison (`hasWorkerBearer`) on every route except `GET /health` and `GET /catalog`.

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /login/start` | `{provider, sessionId, method?}` | 202, session snapshot |
| `GET /login/{id}?wait=&after=` | - | 200, snapshot; long-polls up to 30 s |
| `POST /login/{id}/input` | `{value}` | 202, snapshot |
| `POST /login/{id}/cancel` | - | 200, snapshot |
| `POST /login/{id}/claim` | - | 200 `{provider, material}`, once |

`method` is `"default"` (the provider's own OMP login) or `"api-key"` (the internal key-entry flow); starting a method the policy does not support returns `422 unsupported_flow`. Every snapshot is `{sessionId, status, step, auth, error, version}`; `step.type` is one of `open-url`, `prompt`, `paste-code`, `progress`, or `api-key` - never a credential shape.

For `oauth-code` providers, `runHostedOmpLogin` (`login-step-bridge.ts`) runs OMP's `DeclarativeOAuthCodeFlow` with `manualInputOnly: true` and `nativeScheme: false`: the worker runs in a container the user's browser cannot reach, so no loopback listener or OS URL handler is registered, and completion always comes from a pasted redirect URL or code.

`claim` hands the credential over exactly once, then forgets the session (`LoginSessionManager.claim`/`#forget`); a later claim gets `409`/`404`. Sessions idle for `LOGIN_IDLE_TIMEOUT_MS` (15 minutes) are swept as `timeout` failures every 30 seconds; up to `MAX_LOGIN_SESSIONS` (20) run at once, evicting the oldest finished session before rejecting a new one with `429 too_many_sessions`.

Claimed material (`{apiMode: "api-key", apiKey}` or the OAuth shape with `accessToken`, `refreshToken`, `expiresAtMs`, `email`, `orgName`, `accountId`, `apiEndpoint`, `enterpriseUrl`, `projectId`) always ends with `baseUrl` and `api`: OMP's endpoint for the provider the credential is stored under (`provider-endpoint.ts`), so the runner can send the credential to its own provider's host. A login that chooses its own endpoint (Alibaba Coding Plan's custom base URL, the Token Plan region, a Cloudflare AI Gateway account and gateway, a GitHub Copilot enterprise domain) is read through OMP's own credential parsers, and that endpoint is kept only if it passes the outbound guard below; otherwise the login fails with `invalid_input`. `baseUrl` is `null` when OMP has only a template, and a runner must refuse rather than fall back to a default host.

OMP never marks its prompts secret, so the bridge sets `secret: true` on a `prompt` step when OMP asks for it or the message names a key, token, secret, password, cookie, or credential (`isSecretPrompt`).

#### Outbound guard

OMP's logins, key probes, and transports call the global `fetch`, and some take a URL from the user. At startup the worker replaces the process's global `fetch` with a guard (`outbound-guard.ts`, `installWorkerFetchGuard`) and also sets it as `OAuthController.fetch` and as the key-probe fetch. The guard reuses `custom-endpoint.ts`'s checks: every target must be https on a public DNS name (no IP literals, embedded credentials, or reserved suffixes such as `.internal` or `.local`); the name is resolved before each attempt and every address must be publicly routable (loopback, private, link-local, CGNAT, multicast, reserved, and documentation ranges are refused, including IPv4-mapped IPv6 forms); and redirects are never followed by the runtime: up to five hops are followed manually, each validated the same way, with credential headers dropped when the origin changes. A refusal sends nothing. The runtime still performs its own lookup when it connects, so a DNS rebind inside that window is not visible to the guard; production must keep the worker on an egress-restricted network, and the worker needs working DNS.

#### Key validation and route test

`POST /validate-key {provider, apiKey}` answers `{verified}`. `verified` is true only when a provider probe actually accepted the key: it is false when OMP declares no probe and when an optional probe (for example `nvidia`, `stepfun`) could not run and OMP accepted the key anyway. `POST /run {route, material}` runs one hosted turn; for providers whose OMP policy declares `api-key-format "structured"` (Google Gemini CLI, Antigravity, GitHub Copilot, Alibaba Coding Plan) the worker builds the JSON key with OMP's own `getOAuthApiKey` from the material's account fields (`hosted-credential.ts`).

Every worker error body is `{error: <fixed code>}`:

| Route | Status and codes |
| --- | --- |
| `/validate-key` | 400 `invalid_request`; 422 `invalid_api_key`, `unsupported_auth_method`, `api_key_rejected` (the provider refused the key), `invalid_custom_endpoint`; 502 `provider_unavailable` (outage, timeout, or any other provider failure) |
| `/run` | 400 `invalid_request`, `route_mismatch`, `credential_missing`; 422 `unsupported_model`, `invalid_custom_endpoint`; 502 `credential_expired`, `provider_rejected`, `route_test_failed` |
| any | 401 `unauthorized`, 404 `not_found`, 413 `request_too_large` |

### Server contract (`bridges/cloud-server`)

The server files this section describes land in gates 2-4 of this PR stack, not with the worker and catalog above.

`provider_login.rs` and `provider_login/{lifecycle,responses,store,worker}.rs` mount session-authenticated routes under `/v1/cloud/agent-provider-auth/login` (`provider_auth_routes.rs`, behind `cloud_session_middleware`):

| Method & path | Body | Notes |
| --- | --- | --- |
| `POST /login/start` | `{provider, label, mode?, method?}` | 202; validates the provider id, a label (<=80 chars, no control characters), `method` (`default`/`api-key`), and `mode` (`device`, only for `openai-codex` with `method: default`, mapped to worker provider `openai-codex-device`) |
| `GET /login/:session_id?wait=&after=` | - | 200; owner-only |
| `POST /login/:session_id/input` | `{value}` | 202/200; value capped at 16 KB |
| `POST /login/:session_id/cancel` | - | 200 |

A running response is `{sessionId, status, step, auth, version}`; a completed one adds `snapshot: {snapshotId, provider, authChoice, label}`. Steps are re-projected through `client_step`/`client_auth` so only documented fields cross the boundary - a unit test asserts a smuggled `material` field is dropped. Every error is `{errorCode, message, reason?}` with a fixed `errorCode`: `invalid_login_input` (400), `login_unsupported` (422), `login_not_awaiting_input` (409), `login_not_found` (404), `login_expired` (410), `rate_limited` (429, with `Retry-After`), `omp_unavailable`/`omp_busy` (503), `login_failed` (502), `server_error`/`provider_auth_error` (500).

Starting a login is rate-limited to **5 attempts per account per 10 minutes**. A session belongs to the account and device that started it (`cloud_agent_provider_login_sessions`, migration 0102) and is force-expired **20 minutes after creation** regardless of activity - a separate timer from the worker's 15-minute idle sweep, which is activity-based. On a completed worker state the server atomically moves the row `running -> claiming` (so only one concurrent request proceeds), claims the credential from the worker exactly once, and - only if the material looks usable (a non-empty API key or access token) - publishes it as an encrypted provider-auth snapshot before moving the row to `completed`. The snapshot's `authChoice` is `cloud-login:<sessionId>`. Migrations 0100/0101 added the `label`/`model_hint` columns this reuses on `cloud_agent_provider_auth_snapshots`; 0103 added a `method` column on the login-sessions table. Claimed material is never `Debug`-formatted and never logged; a client only ever sees the snapshot's `snapshotId`, `provider`, `authChoice`, and `label`.

### Client flows

The desktop and iOS files this section describes land in gates 2-4 of this PR stack, not with the worker and catalog above.

Three layers, the same shape on desktop and iOS:

1. **Provider detail** - one **Add account** row per provider (desktop `AuthProviderDetail.tsx`, iOS `AccountSheet.swift`).
2. **Method picker** - skipped straight to layer 3 when the provider has exactly one add-method (`addMethods.length === 1` on desktop; `methods.count == 1` on iOS); otherwise it lists Browser sign-in / Device code / API key / Vendor token rows (`providerCopy.ts` labels; iOS `ProviderLoginMethodPicker`).
3. **Login page** - an account-name field, then a transcript that mirrors OMP's own login dialog: the sign-in link and instructions, each prompt or pasted answer in order (secrets hidden), progress lines, then the result (desktop `AuthLoginPage.tsx`, iOS `ProviderLoginScreen`/`ProviderLoginController`).

`app/desktop/src/features/cloud/providerLogin.ts` defines the session types, a fixed error-code-to-message map, and `providerLoginReducer`; `providerAuthClient.ts` calls the catalog, snapshot, and route-test HTTP endpoints; `useProviderLogin.ts` wires the reducer to a `ProviderLoginClient`. `app/desktop/src/dev/previewProviderLogin.ts` and `AuthPreview.tsx` swap in an in-memory client (`createPreviewProviderLogin`) that replays the same session contract with the pinned catalog's real text and never opens a network connection; it is reachable only in dev builds through `?authPreview=start|settings|login`, `&provider=<id>`, and `&method=<key>` (`main.jsx`).

iOS's `ProviderLoginController` drives the same state machine over `CloudProviderLoginTransport` (live) or `PreviewProviderLoginSimulator` (offline, same bundled catalog), reached with `--preview-login-steps=<provider>[:<method>]` (alias `--preview-codex-device-login`), documented in `docs/ios-development.md`.

## Acceptance gates

Rows whose evidence is a server, desktop, or iOS test land with those files in gates 2-4 of this PR stack; the catalog and worker rows are verified by `bun test` in `experiments/omp-provider-routing`.

| Gate | Evidence | Status |
| --- | --- | --- |
| Two Codex accounts coexist | Publish separate choices; list returns both; a run bound to each choice receives the matching synthetic token (`route_sync.rs`). | Verified offline (Postgres e2e, no live network) |
| Provider aliases preserve identity | `openai`, `openai-codex`, `codex` resolve one provider family while `authChoice` stays exact (`route_sync.rs`). | Verified offline |
| Pinned catalog matches OMP | The catalog rebuilt from the pinned dependency deep-equals the checked-in JSON (`catalog-sync.test.ts`). | Verified offline |
| Worker outbound guard | Metadata, private, reserved-suffix, and redirected-to-private targets are refused before anything is sent, including OMP's own Alibaba custom-endpoint login (`outbound-guard.test.ts`, `hosted-login-endpoint.test.ts`). | Verified offline (stubbed fetch and resolver) |
| Claimed endpoint and structured keys | Claimed material carries OMP's `baseUrl` and `api`; structured-key providers get OMP's JSON key (`hosted-login-endpoint.test.ts`, `hosted-credential.test.ts`). | Verified offline |
| One accepts-key rule | Catalog, `/login/start`, and `/validate-key` agree for every provider; route error codes are fixed (`worker-routes.test.ts`). | Verified offline |
| Desktop merge rule | 72 merged rows, OpenAI's four methods, Anthropic's two, single-method skip, short names (`authCatalogMerge.test.ts`, `authProviderConfig.spec.ts`). | Verified offline |
| iOS merge rule | Login methods follow the catalog's kind, key-beside-sign-in, short names, single-method skip, two saved ChatGPT accounts (`ProviderLoginTests.swift`, `ProviderAccountsUITests.swift`). | Verified offline |
| Worker login state machine | The mock `/login/*` mirrors the real contract: steps, claim-once, fixed error bodies (`omp_login.rs`). | Verified offline (mock worker) |
| Server login lifecycle | A Codex login is saved and reused by a route test; cancelled, failed, and expired logins save nothing; start is validated, owned, and rate-limited; no response ever carries material (`login_session.rs`). | Verified offline (Postgres e2e, mock worker) |
| `method: "api-key"` path | An Anthropic key login through the `api-key` method is saved (`login_method.rs`). | Verified offline |
| Hosted OMP route test | Exact-choice binding, mismatched model rejection, public-catalog-vs-authenticated-run split (`route_test.rs`). | Verified offline (mock worker) |
| Real OMP worker code path | The actual `experiments/omp-provider-routing` worker (not a mock) serves 74 catalog rows each with a `login` object, and completes a Groq key login end to end (`real_worker.rs`). Groq's key rule makes no outbound call, so this never reaches Groq's servers. | Verified against the real worker; not a live provider account |
| Beta-app walkthrough (connect, choose route, run test, recover, cross-device) | No automated test drives a live development backend, a real provider sign-in, and a real OMP turn together yet. | Not yet verified |
| Refresh under a per-choice lock | Exercised for the local Rust runner (`agent/crates/cli/src/login/resolver/oauth_refresh.rs`); the OMP worker/server login-session path has no refresh step yet. | Not yet verified for OMP |

## Running the previews and tests

- **Desktop fixture (Tauri preview):** from `app/desktop`, run `KORDI_DEV_PREVIEW_PATH='/?authPreview=settings&provider=openai' VITE_KORDI_CLOUD_API_BASE='http://127.0.0.1:18181' VITE_KORDI_DEV_PROFILE=community pnpm tauri:dev:profile -- --profile <task-name> --port <frontend-port>` (variants: `start`, `settings`, `login`; `login` also takes `&method=<key>`). Cloud-edition previews always use a Tauri dev instance under an isolated `io.kordi.cloud.*` profile, never a bare Vite browser URL; the fixture is dev-only (`import.meta.env.DEV`), offline, and makes no network calls. The Playwright spec below is the only place the fixture is served to a browser.
- **Desktop unit tests:** from `app/desktop`, `npx tsx --test tests/authCatalogMerge.test.ts tests/providerLogin.test.ts tests/providerCopy.test.ts`, or `pnpm test:unit` for the full suite.
- **Playwright:** from `app/desktop`, `pnpm test:visual -- authProviderConfig` (serves the same offline fixture on `127.0.0.1:4174`; the spec itself asserts no request leaves that origin).
- **iOS preview:** in Xcode, add `--preview-login-steps=<provider>[:<method>]` (for example `openai-codex-device`, `anthropic:api-key`) under the `Kordi Beta` scheme's Run arguments, per `docs/ios-development.md`.
- **iOS tests:** the `ProviderLoginTests` unit target and the `ProviderAccountsUITests` UI target, run from Xcode or `xcodebuild test`.
- **Worker bun tests:** `cd experiments/omp-provider-routing && bun install && bun test` (covers `catalog-sync`, `custom-endpoint`, `outbound-guard`, `hosted-login-endpoint`, `hosted-credential`, `worker-routes`, `login-session-store`, `login-step-bridge`, `login-session-routes`, `worker`, `login-real-providers`, and `live-server`). No test reaches DNS or the network; tests use documentation addresses (`192.0.2.x`, `198.51.100.x`, `2001:db8::`) as stand-ins for public ones.
- **Server e2e:** `DATABASE_URL=postgres://<user>:<password>@localhost:5432/<database> cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e -- provider_auth` (migrations run automatically against that database; every test in the file is skipped if `DATABASE_URL` is unset). `real_worker.rs` additionally needs `bun` on `PATH` and `bun install` already run in `experiments/omp-provider-routing`, or it prints a skip reason and passes trivially.

## Known gaps

- Claimed material now always carries `baseUrl` and `api`, but a runner that still falls back to a default host when `baseUrl` is `null` would send the credential to the wrong provider; the runner must refuse such material instead (server gates 2-4).
- The outbound guard checks each target before the request, but the runtime resolves the name again when it connects; production still needs an egress-restricted network for the worker.
- No automated run yet against a live development backend with a real provider account and a real OMP worker turn - the Beta-app walkthrough above stays a manual test.
- The desktop route-test action (`AuthRouteTest.tsx`) has no cancel for a run in progress.
- Desktop does not yet gate send or test on account availability the way iOS does (`Account unavailable` exists only in `AppModel.swift`/`AgentModelSheet.swift`); a routed session whose account was removed is not yet disabled on desktop.
- Codex refresh-token handling for the OMP worker/server login-session path is unsettled; the `agent/crates/cli/src/login/**` changes in this worktree cover the local Rust runner's own refresh, not this path.
- The pinned catalog is frozen at OMP `18.2.11` and regenerated by hand (`bun run export-catalog`); `catalog-sync.test.ts` only catches a missed regeneration after someone bumps the dependency, it does not track new OMP releases on its own.
- `real_worker.rs` proves the real worker code runs a key-based login end to end; it does not prove OMP's `oauth-code` or `device-code` kinds work against a real provider.

## Transfer after this gate

| Stage | Move to OMP | Kordi contract to preserve |
| --- | --- | --- |
| Worker adapter | Claimed-run loop, stream events, provider transport, and model resolution | Run ownership, exact account choice, cancellation, usage and errors. |
| Tool bridge | OMP tool calls and results | Existing tool policy, sandbox isolation, approvals, and artifact export. |
| Session bridge | Turn continuation and context packing | Canonical messages, subsessions, checkpoints, and retry identity. |
| Canary | Selected development accounts and providers first, then measured rollout | Per-run backend selection, parity telemetry, and rollback to the Rust runner. |

Each stage needs a synthetic protocol test, a live development-environment test for the provider methods it enables, and a rollback path. The synthetic probe is a routing proof; it does not establish live provider compatibility, token refresh for non-Codex OAuth, or parity for tools and session continuation.
