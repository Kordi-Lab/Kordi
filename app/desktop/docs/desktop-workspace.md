# Kordi Desktop Workspace

Kordi Desktop is the Cloud product shell. It contains:

- the React product UI under `app/desktop/src`;
- the Tauri application boundary under `app/desktop/src-tauri`;
- the reusable local agent runtime under `agent`;
- direct clients for hosted Kordi Cloud services.

The hosted Cloud server and hosted agent runner live in the same monorepo but
are independently buildable and deployable services. Their location under
`bridges/` is historical and does not make the standalone Bridges network part
of the desktop runtime.

## Runtime and packaging boundary

Desktop development and release builds prepare one external binary:

- `agent` builds the `kordi` local agent runtime;
- `scripts/prepare-sidecars.mjs` copies it to
  `src-tauri/binaries/kordi-<target-triple>`;
- Tauri packages it as `Kordi.app/Contents/MacOS/kordi`.

Desktop does not compile, copy, launch, sign, or package the standalone Bridges
CLI. Cloud collaboration goes directly through the hosted API and the
transport-neutral collaboration model.

## Workspace configuration

`kordi.workspace.json` records the local agent runtime path, Cargo manifest, and
release binary path. Keep it limited to dependencies that the desktop actually
builds and packages.

## Ownership

- `app/desktop`: product UI, native shell, packaging, signing, and updates.
- `agent`: local model execution, provider configuration, session engine,
  tools, and skills.
- `bridges/cloud-server`: hosted Cloud API.
- `bridges/cloud-agent-runner`: hosted execution service.
- `bridges/cli`, `bridges/registry`, and `bridges/skills/bridges`: standalone
  local/P2P product surfaces with an independent lifecycle.

See
[Cloud and standalone Bridges boundary](../../../docs/architecture/bridges-boundary.md)
for ownership, compatibility, and disposition details.
