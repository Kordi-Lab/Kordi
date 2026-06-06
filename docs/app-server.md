# Legacy App Server Notes

`app/server` is not the primary Kordi product backend on `main`.

The product backend is `bridges/cloud-server`, and production desktop builds use:

```text
https://coordinar.io
```

For development/QA, use:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

or host your own compatible hosted server.

## Status

The local app server was an earlier app-facing orchestration experiment for local runtime and Bridge integration. It should not be presented as the default product path, and default developer commands should not start it.

Keep this document only as legacy/internal context until the code is removed or archived.

## Current product topology

```text
desktop app
  -> hosted API (`bridges/cloud-server`)
    -> hosted database / sync events
    -> hosted agent runner (`bridges/cloud-agent-runner`)
```

## Cleanup direction

Issue #548 tracks removal or quarantine of old local product surfaces, including:

- default commands that start local-only services
- old local Bridge/P2P configuration UI
- local app-server docs and command surfaces
- local-first architecture descriptions

Do not add new product work to `app/server` unless the hosted architecture is explicitly changed.
