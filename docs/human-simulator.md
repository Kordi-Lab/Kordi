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

## Worker deployment: k3s and Fly

Both channels run the same `kordi-human-simulator` image and actor protocol. Render hosts the control API and durable state; choosing a worker backend does not move model credentials or the database into that worker. An experiment may run different actors on different backends. Selecting a backend is explicit; a provider error does not automatically start a second worker elsewhere.

Build and publish the worker image from the repository root. Select the target architecture for the destination nodes, then use the registry's immutable digest in each deployment configuration:

```sh
docker build --platform linux/amd64 -f deploy/simulator/Dockerfile.worker -t human-simulator-worker:local .
```

The examples contain a placeholder digest, not a published image. Replace it with the digest of your built image. The worker needs no local volume: cursor, model memory, pending messages, budgets, and leases live in the control database.

Copy either [deployment.k3s.example.json](../deploy/simulator/deployment.k3s.example.json) or [deployment.fly.example.json](../deploy/simulator/deployment.fly.example.json) to a private deployment file. Set the actor ID, immutable image, API origin, and backend settings. These files contain Secret **references**, never credentials. Register the actor with `kordi sim create` first and provision its worker token and synthetic account credentials in the selected provider's secret store.

The same commands handle both backends:

```sh
kordi sim deploy --config ./deployment.json --dry-run
kordi sim deploy --config ./deployment.json
kordi sim worker-status --config ./deployment.json
kordi sim worker-stop --config ./deployment.json
```

`deploy --dry-run` validates and prints the provider request without requiring provider credentials or contacting a server. [start-worker.sh](../deploy/simulator/start-worker.sh) is a thin wrapper around `kordi sim deploy` and accepts the same arguments. Set `KORDI_BIN` when using a locally built CLI.

Deployment names are stable hashes of the API origin and actor ID. Existing resources must match both the ownership metadata and expected runtime configuration; the CLI refuses to overwrite unrelated or modified resources. Repeated deploys reconcile the same resource. Ambiguous create failures require status inspection before retrying; the implementation never blindly repeats a create request. Worker status prints only the backend and lifecycle state, not raw provider configuration or credentials.

### k3s

Provide a readable `KUBECONFIG` file. The configuration explicitly selects the context, namespace, worker Secret, account Secret, and `account_auth` (`session` or `login`). No implicit cluster context is used. Create the dedicated namespace and Secrets before deploying. The worker Secret needs `KORDI_SIM_ACTOR_TOKEN`; the account Secret needs `KORDI_SIM_ACCOUNT_TOKEN` or both `KORDI_SIM_ACCOUNT_EMAIL` and `KORDI_SIM_ACCOUNT_PASSWORD`.

The CLI creates an actor-specific Job using `kubectl`, with six failure retries, a read-only root filesystem, non-root user, CPU/memory limits, dropped capabilities, and no service-account token mount. It publishes no ports. Configure namespace network policies according to the cluster's DNS and approved API egress routes.

`worker-stop` suspends the exact owned Job using UID and resource-version preconditions, then checks the Job's suspension condition and its Pods before reporting stopped. The selected Kubernetes credentials need Job get/create/patch and Pod list permissions. It preserves the Job and actor state. `deploy` resumes a suspended, unfinished Job; completed or failed Jobs remain terminal. Register a new actor for a new experiment. The generated manifest from `deploy --dry-run` is the authoritative k3s resource specification. See [Kubernetes Job suspension](https://kubernetes.io/docs/concepts/workloads/controllers/job/#suspending-a-job) for the underlying lifecycle.

### Fly

Set `KORDI_SIM_FLY_TOKEN` in the invoking process or secret manager. It is a deployment credential, never a worker environment variable. Select an explicit Fly app and region in the deployment file. Use a dedicated simulator app and distinct Secret names for every actor; changing app secrets may restart Machines, so provision them before launching workers and coordinate rotations.

Fly deployment uses the Machines REST API directly and does not require `flyctl` to start, inspect, or stop a worker. The Machine has no public services, one shared CPU, 512 MiB memory, and an `on-failure` restart policy with six retries. It runs the same image as k3s as UID/GID 1000. Process-level `ignore_app_secrets: true` and explicit Secret mappings limit its environment to the selected actor/account credentials. Do not reuse the tested-agent tool-sandbox image or inherit its application secrets.

The adapter uses exclusive Machine leases for start/stop mutations, rechecks ownership after acquiring a lease, and releases it after the operation. Stop sends SIGTERM, waits for the captured Machine instance to stop, and preserves the Machine for a later deploy. The API request and response handling is bounded and never logs provider response bodies. See the official [Fly Machines API](https://fly.io/docs/machines/api/machines-resource/) for process secrets, leases, and instance-scoped wait behavior.

### Switching channels

Use the same actor ID and Render API origin in both deployment files. First run `worker-stop` with the old deployment file and verify its stopped state, then deploy the other file. A released or expired database lease allows the new worker to restore the same progress and pending message ID. A replacement may need to wait up to 60 seconds for an ungraceful predecessor's lease to expire. Worker tokens and account credentials must reference the same actor/account on both providers.

`worker-stop` stops compute and leaves a running actor resumable. `kordi sim stop --actor <id>` instead makes the actor terminal in the control API and prevents future automatic actions. For permanent shutdown, stop the actor and then stop its worker compute. In-flight accepted Kordi requests cannot be retracted. This first slice does not automatically fail over, delete provider resources, or reset completed actors.

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
