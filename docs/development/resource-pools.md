# Resource pools

A resource pool is the deployment's answer to two questions for server-paid
model work: which provider serves it, and how much of it may run. Pools follow
[organizations](organizations.md), not accounts, so two organizations of the
same person can use different pools.

Today pools meter the work the server pays for with its own key:

- **System agent** passes in group conversations, counted per conversation.
- **Grounding** runs (card builds, matching, room themes, group intros and
  nearby request checks), counted per person.

All other model runs (members' agents, Digest, Proactive, the personal agent,
scheduled tasks, document agents) use the owner's own saved provider account
and are not metered by pools.

## Configuration

Pools are read once at startup. Set `KORDI_RESOURCE_POOLS_FILE` to the path of
a JSON pool file; [resource-pools.example.json](resource-pools.example.json)
is a complete example with synthetic values.

Without `KORDI_RESOURCE_POOLS_FILE` the server behaves as before: it builds
one pool named `default` from the System agent's provider settings
(`KORDI_SYSTEM_AGENT_PROVIDER`, `KORDI_SYSTEM_AGENT_OPENAI_*`,
`KORDI_SYSTEM_AGENT_VERTEX_MODEL`, or the shared `KORDI_SERVICE_MODEL_*`), with
no limits, serving every organization.

With a pool file, the default pool's `systemAgent` provider replaces those
provider settings. The System agent's identity settings (`ENABLED`,
`ACCOUNT_ID`, `AGENT_ID`, `AGENT_NAME`, `PERSONA`, `GROUP_CHAT_ENABLED` and
the others) still come from the environment, and
`KORDI_SYSTEM_AGENT_ENABLED=false` still turns the System agent and Grounding
off.

### File format

```json
{
  "version": 1,
  "defaultPool": "shared",
  "pools": [
    {
      "id": "shared",
      "systemAgent": { "...provider..." },
      "grounding": { "...provider, optional..." },
      "limits": { "...optional..." },
      "stopped": false,
      "organizations": []
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. A server refuses a file with a version it does not know. |
| `defaultPool` | The pool for every organization that no pool lists. |
| `pools[].id` | 1 to 64 letters, digits, `.`, `_` or `-`; unique. Stored on each run, so keep it stable. |
| `pools[].systemAgent` | The provider for System agent passes. Required. |
| `pools[].grounding` | The provider for Grounding runs. Defaults to `systemAgent`. |
| `pools[].limits` | Daily limits; see below. Every limit defaults to `"unlimited"`. |
| `pools[].stopped` | Emergency stop. A stopped pool queues nothing and hands no key to a runner, so runs it had already queued fail. |
| `pools[].organizations` | Organization ids (`org_…`) served by this pool. An organization may appear in one pool only. Ids that do not exist on the server are kept, with a startup warning. |

A provider:

| Field | Meaning |
| --- | --- |
| `provider` | `openai` (default), `openai-compatible` (the same), or `openrouter`. |
| `baseUrl` | The OpenAI-compatible endpoint, `https` without credentials, query or fragment. |
| `model` | The model id sent to the endpoint. |
| `apiKeyEnv` | The name of an environment variable that holds the API key. |
| `apiKeyFile` | A file that holds the API key. Exactly one of `apiKeyEnv` and `apiKeyFile`. |
| `headers` | Optional extra request headers, such as a gateway's `HTTP-Referer` and `X-Title` attribution headers. At most 16; printable ASCII. Credential and framing headers (`Authorization`, `Cookie`, `Host`, `Content-Type` and similar) are refused. |
| `estimatedCostMicrosPerRun` | Estimate of one run's cost in millionths of a currency unit, used only by `poolSpendMicrosPerDay`. Required above 0 on every provider of a pool that sets a spend ceiling. |

Use `"provider": "openrouter"` for OpenRouter and other gateways whose model
ids carry a vendor prefix, such as `vendor/model-name`. With `openai`, the
runner treats an `openai/` prefix as redundant and removes it.

Limits are per UTC day. Each is a whole number, or `"unlimited"`. An absent
field and `null` also mean unlimited, but write `"unlimited"` so the intent is
clear. `0` refuses every run:

| Field | Counted per |
| --- | --- |
| `systemAgentRunsPerConversationPerDay` | conversation |
| `groundingRunsPerPersonPerDay` | person (the member the run works for) |
| `poolRunsPerDay` | the whole pool, both features |
| `poolSpendMicrosPerDay` | the whole pool, by `estimatedCostMicrosPerRun` |

### Format versions

This page describes format 1. Deployment configs are written against it, so
its field names stay stable; a change that existing files would not parse the
same way gets a new version number instead. A planned format 2 adds a pool
`executor` (`control_plane` or `pool_worker`) that chooses where a pool's runs
execute; format 1 files will keep loading unchanged.

### Validation

The server refuses to start when the file is missing, larger than 256 KiB,
not valid JSON, has an unknown field, names an unknown default pool, repeats a
pool id, binds an organization twice or without the `org_` prefix, sets a
spend ceiling without cost estimates, or has an invalid provider, URL, model,
header, or an API key that cannot be read. Messages name the pool and field.
They never contain a key, and a value that might be a pasted key is not
echoed. The startup log lists each pool's id and limits only.

## Which pool serves a run

- A System agent pass uses the pool of its conversation's organization.
- A Grounding run in a conversation (a group intro) uses that conversation's
  organization; any other Grounding run uses the requester's personal
  organization, since there is no organization selection yet.
- An organization no pool lists, and a record without an organization, use
  the default pool.

The pool id is stored on the run (`runtime_route_json.resourcePool`) together
with the provider and model, and the run's `organization_id` is set to the
organization that was charged. When a runner fetches the run's credential, the
server returns the key, base URL, model and headers of that pool only. Runs
queued before pools existed have no pool id and belong to the default pool.

## Limits and silence

Admission happens in the transaction that queues the run:

1. A reservation row keyed by the run id is inserted. If it already exists,
   the run was admitted before and nothing is counted again.
2. The scope counter (conversation or person) and then the pool counter are
   raised by one upsert each, which only passes while the counter is below its
   limit. The row lock of the upsert serializes concurrent admissions, so a
   limit is never passed.
3. If any limit is reached, the admission's savepoint rolls back and the run is
   not queued.

Only limited counters are kept: a pool without a pool-wide limit keeps no
pool counter, and a run with no limited counter at all (every run of the pool
built without a pool file) is admitted without any write.

When the System agent is refused, it stays silent: no message, nothing
queued, and nothing replayed later. The conversation's message cursor moves
past the new messages, due reminders are marked as fired, and every card the
pass was woken for is marked as seen, exactly as if the pass had run and chosen to say nothing.
The first refusal of a window is recorded for Settings (see
[Usage and limits](#usage-and-limits)); nothing is posted into the
conversation. A
refused Grounding request gets the usual "Grounding isn't available" answer
(card builds), the matching budget answer with the time until the next UTC
day (matching and room themes), or nothing at all (group intros, nearby
checks).

Settlement happens when the run ends, in the same transaction as the run's
final state, and is idempotent (`reserved` becomes `consumed` or `released`
once):

- A completed run, or a failed run that a runner had claimed, is consumed: a
  model may have been called.
- A run that failed or was cancelled before any runner claimed it is
  released, and its count is given back.
- A run that ends by another path (a stop, an expiry, a deleted account) is
  settled by the System agent worker within about a minute, by the same rule.

Usage older than 90 days is pruned about once an hour by the System agent
worker.

## Usage and limits

Every limit a person can hit is visible in Settings: how much is used, when
it resets and why nothing more is admitted. Conversations stay clean: a limit
never adds a message, error, banner or toast to a chat, and the composer and
send flow are not blocked. The server builds one snapshot shape from the
counters above (`resource_pools::snapshot`), and clients show it as-is:

```json
{
  "limitId": "pool.runs",
  "scope": "pool",
  "used": 150,
  "limit": 200,
  "usedPercent": 75,
  "window": "day",
  "resetsAt": "2030-01-03T00:00:00Z",
  "reached": "none"
}
```

- `limitId` is `conversation.system_agent_runs`, `account.grounding_runs`,
  `pool.runs`, `pool.spend`, or `pool.stopped` (a stopped pool without
  limits). Unlimited limits have no snapshot.
- `scope` is `pool`, `conversation` or `account`; `window` is always `day`,
  and `resetsAt` is the next UTC midnight.
- `usedPercent` is rounded down and capped at 100.
- `reached` is `none`, `daily_limit`, `spend_limit` (the next run's estimated
  cost no longer fits) or `stopped` (the pool's stop switch is on).
- `used` and `limit` (runs, or millionths for spend) are sent only to owners
  and admins of the organization. Members see percentages, reasons and reset
  times only.
- The per-conversation limit shows the caller's busiest conversation of the
  organization today, named by `conversationId`.
- `pausedSince` is set on a reached limit once it refused the System agent in
  this window.

Routes, behind the cloud session:

- `GET /v1/cloud/account/usage`: every organization of the signed-in account
  (personal first) with its `name`, `kind`, the caller's `role` and its
  snapshots: the pool's caps, the per-conversation cap, and in the personal
  organization the caller's Grounding cap.
- `GET /v1/cloud/organizations/{id}/usage`: the same for one organization;
  404 outside it.

When the System agent is refused, the first refusal of each window is kept in
`cloud_usage_pauses` per pool and conversation, with the limit and reason, so
Settings can say "Paused since 14:20, resets 00:00 UTC". Clients color a bar
amber at 75% and red at 90% or when reached; that is the only warning. There
are no notices, emails or push notifications for limits.

## Storage

Migration 0166 adds `cloud_resource_pool_usage`
(one counter per pool, UTC day, feature and scope) and
`cloud_resource_pool_reservations` (one row per admitted run). Migration 0174
adds `cloud_usage_pauses` (the first refusal per pool, conversation and day),
pruned with usage.

## Tests

Unit tests cover file parsing and validation, pool resolution, the per-pool
credential a runner receives, and (in the runner) the request shape sent to an
OpenAI-compatible endpoint. Database tests are ignored by default and need a
task-owned PostgreSQL in `DATABASE_URL`:

```bash
DATABASE_URL=postgres://... cargo test -p kordi-cloud-server --lib -- resource_pools system_agent::pool_tests system_agent::usage_pause_tests common_ground::runs --include-ignored --test-threads=1
```
