# Development entrypoints

This document keeps the top-level Cloud-first commands for the Kordi monorepo in one place.

Run commands from:

```bash
cd /path/to/kordi
```

## Install dependencies

```bash
pnpm install
```

## Cloud desktop

### Start the Cloud product app

```bash
pnpm dev
```

`pnpm dev` is the default product development command. It launches Cloud Desktop and uses the product Cloud origin unless you override the API base.

Production Cloud API:

```text
https://coordinar.io
```

For development/QA, prefer an operator-provided public test Cloud API base or a self-hosted compatible Cloud server:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

Do not use the production server for destructive, load, or throwaway multi-account testing unless explicitly authorized.

### Start multiple isolated Cloud users

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

The local URLs opened by this command are desktop test windows only. They are not Cloud backend URLs. Product data comes from `VITE_KORDI_CLOUD_API_BASE`.

### Build Cloud desktop

```bash
pnpm build:desktop
```

This aliases the Cloud package build. Release builds should use the Cloud release path and the product Cloud origin.

## Web UI preview

```bash
pnpm dev:web
pnpm build:web
```

The web preview is for frontend iteration only. Native Tauri behavior, keychain/session storage, OAuth loopback, and packaged updater behavior require a Tauri run/build.

## Internal runtime/tooling commands

These commands remain for internal runtime, runner, and infrastructure development. They are not the default product quick start.

```bash
pnpm run:agent -- --help
pnpm check:agent
pnpm build:agent

pnpm run:bridges -- --help
pnpm check:bridges
pnpm build:bridges

pnpm dev:registry
pnpm build:registry
```

Legacy local desktop flows, where still present, use explicit `:local` command names.

## Shared validation

```bash
pnpm lint
pnpm typecheck:web
pnpm check:rust
pnpm check
```

For Rust artifact size notes and inactive worktree cleanup, see [`development/desktop-rust-build-artifacts.md`](development/desktop-rust-build-artifacts.md).
For overlong-file thresholds and refactor boundaries, see [`development/maintainability-boundaries.md`](development/maintainability-boundaries.md).

## Notes

- Cloud Desktop is the primary product surface on `main`.
- Production defaults point to `https://coordinar.io`.
- Development tests should point to `<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted Cloud API.
- Do not commit tokens, local account sessions, provider credentials, database credentials, or private operator infrastructure details.
