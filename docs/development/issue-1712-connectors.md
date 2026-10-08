# Issue 1712: Connectors implementation plan

Status: proposal, 2026-10-06. Tracks [#1712](https://github.com/Kordi-Lab/Kordi/issues/1712).

## Summary

Connectors are Kordi host tools, not an OMP feature. The server (or the owner's
Mac) holds the credential, executes each tool call, and hands only the result to
the run. The work lands in six pull requests that each leave `main` shippable.
The desktop settings surface ships first behind a server capability flag so the
product shape can be reviewed before any token is stored.

| PR | Scope | Depends on |
|---|---|---|
| 0 | Desktop `Connectors` settings tab with a preview client (this branch) | nothing |
| 1 | Server connector framework: tables, token broker, OAuth, capability flag, routes | nothing |
| 2 | Tool delivery to both runtimes with the `read` and `act` split and background gating | 1 |
| 3 | Google Calendar and GitHub end to end, events, digest input; Gmail and Slack follow the same shape | 1, 2 |
| 4 | Mac-local connectors: EventKit, Contacts, experimental Notification Center | 2 |
| 5 | Consent, deletion, audit, per-agent grants wired to #1685, #1686, #1687, #1710, #1711; iPhone settings; chat affordance | 1 to 4 and the trust stack |

## Decisions

- **No MCP, no extension discovery.** `shared/omp-runtime/src/capabilities.ts`
  keeps `enableMCP: false` and `disableExtensionDiscovery: true`. Connector tools
  arrive through `request.tools`, which `runtime.ts` already wraps as
  `customTools` that call back into the host. The existing runtime test that
  asserts the OMP options stays as the guard.
- **Tokens never enter a run.** A run receives tool descriptors only. The cloud
  runner calls the server's broker route with the run lease; the server loads the
  secret, calls the provider, and returns the result. The Mac path does the same
  through the desktop process for Mac-local sources. No route, lease, event, or
  tool result carries a token field. This mirrors the device-proof rule from
  #1680 for provider keys.
- **Read first, act second.** A connector's first grant requests read scopes
  only. `act` scopes are a separate OAuth grant the person starts from settings
  ("Let my agent act here"). The settings copy states that background runs never
  receive `act` tools.
- **Policy lives at the server and harness, never in the prompt.** The server
  decides which tools a run may receive from its trigger (person-started or
  background), the owner's connector grants, and the agent's capability profile
  from #1711. The harness registers only what the server delivered. Prompt text
  only restates the result.
- **Feature flag by capability.** The server reports `connectorsVersion` in the
  `/v1/cloud/auth/capabilities` response (`AuthCapabilitiesResponse` in
  `bridges/cloud-server/src/auth/routes/types.rs`). Desktop and iPhone show the
  section only when the field is present. The desktop already fetches this route
  in `useCloudSession.ts`.
- **Mac-local sources go through system permissions, not the Notification Center
  database.** EventKit, Contacts, and Automation permissions are sanctioned. The
  Notification Center reader is offered as an experimental, off-by-default,
  read-only connector that requires Full Disk Access and is absent when either
  condition fails.

## Sites without a connector: the Airbnb case

Neither peer reaches Airbnb through a connector. Airbnb offers no agent API,
has kept booking out of ChatGPT while Booking.com and Expedia went in, and its
CEO answered "probably not" when asked whether outside agents may book stays;
Airbnb plans its own agent for 2027. What the peers do instead:

- **Meta Muse** drives a browser over Airbnb's public pages the way a person
  would (destination, dates, guests, results) and stops when Airbnb asks for
  payment. Flights are different: Muse has a real integration (Duffel inventory,
  Stripe virtual card). Hotels and stays are just websites being visited.
- **OpenAI dots** uses the ChatGPT app and plugin ecosystem for the apps that
  have one, and otherwise its own cloud computer and browser. On supported sites
  it can sign in with saved passwords without the model seeing them. Background
  "proactive research" cannot control a browser or computer at all.

Consequence for Kordi: connectors cover services with an API and a consent
flow. Everything else is the browser path, which Kordi already has on the
owner's Mac (`computer` and `browser` in `shared/omp-runtime/src/capabilities.ts`,
gated by `ownerLocal`). The plan keeps that split explicit:

- Browser tasks run only in a turn the person started, on the owner's Mac, in
  the person's own signed-in browser profile; background runs never get the
  browser, matching the dots rule and the `read`-only rule for connectors.
- Checkout, payment, and sign-in stay with the person: the agent stops at the
  payment step and hands the window back, the same handoff Muse makes on Airbnb
  and Operator makes on credentials. No saved-password sign-in by the agent in
  the first wave.
- A cloud browser is out of scope until the trust layer in #1711 can carry an
  "Ask me before" approval for every purchase-shaped action.
- The settings page should say this plainly under Connectors: "Sites without a
  connector are handled in your browser on this Mac, only when you ask."

## PR 0: Desktop settings preview (this branch)

- `app/desktop/src/features/connectors/connectorsModel.ts`: provider catalog,
  scope groups, state and audit types, and the pure helpers
  `connectorToolGroupsForRun`, `disconnectConsequences`, `connectorStatusLabel`.
- `app/desktop/src/features/connectors/connectorsClient.ts`: the
  `ConnectorsClient` interface the panel talks to and an in-memory preview
  implementation. `connectorsClientForEnvironment()` returns it only when
  `VITE_KORDI_CONNECTORS_PREVIEW=1`; otherwise the tab is absent, so merging this
  PR changes nothing for installed apps.
- `app/desktop/src/features/connectors/ConnectorsSettingsPanel.tsx`: the
  `Connectors` tab in `CloudAccountSettingsDialog`. Services and On this Mac
  groups; per connector: status, scopes, "Let my agent act here", agents that may
  use it, background-run note, activity log, disconnect with the exact deletion
  statement.
- Unit tests for the helpers and the panel, and the English check.
- Review questions for this preview: the two-group layout, the wording of the
  act toggle, whether agent grants belong here or in the Agent page from #1711,
  and whether the activity log should be a dialog or its own tab.

## PR 1: Server connector framework

Crate: `bridges/cloud-server` (cloud-specific code stays out of `bridges/cli`).
New module `bridges/cloud-server/src/connectors/` with `models.rs`, `store.rs`,
`routes.rs`, `oauth.rs`, `broker.rs`, `events.rs`, and tests.

Schema (one migration, Postgres path in `pg/`):

- `cloud_connectors(connector_id, account_id, provider, status, read_scopes,
  act_scopes, act_enabled, created_at, updated_at, revoked_at)`.
- `cloud_connector_secrets(connector_id, ciphertext, nonce, key_version,
  refresh_ciphertext, expires_at, updated_at)`, encrypted with the same cipher
  as `cloud_agent_runtime/provider_auth/cipher.rs`, read only by the broker.
- `cloud_connector_agent_grants(connector_id, agent_id)`.
- `cloud_connector_events(event_id, connector_id, provider, kind, external_id,
  occurred_at, payload, received_at, expires_at)` with a retention job.
- `cloud_connector_audit(audit_id, connector_id, run_id, agent_id, tool,
  tool_group, outcome, summary, created_at)`.

Routes under `/v1/cloud/connectors`:

- `GET /` list for the signed-in account, never including secrets.
- `POST /:provider/oauth/start` with `{ "grant": "read" | "act" }`, returning
  the provider URL. Separate OAuth client registrations from the sign-in clients
  in `auth/oauth.rs`; the callback handler stores the secret and the granted
  scopes and marks `status`.
- `POST /:id/act` to toggle `act_enabled` (requires granted act scopes).
- `PUT /:id/agents` to replace the grant set.
- `GET /:id/audit` paged.
- `DELETE /:id` revokes at the provider where supported, deletes the secret row,
  deletes `cloud_connector_events` for it, enqueues derived-copy removal, and
  writes an audit row.
- Internal broker route for runners, authenticated with the runner token:
  `POST /internal/connectors/call` with `{ lease, connector_id, tool, args }`.
  The server checks the lease, the account, the grant set, the tool group
  against the run trigger, and executes the provider call.

Tests: response-shape scan that fails if any serialized connector type contains
a key matching `token`, `secret`, `refresh`, or `ciphertext`; broker rejects an
`act` tool for a background lease; disconnect removes the secret and events and
enqueues removal (database-backed); `connectorsVersion` appears in capabilities.

### Connectors

Environment variables introduced by PR 1. Each provider pair is a separate
OAuth client registration from the sign-in clients (`KORDI_OAUTH_*`); never
reuse the sign-in apps. When a pair is missing,
`POST /v1/cloud/connectors/:provider/oauth/start` returns 503 for that
provider, and `/v1/cloud/auth/capabilities` still reports `connectorsVersion`.

| Variable | Used for |
|---|---|
| `KORDI_CONNECTOR_GOOGLE_CLIENT_ID`, `KORDI_CONNECTOR_GOOGLE_CLIENT_SECRET` | `google_calendar` and `gmail` |
| `KORDI_CONNECTOR_GITHUB_CLIENT_ID`, `KORDI_CONNECTOR_GITHUB_CLIENT_SECRET` | `github` |
| `KORDI_CONNECTOR_SLACK_CLIENT_ID`, `KORDI_CONNECTOR_SLACK_CLIENT_SECRET` | `slack` (user-token scopes) |
| `KORDI_CONNECTOR_EVENT_RETENTION_DAYS` | Event retention, default 30, accepted range 1 to 365 |

Existing variables the connectors reuse: `KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY`
and `KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY_ID` (secret encryption; without
the key, connecting and broker calls fail closed), `KORDI_CLOUD_RUNNER_TOKEN`
(broker route), `KORDI_CLOUD_PUBLIC_BASE_URL` (callback URL), and
`KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST` (app redirect after the grant).

Each provider app must register the callback
`<KORDI_CLOUD_PUBLIC_BASE_URL>/v1/cloud/connectors/oauth/callback`.

The broker route is `POST /internal/connectors/call`. PR 2 added the lease
check: see "What shipped in PR 2" below.

## PR 2: Tool delivery to the runtimes

- Server: when a run is admitted in `cloud_agent_runtime`, compute the connector
  tool set from the owner's connectors, the grant set for the agent, the agent's
  capability profile (#1711, intersect only), and the trigger. Background and
  scheduled runs (`pip/`, `digest/`, `scheduled_tasks/worker.rs`) get `read`
  tools only. Put the descriptors in the lease.
- Cloud runner: `bridges/cloud-agent-runner` turns each descriptor into a host
  tool whose `execute` calls the broker route. `tool_policy.rs` gains a
  `connector.*` arm that only allows names present in the lease. Tool names are
  namespaced with an underscore, because model providers reject dots in
  function names (`^[A-Za-z0-9_-]+$`): `gmail_search`, `calendar_list_events`,
  `calendar_respond`, `github_notifications`, `github_comment`,
  `slack_read_channel`, `slack_post`. A runtime recognises a connector tool by
  its presence on the lease, with a shape check of `^[A-Za-z0-9_-]{1,64}$`.
- Mac harness: `agent/crates/cli/src/session_bootstrap.rs` registers connector
  tools from the desktop runtime's tool list; service connectors still call the
  server broker, Mac-local connectors call into the Tauri process. `act` tools on
  the "Ask me before" list use the existing `request_approval` hook in
  `ToolContext`.
- Tests: server test that a scheduled run lease contains no `act` tool; runner
  test that a connector tool not in the lease is refused; Mac harness test that
  an agent without a grant does not see the connector's tools; OMP runtime test
  that `enableMCP` and extension discovery stay off.

### What shipped in PR 2

Server (`bridges/cloud-server`):

- Migration `0115_run_trigger_connector_tools.sql` adds two columns to
  `cloud_agent_fallback_runs`: `run_trigger` (`person_started` or
  `background`, default `background`) and `connector_tools_json` (the
  descriptors delivered with the lease, default `[]`). Existing runs become
  background runs.
- Every run creation site names its trigger. A run is `person_started` only
  when the person who sent the message owns the agent: the claim route
  (`claim_run_for_person_message`), the desktop claim
  (`claim_run_for_desktop`), and a subsession message from the owner.
  Scheduled task occurrences (`claim_run`), PiP runs, digest runs, spawned
  subsessions, and runs requested by a contact or a shared-agent member are
  `background`. A test scans the run inserts so a new one must name its
  trigger.
- `connectors::delivery::tools_for_run(pool, providers, account_id, agent_id,
  trigger)` returns `LeaseConnectorTool` descriptors from the owner's
  connected connectors, the agent grant set, and `allowed_tool_groups`.
  `deliver_to_run` computes them when a run is leased, stores them on the
  run, and returns them; errors deliver an empty set. Argument schemas live
  in `connectors/tool_schemas.rs` until the PR 3 adapters add their own.
- Lease fields on `RunnerRunResponse` (inside `RunnerLeaseResponse.run`) and
  on the desktop claim response: `trigger` and `connectorTools`, where each
  entry is `{ connectorId, provider, name, group, description, inputSchema }`.
- Broker: `POST /internal/connectors/call` takes `{ leaseId, runnerId |
  claimId, connectorId, tool, args }`. With the runner token, `runnerId` must
  hold the active cloud lease; with a desktop session, `claimId` must hold the
  active desktop lease of that device and account. The account, agent, and
  trigger come from the lease; `accountId`, `agentId`, and `trigger` in the
  body are ignored and logged when they disagree. A tool that is not in the
  lease's stored descriptor set is refused with `tool_not_on_lease` and a
  `denied` audit row, even when the grants changed after the lease was issued;
  a missing, expired, or foreign lease is refused with `lease_invalid`.

Cloud runner (`bridges/cloud-agent-runner`):

- `CloudAgentRun.connectors` reads `trigger` and `connectorTools` from the
  lease. `connectors.rs` turns each descriptor into a model tool for both the
  OMP and the legacy loop, lists them in the system prompt (with a sentence
  that background runs only have read tools), and executes calls through
  `CloudAgentRunClient::call_connector_tool`, which posts to the broker with
  the lease id and runner id and returns the `result` or a clear error.
- `tool_policy::decide_runner_tool` has a connector arm: a namespaced name is
  allowed only when it is on the lease, otherwise the existing "not
  available" decision.

Mac harness and desktop:

- `kordi_tools::connector_tools` has `ConnectorToolDescriptor`,
  `ConnectorToolsRuntime`, and `ConnectorTool`, which fails closed when
  `ToolContext.connector_tools` is `None` or no longer lists the tool. Every
  `act` tool calls `ToolContext.request_approval` first and is refused when
  there is no approval hook or the run is non-interactive; the desktop does
  not wire an approval hook yet, so `act` tools on the Mac stay refused until
  the "Ask me before" UI lands.
- `ToolRegistry::set_connector_tools` registers one tool per descriptor for
  each turn (never replacing an existing tool) and removes them on the next
  turn; shared requests from other people never get them.
- Tauri: `chat/connector_tools_runtime.rs` builds the runtime from the cloud
  lease's `connectorTools` on the cloud-lease path in
  `session_preparation.rs` and posts calls to the broker with the signed-in
  session, the run id, and the claim id. The desktop forwards
  `connectorTools` from the claim response into `executionLease`.

OMP runtime: no option changes; the capabilities test asserts that connector
tool names in the host tool list keep `enableMCP` off and extension discovery
disabled.

## PR 3: First service connectors

Order: Google Calendar read, GitHub read, then Calendar act (RSVP through the
plan-card approval from #1546), Gmail read, Gmail send behind approval, Slack
read for chosen channels, Slack post behind approval. Outlook and Microsoft 365
are a second wave.

- Provider adapters in `connectors/providers/{google_calendar,gmail,github,slack}.rs`
  with a common trait: `read_tools()`, `act_tools()`, `execute(tool, args,
  secret)`, `refresh(secret)`, `revoke(secret)`, `subscribe(webhook)`, `poll()`.
- Events: GitHub and Slack webhooks, Google Calendar watch and Gmail push
  through Pub/Sub where configured, and a polling fallback in
  `scheduled_tasks/worker.rs` for every provider. Events land in
  `cloud_connector_events` and become an input for `digest/` and for the PiP
  worker, read-only.
- Rate and cost: per-account budget on broker calls, reusing the action budget
  pattern from #1672.

### What PR 3 ships

- Providers in `connectors/providers/{google_calendar,gmail,github,slack}.rs`,
  each a `ServiceAdapter` paired with the shared OAuth 2 client
  (`providers/service.rs`, `providers/oauth2.rs`). Provider HTTP goes through
  `providers/http.rs`: bearer auth, a 20 second timeout, a 2 MiB response
  bound, lists capped at 50 items and free text at 4,000 characters. Results
  are built field by field, so no header, token, or page cursor reaches a run.
- Tools (underscored names; argument schemas in `connectors/tool_schemas.rs`
  through each provider's `input_schema`):
  - Google Calendar: `calendar_list_events` (read, window up to 31 days),
    `calendar_respond` (act), `calendar_create_event` (act).
  - Gmail: `gmail_search` (read, up to 25), `gmail_read_message` (read),
    `gmail_send` (act, plain text, header injection rejected).
  - GitHub: `github_notifications` (read), `github_pull_request` (read: state,
    reviews, checks summary), `github_comment` (act).
  - Slack: `slack_read_channel` (read) and `slack_post` (act), both limited to
    the channels saved in the connector settings.
- Migration 0115 adds `settings` (JSONB object), `provider_account_id`,
  `last_event_at`, `last_polled_at`, and `subscribed_at` to
  `cloud_connectors`, and a unique `(connector_id, external_id)` index on
  `cloud_connector_events` so every event is stored once.
- `PUT /v1/cloud/connectors/:id/settings` validates per provider. Slack takes
  `{ "channels": ["C0123ABCD"] }` (at most 50 channel ids); other providers
  accept only `{}`.
- `GET /v1/cloud/connectors` also returns `agents` (the built-in agent named
  from the account's agent profile, then active defined agents), and each
  summary carries `grantedScopeIds` in the client catalog ids, `settings`, and
  `lastEventAt`.
- The broker refreshes once and retries when a provider answers 401 to a live
  token (`connectors/credentials.rs`).
- Events: `POST /v1/cloud/connectors/webhooks/github` (HMAC
  `X-Hub-Signature-256`; delivery id dedupes replays; recorded for the
  reviewer, assignee, or author, never the sender),
  `POST /v1/cloud/connectors/webhooks/slack` (signing secret, five minute
  timestamp window, URL verification; only chosen channels), and
  `POST /v1/cloud/connectors/webhooks/google` (Gmail Pub/Sub push; the OIDC
  bearer is checked through Google's token info endpoint for audience, issuer,
  expiry, and the push service account; rejected when unconfigured).
  Connectors are found by the provider account stored at grant time (GitHub
  user id, Google email, Slack `team:user`).
- Polling fallback (`connectors/polling.rs`, started from
  `scheduled_tasks/worker.rs`): every connected connector without a live
  subscription is polled every `KORDI_CONNECTOR_POLL_MINUTES`; connectors with
  one only renew it daily (Gmail `users.watch`). Google Calendar push uses
  plain channel callbacks rather than Pub/Sub, so Calendar always polls.
- Digest input: `connectors::digest_input::recent_events` (last 7 days, at
  most 100, live connectors only) feeds `connectorEvents` in the digest input
  and its incremental changes; the system prompt treats them as read-only
  context that is never a source.

Environment variables introduced by PR 3:

| Variable | Used for |
|---|---|
| `KORDI_CONNECTOR_GITHUB_WEBHOOK_SECRET` | GitHub webhook HMAC; when set, GitHub connectors stop polling |
| `KORDI_CONNECTOR_SLACK_SIGNING_SECRET` | Slack request signatures; when set, Slack connectors stop polling |
| `KORDI_CONNECTOR_GOOGLE_PUSH_AUDIENCE` | Audience of the Pub/Sub push OIDC token |
| `KORDI_CONNECTOR_GOOGLE_PUSH_SERVICE_ACCOUNT` | Service account the push subscription signs as; required with the audience |
| `KORDI_CONNECTOR_GMAIL_PUBSUB_TOPIC` | `projects/<p>/topics/<t>` for Gmail `users.watch`; with the two above, Gmail stops polling |
| `KORDI_CONNECTOR_POLL_MINUTES` | Polling interval, default 15, accepted range 1 to 1440 |

## PR 4: Mac-local connectors

- Tauri commands in `app/desktop/src-tauri/src/connectors/`: EventKit (Calendar
  and Reminders), Contacts, and Automation-based Mail and Messages readers,
  each behind the macOS permission prompt and exposed only on owner-local runs
  through the `ownerLocal` gate in `capabilities.ts`.
- Notification Center reader: off by default, requires Full Disk Access, returns
  app name, title, body, and time for a bounded window, never writes the body to
  lessons or OMP state (ties to the sensitive-content rule in #1710), and the
  tool is absent when Full Disk Access is missing or the setting is off, with a
  Tauri-side test.
- iPhone offers EventKit and Contacts only.

## PR 5: Consent, deletion, audit, iPhone, chat

- Data about other people from a connector (senders, attendees, members) is
  treated like message content under #1686 and #1687: never shown to another
  account's agent, and the AI opt-out applies to anyone who is also a contact.
- Disconnect enqueues derived-copy removal through the content removal worker
  from #1685 once it lands; until then PR 1 records the removal request in a
  table the worker will drain, so the user-facing promise holds.
- The per-agent grant and the "Ask me before" list reuse the policy tables from
  #1711; if #1711 lands later, PR 2 keeps the grant table from PR 1 and #1711
  adds the capability-profile intersection.
- iPhone: a `Connectors` screen mirroring the desktop tab, hidden without
  `connectorsVersion`.
- Chat affordance: "connect my Gmail" in a conversation opens the same flow; the
  agent gets a `connectors.request_connect` tool that only returns a deep link,
  never performs the grant.
- Every read and act call writes an audit row; the settings log reads it.

## Acceptance mapping

| Criterion in #1712 | Where it is tested |
|---|---|
| No route or tool result contains a token | PR 1 response-shape scan |
| Background runs cannot call `act` | PR 1 broker test, PR 2 server lease test, PR 2 Mac harness test |
| Agent without a grant does not see tools | PR 2 runner and Mac harness tests |
| Disconnect removes token and events, enqueues removal | PR 1 database-backed test |
| Notification Center absent without Full Disk Access or when off | PR 4 Tauri test |
| Older server hides the section | PR 0 unit test on the capability gate, PR 5 iPhone test |
| OMP settings unchanged | existing runtime test, re-asserted in PR 2 |
| Copy passes `pnpm check:english` | every PR |

## Open questions for review

1. Should agent grants live on the connector (this preview) or on the Agent page
   from #1711, with the connector page showing a read-only summary? Keeping both
   editable risks two sources of truth.
2. Do we want the act grant to be provider-wide or per tool (for example "Send
   mail" without "Archive and label")? The preview shows provider-wide act with
   a scope list; per-tool would need a second settings level.
3. Where do webhook secrets and Pub/Sub topics live for the dev stack? This
   affects whether PR 3 can be tested on the shared development backend or needs
   an allocated stack.
4. Is the experimental Notification Center connector worth shipping in the first
   wave, given it needs Full Disk Access and is undocumented on Apple's side?
