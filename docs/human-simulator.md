# Human conversation simulator

The simulator runs one configured, synthetic requester in one existing Kordi conversation. The API stores actor configuration, state, model-call counts, message counts, and worker-token hashes in its own PostgreSQL database. Workers lease actors and do not receive model-provider credentials.

This first slice supports text messages and `send`, `wait`, and `finish` actions. It is independent of the Kordi app. It does not start, schedule, or evaluate a tested agent; start that agent separately before or during the simulation. Use a dedicated synthetic backend, synthetic account, and explicit synthetic-account allowlist.

## Configure an actor

Copy [actor.example.json](../deploy/simulator/actor.example.json) to a private working directory and replace the actor, account, conversation, objective, and persona values with synthetic test values. The account and conversation must already exist on the configured synthetic Kordi backend. Keep the actor ID to ASCII letters, digits, hyphens, and underscores.

Validate the file locally without network access:

```sh
kordi sim validate --config ./actor.json
```

The actor `skill` must be `human-requester@1`. The configuration has no URL or credential fields. Do not place account passwords, access tokens, API keys, or production conversation content in it.

## Register and manage an actor

Set the operator API origin and operator token in the shell or a private environment manager. The token must have at least 32 characters. Do not put it in a checked-in file, command-line argument, or shared log.

```sh
export KORDI_SIMULATOR_API_BASE=https://simulator.kordi.cloud
read -s KORDI_SIM_OPERATOR_TOKEN
export KORDI_SIM_OPERATOR_TOKEN
kordi sim create --config ./actor.json --credential-file ./actor-credential.json
```

`create` refuses to overwrite the credential file and creates it with mode `0600` on Unix. The response contains `actor_id` and `worker_token`. Protect that file as a secret, transfer the worker token into the worker's secret store, then securely remove the local copy when no longer needed.

Start a worker locally with the actor-specific token and a dedicated synthetic account credential. Choose either a renewable session token or a login email/password pair:

```sh
read -s KORDI_SIM_ACTOR_TOKEN
export KORDI_SIM_ACTOR_TOKEN
read -s KORDI_SIM_ACCOUNT_TOKEN
export KORDI_SIM_ACCOUNT_TOKEN
kordi sim run --actor synthetic-requester-01
```

Or set both `KORDI_SIM_ACCOUNT_EMAIL` and `KORDI_SIM_ACCOUNT_PASSWORD` instead of `KORDI_SIM_ACCOUNT_TOKEN`. The account must match the actor's `account_id`. The worker refreshes a session through the login pair after an unauthorized response; session-token-only deployments must rotate the token as needed.

Read the sanitized actor status and stop future actions with the operator credential:

```sh
kordi sim status --actor synthetic-requester-01
kordi sim stop --actor synthetic-requester-01
```

Status includes only lifecycle state, counters, whether a send is pending, revision, wake time, and a sanitized error code. Stop invalidates ownership and prevents new actions from being scheduled. It does not delete actor state or conversation messages, and it cannot revoke a Kordi message request that the worker has already sent and Kordi has accepted.

## External API contract

Requests use JSON and `Authorization: Bearer <token>`. The operator token manages actors; each worker token is scoped to exactly one actor. Model credentials are never returned. The worker separately authenticates to Kordi as its configured account.

| Method and path | Credential | Purpose |
| --- | --- | --- |
| `POST /v1/sim/actors` | Operator | Register an actor configuration and return its one-time worker token. |
| `GET /v1/sim/actors/{id}/status` | Operator or actor | Read sanitized progress. |
| `POST /v1/sim/actors/{id}/stop` | Operator | Make the actor terminal and invalidate ownership. |
| `POST /v1/sim/actors/{id}/lease` | Actor | Acquire ownership using a generated `owner` UUID. |
| `POST /v1/sim/actors/{id}/heartbeat` | Actor | Renew the 60-second lease using `owner` and `generation`. |
| `POST /v1/sim/actors/{id}/release` | Actor | Release ownership without erasing state. |
| `POST /v1/sim/actors/{id}/checkpoint` | Actor | Save account-sync observations with the current revision. |
| `POST /v1/sim/actors/{id}/decide` | Actor | Reserve model budget, invoke the behavior skill, and persist the resulting action. |
| `POST /v1/sim/actors/{id}/confirm` | Actor | Confirm a pending Kordi send using its stable client message ID. |

The shared request/response types live in `agent/crates/human-simulator/src/protocol.rs`. Writes require the current lease generation and, where applicable, revision. A `409` means ownership, revision, or lifecycle no longer permits the operation; do not continue dispatching from stale state. Model capacity is bounded and can return `429`. `/health` checks the process and `/ready` checks database availability. This API does not grant login access to arbitrary group participants or implement manual App takeover.

## API service settings

Build the standalone API image from the repository root with `deploy/simulator/Dockerfile.api`. For local AMD64 nodes, select that target explicitly:

```sh
docker build --platform linux/amd64 -f deploy/simulator/Dockerfile.api -t human-simulator-api:local .
```

For other nodes, use their target platform. Render can build for the selected service architecture without a forced platform in the Dockerfile. The API binary is `kordi-simulator-api`; it starts only the simulator control service and does not mount routes on the product server.

The Render blueprint [render.yaml](../deploy/simulator/render.yaml) defines the API service and a separate PostgreSQL database. Auto deploy is disabled. Configure the `simulator.kordi.cloud` custom domain for the service. The service needs these runtime settings:

- `KORDI_SIM_DATABASE_URL`: the dedicated simulator database connection string.
- `KORDI_SIM_OPERATOR_TOKEN`: an operator bearer token with at least 32 characters.
- `KORDI_SIM_ALLOWED_ACCOUNTS`: a comma-separated, explicit allowlist of synthetic account IDs.
- `KORDI_SIM_KORDI_API_BASE`: the HTTPS origin of the dedicated synthetic Kordi backend. It must not include a path, query, fragment, or embedded credential.
- `PORT=10000` and `KORDI_SIM_BIND=0.0.0.0` for Render.
- The same operator-selected System agent model configuration used by the Kordi server. For OpenAI or an OpenAI-compatible gateway, configure `KORDI_SYSTEM_AGENT_PROVIDER`, `KORDI_SYSTEM_AGENT_OPENAI_API_KEY`, `KORDI_SYSTEM_AGENT_OPENAI_MODEL`, and, when needed, `KORDI_SYSTEM_AGENT_OPENAI_BASE_URL`. For Vertex, configure `KORDI_SYSTEM_AGENT_PROVIDER=vertex-ai`, `KORDI_SYSTEM_AGENT_VERTEX_MODEL`, `KORDI_SERVICE_VERTEX_PROJECT`, `KORDI_SERVICE_VERTEX_LOCATION`, and a workload identity file referenced by `GOOGLE_APPLICATION_CREDENTIALS`.

The service requires explicit model configuration; this deployment adds no model default. The blueprint lists the OpenAI-compatible settings. If Vertex is selected, also configure `KORDI_SYSTEM_AGENT_VERTEX_MODEL`, `KORDI_SERVICE_VERTEX_PROJECT`, and `KORDI_SERVICE_VERTEX_LOCATION`, and provide the workload identity file referenced by `GOOGLE_APPLICATION_CREDENTIALS`. Mark credentials and environment-specific values as unsynchronized secrets in Render and provide the secret file through Render's secret-file facility when using Vertex. Use a provider account and model configuration authorized for the synthetic test environment only.

## Worker image and k3s

Build the headless worker image from the repository root with `deploy/simulator/Dockerfile.worker`. Match the image platform to the k3s node architecture; for AMD64 nodes, run:

```sh
docker build --platform linux/amd64 -f deploy/simulator/Dockerfile.worker -t human-simulator-worker:local .
```

The image runs `kordi-human-simulator run --actor <id>` as a non-root user. Both images bundle the requester skill used by the compiled model code. The worker image includes no provider keys, operator token, or database credential.

[k3s-worker.yaml](../deploy/simulator/k3s-worker.yaml) is a per-actor Job template. The [startup helper](../deploy/simulator/start-worker.sh) requires explicit `KUBECONFIG` and `SIMULATOR_KUBE_CONTEXT` values plus the namespace, unique DNS-safe job name, image, actor ID, and secret names. Include the actor identity in the job name so multiple actors can run at once. The namespace must be dedicated to the simulator and created separately. The referenced Kubernetes Secrets are deliberately not included in the repository. Store `KORDI_SIM_ACTOR_TOKEN` in the worker secret and store either `KORDI_SIM_ACCOUNT_TOKEN` or both login fields in the account secret. Set `KORDI_SIMULATOR_API_BASE` to the HTTPS simulator API origin. Do not add provider or database credentials to the worker.

After exporting `KUBECONFIG`, `SIMULATOR_KUBE_CONTEXT`, `SIMULATOR_NAMESPACE`, `SIMULATOR_JOB_NAME`, `SIMULATOR_IMAGE`, `SIMULATOR_ACTOR_ID`, `SIMULATOR_WORKER_SECRET`, and `SIMULATOR_ACCOUNT_SECRET`, and creating the namespace and Secrets through the approved secret manager, preview the rendered manifest without contacting the cluster. The helper requires Python 3; its apply mode also requires `kubectl`:

```sh
deploy/simulator/start-worker.sh --dry-run
deploy/simulator/start-worker.sh
```

`--dry-run` prints only the rendered manifest and does not call `kubectl` or connect to a cluster. The apply path checks that the requested namespace and Secrets exist, runs client-side validation, and applies the same temporary rendered manifest. It suppresses `kubectl` output during checks so environment values and cluster details are not printed by the helper. The Job uses `OnFailure` with a six-retry limit and no execution deadline, so an active simulation can wait as long as configured. A finished or stopped actor exits successfully and completes its Job. The worker has no service-account token mount, a read-only root filesystem, a non-root UID, and dropped Linux capabilities; it exposes no network listener. The database lease also fences stale workers after restarts.

If a completed or failed Job needs replacement, delete that Job and create a new actor-specific Job with the same actor ID and worker token. Do not run two Jobs for the same actor concurrently. After terminating an old worker, allow its lease to release or expire (up to 60 seconds after its last heartbeat) before expecting the replacement to acquire ownership. A new Job for a finished or stopped actor exits successfully without sending more messages.

## Limits and recovery

The configured model-call and message limits persist with actor state. A pending send is checkpointed before dispatch and retried with the same client message ID after a worker restart. Model failures use bounded retries and stop the actor after repeated failures. `kordi sim stop` disables actions but preserves state. Finished and stopped actors are terminal in this slice: register a new actor ID for a new experiment; there is no resume endpoint.

Use only the dedicated synthetic backend and accounts listed in `KORDI_SIM_ALLOWED_ACCOUNTS`. The simulator does not provide a generic shell, browser, or skill execution tool. The bundled requester skill is behavior guidance for the model and is not an executable extension system.

## Validation

Run the protocol and configuration tests with `cargo test -p kordi-human-simulator`.

For the database and HTTP tests, set `KORDI_SIM_TEST_DATABASE_URL` to a disposable, task-owned PostgreSQL database and `KORDI_CHAT_SYNC_CURSOR_SECRET` to a synthetic test secret. The integration test initializes the Kordi schema in that database, creates isolated synthetic accounts, and removes its fixtures afterward. Never point it at a shared or production database.

```sh
cargo test -p kordi-cloud-server human_simulator --lib -- \
  --include-ignored --skip live_provider_real_http_headless_human
```

This covers authenticated API send/receive, actor-token scope, account allowlisting, database leases, persisted budgets, and recovery after Kordi accepted a message before its simulator confirmation. Only the model is scripted in this test.

The separate live-model test requires the same isolated database settings, an authorized System model configuration in the process environment, and explicit opt-in. It sends only synthetic conversation context to the selected model:

```sh
KORDI_SIM_LIVE_MODEL_TEST=1 cargo test -p kordi-cloud-server \
  live_provider_real_http_headless_human --lib -- --ignored
```

Local HTTP tests do not establish that Render routing, TLS, container images, Kubernetes network policies, or a remote worker deployment are operational. Validate those separately against the chosen simulator environment.
