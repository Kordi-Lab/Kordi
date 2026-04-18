# Kordi Desktop

Kordi Desktop is the macOS application shell for:

- the Kordi frontend in this repository
- the local `bb-agent` runtime
- the local `Bridges` network node and daemon

## Repository role

This repository is the desktop product layer.

It is responsible for:

- the React interface
- the Tauri desktop shell
- bundling local sidecar binaries
- packaging and desktop release flows

It is **not** the source-of-truth repository for:

- the `bb-agent` runtime internals
- the `Bridges` network backend internals

See [/Users/shuyang/Desktop/Bridges-app/docs/desktop-workspace.md](/Users/shuyang/Desktop/Bridges-app/docs/desktop-workspace.md) for the recommended multi-repo layout.

## Local workspace layout

Recommended development layout:

```text
Desktop/
  Kordi/
  bb-agent/
  Bridges/
```

This repository reads sibling repo locations from `kordi.workspace.json`.

## Frontend preview

```bash
cd /Users/shuyang/Desktop/Bridges-app
npm install
npm run dev
```

## Tauri desktop development

```bash
cd /Users/shuyang/Desktop/Bridges-app
npm install
npm run tauri:dev
```

That flow:

1. builds `bb-agent`
2. builds `Bridges`
3. copies their release binaries into `src-tauri/binaries/`
4. launches the Tauri desktop shell

## Production build

```bash
cd /Users/shuyang/Desktop/Bridges-app
npm install
npm run tauri:build
```

## Notes

- The current desktop integration uses sidecar binaries.
- This is the fastest path to a working macOS app.
- The longer-term direction is to expose cleaner library/service entry points from `bb-agent` and `Bridges`, then reduce sidecar dependence.
