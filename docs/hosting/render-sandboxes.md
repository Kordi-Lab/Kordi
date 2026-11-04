# Render sandbox adapter

Select `services.runner.sandboxBackend: "render"` in an external distribution profile. Kubernetes, Fly and debug-local selections retain their existing behavior; this adapter does not change Beta defaults.

The adapter uses Render's native sandbox REST API. Each workspace operation runs in a new Oregon sandbox with no inline credentials, denied outbound networking, a five-minute lifetime and the smallest supported compute plan. A dedicated sandbox group must cap concurrency at four or fewer. The control-plane credential remains in the runner; capability tokens authorize individual guest transfers and execution. Redirects are disabled, and capability endpoints must match the selected sandbox host.

## Configuration

Resolve these values through the private ops environment, never checked-in source:

| Variable | Purpose |
| --- | --- |
| `KORDI_RENDER_SANDBOX_OWNER` | Explicit Render workspace |
| `KORDI_RENDER_SANDBOX_GROUP` | Dedicated sandbox group in Oregon, concurrency at most four |
| `KORDI_RENDER_SANDBOX_TOKEN` | Trusted control-plane API credential |
| `KORDI_RENDER_WORKSPACE_ROOT` | Existing private directory on the runner's persistent disk |
| `KORDI_RENDER_MAX_WORKSPACES` | Persistent workspace capacity, default 256, maximum 1,024 |

On Unix the workspace root must have mode `0700`, be writable by the runner user, and resolve to its canonical absolute path. Mount persistent storage before startup; the adapter intentionally does not create a missing root. A Render disk supports one runner instance. Do not deploy multiple independent disks for the same workspace namespace.

## Persistence and failure behavior

The persistent disk stores opaque JSON checkpoints indexed by a case-sensitive hash of the server-issued sandbox ID. A filesystem lock excludes concurrent writers. Guest output is validated, the guest is terminated, and the new checkpoint is atomically renamed and synced before the operation is acknowledged. Interrupted operations preserve the previous completed checkpoint. The host never extracts or executes checkpoint contents.

The workspace supports ordinary files, directories and executable bits, with a 16 MiB total data quota and 2,048 entries. It rejects symlinks, hard links and special files. Bash commands have a 30-second deadline and bounded output; descendants are killed when the shell exits. Each operation terminates its entire guest, including escaped background processes. On cancellation a drop guard requests termination; the five-minute provider deadline bounds a guest if the runner crashes or a create response is lost. Ambiguous creates are never automatically retried.

A completed file write survives a runner process restart or deploy when the same persistent disk is attached. Total disk loss requires an independently tested backup restore. Render sandbox snapshots are not used as durable storage because they expire. Changes outside `/workspace`, including package installations, do not persist. Fresh guests add cold-start latency; measure it before optimizing guest reuse.

## Verification

Run `cargo test -p kordi-cloud-agent-runner --lib` and `node --test scripts/distribution-configuration.test.mjs` for local regression coverage. Guest checkpoint tests operate only on temporary synthetic files and never invoke guest privilege setup on the host.

The ignored live acceptance test creates paid disposable sandboxes and requires explicit environment selection. Set `KORDI_RENDER_LIVE_TEST=synthetic-only`, supply a dedicated test group and private temporary checkpoint directory, and run:

```sh
cargo test -p kordi-cloud-agent-runner live_render_recovery_isolation_and_limits --lib -- --ignored --nocapture
```

It verifies persisted writes across adapter recreation, user isolation, nonzero exit codes, output limits, rejected symlinks, denied outbound access, cancellation of an observed active command, recovery of the prior checkpoint, and the command deadline. Every guest is bounded and terminated; inspect the test group afterward for leftover active resources. This does not replace hosted runner restart/restore and end-to-end product acceptance.

API behavior follows [Render Sandboxes](https://render.com/docs/sandboxes), [command execution](https://render.com/docs/sandboxes-executing), and [persistent disks](https://render.com/docs/disks). The sandbox service is in public beta; rerun disposable acceptance when changing the provider integration.
