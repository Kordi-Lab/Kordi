# Fly sandbox validation

The cloud runner supports `KORDI_CLOUD_SANDBOX_BACKEND=fly`. This is an opt-in
validation executor, not a production migration or a general Fly autoscaler.
Keep the API, database, event bus, attachments, and provider credentials on the
core backend. The Fly guests receive only workspace operations.

## Deployment boundary

Use a dedicated Fly app with an isolated private network, no public IPs, no
services, and **no app secrets**. Fly injects app secrets into Machines, so never
store a platform token, model credential, or core-backend secret on this app.
Give the Render runner an expiring token scoped to that one Fly app. Keep exactly
one runner instance; its provisioning admission limit is process-local.

Build the runner from `deploy/render/Dockerfile.runner` and supply:

- `KORDI_CLOUD_API_BASE`: the explicitly selected validation API origin.
- `KORDI_CLOUD_RUNNER_TOKEN`: a new validation-only shared secret also configured
  on the API. The runner does not need database or object-store credentials.
- `KORDI_CLOUD_SANDBOX_BACKEND=fly`.
- `KORDI_CLOUD_RUNNER_CONCURRENCY=1` for the small validation worker; valid values
  are 1 through 4, with 4 retained as the default for existing deployments.
- `KORDI_FLY_SANDBOX_APP`: the dedicated, secret-free sandbox app.
- `KORDI_FLY_SANDBOX_TOKEN`: the app-scoped token. Rotate before its expiration.
- `KORDI_FLY_SANDBOX_REGION`: an explicit available region near the backend.
- `KORDI_FLY_SANDBOX_IMAGE`: an official Python slim Debian image pinned with
  `@sha256:<digest>`, containing Python 3, Bash, and core utilities.
- `KORDI_FLY_MAX_WORKSPACES`: 1 through 16; defaults to 4. Unused/orphan volumes
  also count against the volume admission limit. Resolve uncertain create
  outcomes and duplicate resources before retrying.

Use the existing OMP engine and its bundled worker. Users must connect a model
provider and enable the corresponding cloud auth snapshot. Creating a sandbox
cannot supply a model credential or enable an unsupported connector.

## Workspace lifecycle

Each server-issued sandbox ID maps to a hash, one execution Machine, one 1 GiB
encrypted volume, and one stopped coordinator Machine. Full identity hashes are
checked in metadata; volume names use a shorter hash to fit Fly's name limit.
Do not rename or reassign these resources between accounts.

The coordinator's 60-second lease excludes another run from the same workspace.
The runner renews it with its ten-second heartbeat; a lost renewal stops the run.
The execution Machine itself stays unleased because Fly's Exec endpoint rejects
execution on a leased Machine. The coordinator remains stopped. Provisioners
must follow this protocol; do not manually start or execute a leased workspace.

A new run stops any prior process before starting the execution Machine. A root
supervisor exits after 840 seconds, bounding orphan compute after a runner crash.
Workspace operations drop to UID/GID 1000 and clear the environment. Commands
have a 30-second deadline and 1 MiB output limit; file reads/writes are bounded
at 1 MiB. Shell descendants in the process group are killed after each operation.
The entire VM is stopped on completion, cancellation, timeout, or lease error.
A dropped runner future also requests best-effort shutdown. Shutdown extends its owned lease to 180 seconds before issuing bounded stop/wait
requests. A lost coordinator lease prevents an old run from stopping a newer execution.

Stopping preserves the volume. A runner restart rediscovers the resources; an
unexpired old lease is awaited for up to 70 seconds, then fails closed. Failed mutations are not
blindly retried. Only a refused start during Fly's stopped-to-started transition
is retried for up to 30 seconds. No workspace or volume is automatically deleted.
Daily snapshots with one-day retention are enabled; this is not a tested disaster
recovery strategy. Volumes and retained resources can incur charges while stopped.

## Validation

Run local checks without cloud credentials:

```sh
python3 scripts/test_fly_sandbox_operation.py
cargo test -p kordi-cloud-agent-runner --lib -- --test-threads=1
```

After reviewing the paid resource limits, supply the environment above plus a
synthetic `KORDI_FLY_TEST_WORKSPACE=test-<unique-label>` and run:

```sh
cargo test -p kordi-cloud-agent-runner --test cloud_fly_sandbox -- --ignored
```

This opt-in test creates two persistent synthetic workspaces. It checks file
round trips, bounded reads, cross-workspace isolation, stop/start persistence,
cancellation of a delayed write, and takeover after a simulated runner crash. Preserve real user resources when cleaning
up test Machines and volumes. Use a dedicated validation app for these tests.

Before claiming complete app coverage, also exercise a real provider-backed run
from the native client, requester cancellation, runner restart/recovery, artifact
export, and account authorization. Passing VM tests alone does not validate OAuth,
voice/video, every connector, or the entire product.
