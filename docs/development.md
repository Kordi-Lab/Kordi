# Development entrypoints

This document keeps the top-level development commands for the Kordi monorepo in one place.

New contributors should begin with [`self-hosted-debug.md`](self-hosted-debug.md). It covers the complete isolated backend and desktop workflow, multi-account testing, production access boundaries, troubleshooting, and cleanup.

Run commands from:

```bash
cd /path/to/kordi
```

## Install dependencies

```bash
pnpm install --frozen-lockfile
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
https://kordi.ai
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

## iPhone app

The native SwiftUI client lives in `app/ios`, targets iOS 17 and later, and uses `app/ios/project.yml` as the XcodeGen source of truth.

```bash
cd app/ios
xcodegen generate
open Kordi.xcodeproj
```

Run the simulator test suite from the repository root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build/ios \
  test
```

Use `--preview-data` for deterministic, network-free UI work. Physical-device and TestFlight builds require a locally selected Apple Development team; the repository does not store contributor signing identities.

See [`ios-development.md`](ios-development.md) for setup, preview arguments, architecture, physical-device deployment, production boundaries, and TestFlight.

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
For native iPhone development, see [`ios-development.md`](ios-development.md).
For the isolated Docker backend and contributor access model, see [`self-hosted-debug.md`](self-hosted-debug.md).
For community contribution areas, issue preparation, and review expectations, see [`community-contributor-guide.md`](community-contributor-guide.md).
For Rust artifact size notes and inactive worktree cleanup, see [`development/desktop-rust-build-artifacts.md`](development/desktop-rust-build-artifacts.md).
For overlong-file thresholds and refactor boundaries, see [`development/maintainability-boundaries.md`](development/maintainability-boundaries.md).

## Notes

- Kordi Desktop is the primary product surface on `main`.
- Production defaults point to `https://kordi.ai`.
- Development tests should set `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted API explicitly.
- Do not commit tokens, local account sessions, provider credentials, database credentials, or private operator infrastructure details.
