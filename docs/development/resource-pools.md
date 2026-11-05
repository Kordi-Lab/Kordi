# Resource pools

A resource pool is the deployment's answer to two questions for server-paid
model work: which provider serves it, and how much of it may run. Pools follow
[organizations](organizations.md), not accounts, so two organizations of the
same person can use different pools.

Pools meter server-paid model work:

- **System agent** passes in group conversations, counted per conversation.
- **Grounding** runs (card builds, matching, room themes, group intros and
  nearby request checks), counted per person.

All other model runs (members' agents, Digest, Proactive, the personal agent,
scheduled tasks, document agents) use the owner's own saved provider account
and are not metered by pools.

A pool runs its work in one of two places, its **executor**:

- `control_plane`: the server's own runners call the pool's provider with a
  key the server holds (every format 1 pool).
- `pool_worker`: the pool's own worker, in the sponsor's cloud project, claims
  the pool's runs and calls its own provider with its own credential. The
  control plane never holds that credential. See [Pool workers](#pool-workers).

## Configuration

Set `KORDI_RESOURCE_POOLS_FILE` to the path of a JSON pool file.
[resource-pools.example.json](resource-pools.example.json) (format 1) and
[resource-pools.v2.example.json](resource-pools.v2.example.json) (format 2)
are complete examples with synthetic values. Organization bindings may also
come from the organizations file (`KORDI_ORGANIZATIONS_FILE`); see
[Bindings from the organizations file](#bindings-from-the-organizations-file).

Both files are read at startup and again without a restart; see
[Reloading](#reloading).

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
| `version` | `1` or `2`. A server refuses a file with a version it does not know. |
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

The tables above describe format 1. Deployment configs are written against
it, so its field names stay stable; a change that existing files would not
parse the same way gets a new version number instead. Format 1 files load
unchanged on servers that read format 2.

Format 2 (`"version": 2`) adds, per pool:

| Field | Meaning |
| --- | --- |
| `executor` | Required: `control_plane` or `pool_worker`. |
| `worker.identityEnv` | `pool_worker` only: the name of an environment variable that holds the accepted worker identity as JSON (below). Exactly one of `identityEnv` and `identity`. An unset or empty variable accepts no worker. The variable is read at startup, so changing it needs a restart; to revoke a worker without one, use an inline `identity` and remove it, or stop the pool. |
| `worker.identity` | `pool_worker` only: the identity inline, which a reload picks up. Two pools may not accept the same identity. |
| `estimatedCostMicrosPerRun` | `pool_worker` only: one run's estimated cost for either feature. Required above 0 with `poolSpendMicrosPerDay`. |

A `control_plane` pool is written as in format 1. A `pool_worker` pool has no
`systemAgent` or `grounding` provider and no key: the server refuses one that
names them. `limits`, `stopped` and `organizations` mean the same for both.
The `defaultPool` must be a `control_plane` pool, because the System agent's
own definition takes its model from it.

A worker identity names who may act as the pool's worker, not a secret:

```json
{
  "issuer": "https://issuer.example.test",
  "audience": "https://control-plane.example.test",
  "subject": "123456789",
  "email": "worker@sponsor-project.example.test",
  "jwksUri": "https://issuer.example.test/keys"
}
```

| Field | Meaning |
| --- | --- |
| `issuer` | The exact `iss` of the worker's identity token. |
| `audience` | Must appear in the token's `aud`; the worker asks for a token for this audience. |
| `subject` | The exact `sub`, such as a service account's unique id. |
| `email` | The exact `email`, which must be verified (`email_verified`). At least one of `subject` and `email`. |
| `jwksUri` | Optional. The issuer's signing keys; default: `jwks_uri` from `<issuer>/.well-known/openid-configuration` (then `issuer` must be https). |
| `jwks` | Optional inline JWK set, for an issuer that publishes no keys. |

### Bindings from the organizations file

When `KORDI_ORGANIZATIONS_FILE` is set, pools also read these fields of it,
and ignore every other field:

| Field | Meaning |
| --- | --- |
| `organizations[].id` | The organization's configuration id. |
| `organizations[].pool` | The pool it is bound to, or `null` for the default pool. |
| `organizations[].state` | `disabled`: the organization's System agent and Grounding work is refused. |
| `personalOrganizations.pool` | Must equal `defaultPool` when set. |

A configuration id binds once the organization exists on this server
(`cloud_organizations.config_id`, created by admission from configuration).
An organization that does not exist yet has no work to route; the server
checks again about once a minute. A binding that names an unknown pool, or
contradicts an `organizations` entry of the pool file, makes the
configuration invalid, and so does a file that binds organizations on a
database without configured organizations: bindings are never silently
dropped to the default pool.

### Reloading

The server reads both files again on `SIGHUP` and within about five seconds of
either file changing. A reload validates everything a startup does (keys,
identities, bindings) and swaps the new configuration in only when all of it
is valid. An invalid file is logged once with the reason, and the previous
configuration stays in force. A file counts as seen in the state it had
before it was read, so a file read while still being written is read again
once the write finishes. If the database cannot be reached to look up
configured organizations, the files still apply (a stop is never held back)
with the bindings found last time, and the lookup is retried every few
seconds. Each run is admitted against one consistent snapshot, so a reload
never changes a pool halfway through an admission.

The emergency stop therefore takes effect within seconds: write
`"stopped": true` and the next admission, credential fetch, worker lease and
worker call see it. Environment variables (API keys, `worker.identityEnv`
values) are read from the server's environment, which only a restart changes.

### Validation

The server refuses to start (and a reload is rejected) when the file is missing, larger than 256 KiB,
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
queued before pools existed have no pool id and belong to the default pool. A
pool worker run's route names only the pool and `"poolExecutor":
"pool_worker"`; its worker picks its own provider and model.

## Pool workers

Runs of a `pool_worker` pool are queued as usual, admitted against the pool's
limits, and tagged with the pool id (`cloud_pool_worker_runs`). The control
plane's runners never lease a tagged run, and no credential is ever handed out
for it. The pool's worker leases it instead.

The worker is the cloud agent runner started with `KORDI_POOL_WORKER_POOL_ID`
set. It authenticates every request with a short-lived workload identity
token from its own cloud (for example a service account identity token from
the metadata server for the audience in `KORDI_POOL_WORKER_AUDIENCE`). The
server verifies the token against the pool's worker identity: RS256 or ES256
signature from the issuer's keys, issuer, audience, subject or verified email,
expiry, and a lifetime of at most two hours. A token for another pool, a
forged or expired token, an unknown pool and a pool that executes in the
control plane are refused alike (401), so pool ids cannot be probed. Each
pool's endpoints accept at most 600 requests a minute (429 beyond that).
Issuer keys are cached for an hour, refetched at most once a minute for an
unknown key id, and a failed fetch is remembered for half a minute.

Endpoints (all `POST`, `Authorization: Bearer <identity token>`, JSON bodies
with `poolId` and `workerId`):

| Path | Purpose |
| --- | --- |
| `/v1/cloud/pool-workers/lease` | Leases the pool's oldest run. Returns `{"run": null}` or `{"run": {runId, feature, leaseToken, systemPrompt, prompt, thinking, leaseSeconds}}`. |
| `/v1/cloud/pool-workers/runs/{runId}/heartbeat` | With `leaseToken`: renews the lease; `{"cancelRequested": bool}`. |
| `/v1/cloud/pool-workers/runs/{runId}/plan-card` | With `leaseToken` and `request`: one plan card tool call of a System agent run, applied by the server. |
| `/v1/cloud/pool-workers/runs/{runId}/complete` | With `leaseToken` and `responseText` (at most 1 MiB): the server validates the reply and writes it into the conversation. Spends the lease token. 409 `run_not_completed` when the feature no longer takes the result (the run is then failed); 400 for a missing or oversized reply, which leaves the lease so the worker can fail the run. |
| `/v1/cloud/pool-workers/runs/{runId}/fail` | With `leaseToken` and `errorCode` (`[a-z0-9_]`, at most 64). Spends the lease token. |

Errors use `{"errorCode", "message"}`: `pool_worker_unauthorized` (401),
`run_not_found` (404, no live lease for this worker), `run_not_completed`
(409), `rate_limited` (429), `pool_stopped` (503).

A lease carries the model input of one run and no credential. The lease
fields name no account, conversation or organization, but the input itself
is what the model needs: a System agent run's conversation snapshot includes
the participants' account ids, message senders and the open plan card, and a
Grounding prompt holds the redacted evidence or shared cards. Each lease
issues a new one-time lease token, stored only as its SHA-256 hash, which
every later call for the run must present together with the pool and worker
id. Completing or failing the run spends the token, so a replayed call and a
run taken over after its lease expired are refused. When a run is leased,
its organization must still resolve to the worker's pool and must not be
disabled; otherwise it fails (`pool_binding_changed`,
`organization_disabled`) instead.

Runs that cannot finish fail, so a conversation or member is never left
waiting and a run that keeps failing on a worker cannot be retried without
end: cancelled runs (`cancelled`), runs of a stopped pool (`pool_stopped`; a
held lease can no longer complete), runs of a pool that no longer has a
worker and runs no worker leased within ten minutes
(`pool_worker_unavailable`), runs still unfinished thirty minutes after they
were queued (`pool_worker_deadline`), runs whose third lease lapsed
(`lease_limit`), and leases that lapsed ten minutes ago (`lease_expired`). A
run that fails before any worker leased it gives its count back to the
pool's limits. The worker fails a run itself when the control plane refuses
its result. Once a run has ended its tag is deleted.

### Worker settings

| Name | Meaning |
| --- | --- |
| `KORDI_POOL_WORKER_POOL_ID` | The pool id. Setting it starts the runner in pool worker mode. |
| `KORDI_POOL_WORKER_CONTROL_PLANE_URL` | The control plane's base URL (https; http only on loopback). |
| `KORDI_POOL_WORKER_AUDIENCE` | The audience of the identity token, matching the pool's `identity.audience`. |
| `KORDI_POOL_WORKER_PROVIDER` | `openai`, `openai-compatible`, `openrouter` or `vertex-ai`. |
| `KORDI_POOL_WORKER_MODEL` | The model id. |
| `KORDI_POOL_WORKER_BASE_URL` | The https endpoint of an API key provider. Empty for `vertex-ai`. |
| `KORDI_POOL_WORKER_MODEL_SECRET` | API key providers: a Secret Manager version (`projects/<p>/secrets/<s>/versions/<v>`) read with the worker identity. Empty for `vertex-ai`. |
| `KORDI_POOL_WORKER_VERTEX_PROJECT`, `KORDI_POOL_WORKER_VERTEX_LOCATION` | `vertex-ai` only: called through Vertex AI's OpenAI-compatible endpoint with the worker identity's access token. |
| `KORDI_POOL_WORKER_ID` | Optional worker id, 1-64 letters, digits, `.`, `_` or `-`; default `pool-worker-<random>`. |
| `KORDI_POOL_WORKER_IDENTITY_TOKEN_FILE` | Optional: read the identity token from this file (a projected token) instead of the metadata server. |
| `KORDI_POOL_WORKER_API_KEY_FILE` | Optional: the API key from a file instead of Secret Manager. |
| `KORDI_POOL_WORKER_CONCURRENCY` | Optional, 1-4, default 2. |
| `KORDI_POOL_WORKER_POLL_MS` | Optional, at least 250, default 2000. |

The worker runs the System agent with the Rust engine and only the plan card
tool, and Grounding as one completion without tools. It never logs prompts,
replies, keys or tokens.

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
pass was woken for is marked as seen, exactly as if the pass had run and chosen to say nothing. A
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
  settled within about a minute, by the same rule.

Usage older than 90 days is pruned about once an hour. Settlement, pruning
and pool worker run expiry run in their own background task, so they also
run when the System agent's group chat is off.

## Storage

Migration 0166 adds `cloud_resource_pool_usage`
(one counter per pool, UTC day, feature and scope) and
`cloud_resource_pool_reservations` (one row per admitted run). Migration 0169
adds `cloud_pool_worker_runs` (the pool tag of each pool worker run, and the
worker, lease token hash and lease count of its current lease, deleted
once the run ends).

## Tests

Unit tests cover file parsing and validation (formats 1 and 2), pool
resolution, the per-pool credential a runner receives, identity token checks,
reloading (a valid change swaps in, an invalid one is rejected, the stop
switch), and (in the runner) the request shape sent to an OpenAI-compatible
endpoint and the pool worker's client, credentials and run loop. Database tests are ignored by default and need a
task-owned PostgreSQL in `DATABASE_URL`:

```bash
DATABASE_URL=postgres://... cargo test -p kordi-cloud-server --lib -- resource_pools system_agent::pool_tests common_ground::runs pool_workers --include-ignored --test-threads=1
```
