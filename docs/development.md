# Development entrypoints

This document keeps the top-level development commands for the Kordi monorepo in one place.

Run commands from:

```bash
cd /path/to/kordi
```

## Install dependencies

```bash
pnpm install
```

## Desktop

### Start the product app

```bash
pnpm debug:cloud:up
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

`pnpm dev` launches Kordi Desktop. Development launches fail closed unless you explicitly select a non-production API origin. The recommended default is the isolated Docker backend described in [`self-hosted-debug.md`](self-hosted-debug.md).

Production API:

```text
https://coordinar.io
```

For development/QA, prefer the self-hosted server or an operator-provided public test API base. Always set the API base explicitly:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

The development launcher rejects the production origin. Do not bypass that safeguard for destructive, load, or throwaway multi-account testing.

### Start multiple isolated users

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

The local URLs opened by this command are desktop test windows only. They are not hosted backend URLs. Product data comes from `VITE_KORDI_CLOUD_API_BASE`.

### Build desktop

```bash
pnpm build:desktop
```

This aliases the desktop package build. Release builds should use the release path and the production origin.

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

## Shared validation

```bash
pnpm lint
pnpm typecheck:web
pnpm check:rust
pnpm check
```

For hosted desktop debugging, multi-user sync checks, and operator tunnel rules, see [`hosted-cloud-developer-guide.md`](hosted-cloud-developer-guide.md).
For the isolated Docker backend and contributor access model, see [`self-hosted-debug.md`](self-hosted-debug.md).
For Rust artifact size notes and inactive worktree cleanup, see [`development/desktop-rust-build-artifacts.md`](development/desktop-rust-build-artifacts.md).
For overlong-file thresholds and refactor boundaries, see [`development/maintainability-boundaries.md`](development/maintainability-boundaries.md).

## Notes

- Kordi Desktop is the primary product surface on `main`.
- Production defaults point to `https://coordinar.io`.
- Development tests should set `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted API explicitly.
- Do not commit tokens, local account sessions, provider credentials, database credentials, or private operator infrastructure details.
