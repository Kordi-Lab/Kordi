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
  namespaced: `gmail.search`, `calendar.list_events`, `calendar.respond`,
  `github.notifications`, `github.comment`, `slack.read_channel`, `slack.post`.
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

### What shipped in PR 5

Consent boundary (server, `bridges/cloud-server`):

- Migration `0116_run_connector_audience.sql` adds `connector_audience`
  (`owner_private` or `shared`, default `shared`) to
  `cloud_agent_fallback_runs`. Existing runs become shared runs and get no
  connector tools.
- `connectors::audience::audience_for_message` decides the audience where the
  trigger is decided. A run is `owner_private` only when the owner sent the
  message and the session is a `kind = 'ai'` conversation the owner created
  that has never had another member. Group conversations, contact-started and
  shared-agent runs, sessions without a conversation row, and PiP runs are
  `shared`. Digest runs are `owner_private` (background, so read only).
  Scheduled occurrences follow their session and creator (a task in the
  owner's private conversation is `owner_private`; the default
  `session:scheduled:<owner>` session has no conversation row and stays
  `shared`). Spawned subsessions inherit the parent run's audience;
  subsession messages use the parent session.
- `delivery::tools_for_run` returns no tools at all for a `shared` audience,
  whatever the trigger. The lease (cloud runner and desktop claim) carries
  `connectorAudience`. The source-scan test now requires every run insert to
  name both `run_trigger` and `connector_audience`.
- Broker: `declinedByOwner: true` on `POST /internal/connectors/call` writes a
  `denied` audit row for a tool on the lease and returns `declined_by_owner`
  without reaching the provider.

Mac approval for `act` tools:

- `DesktopRuntimeSession::set_tool_approval_hook` wires
  `ToolContext.request_approval` from `chat/tool_approval.rs`. A connector
  `act` call emits `desktop_tool_approval_request` (`{ requestId, tool,
  summary, connector, args }`), waits for
  `desktop_tool_approval_respond(requestId, approved)`, and denies after five
  minutes; `desktop_tool_approval_resolved` clears the card. Other tools that
  ask for approval are refused, as before.
- The webview shows an inline card above the composer ("Your agent wants to
  <summary> in <connector>." with Allow and Not now).
- When the person declines, `ConnectorToolsRuntime.report_declined` posts the
  `declinedByOwner` call so the settings log shows the denial.

Chat affordance:

- `connectors_request_connect` (`kordi_tools::connector_request_connect`) takes
  `{ provider }` and returns `{ openUrl, message, instruction }` with
  `kordi://settings/connectors?provider=<id>`. It performs no grant. The cloud
  runner offers it on `owner_private` leases; the Mac offers it on
  `owner_private` cloud leases and on the owner's own local turns.
- Desktop: message Markdown renders the link as an in-app link that opens
  account settings on the `connectors` tab and stores the provider for the
  detail view (`takePendingConnectorsProvider`). This branch does not contain
  the Connectors panel from PR 0, so the tab shows Profile until that branch
  merges; the panel should read the pending provider into `selectedId`.
- iPhone: `ConnectorsSettingsLink.parse` handles the URL from `onOpenURL` and
  in-app links, and opens the account sheet. Opening the `.connectors` route and
  pushing the provider detail waits for the iPhone Connectors screen.

Still waiting:

- #1686 and #1687: contact consent tables and the AI opt-out for people who
  are also contacts. Until then the boundary above withholds connector data
  from every run another account can read.
- #1685: the content removal worker that drains
  `cloud_connector_removal_requests` on disconnect.
- #1711: the capability-profile intersection and the "Ask me before" list UI.
  Every `act` tool asks today.

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
