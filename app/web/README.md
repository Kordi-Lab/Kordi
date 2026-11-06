# Kordi web application

This workspace owns the browser application served at `/app/`. It reuses the
desktop's current React pages and hosted API clients so both platforms share
the same navigation, conversation controls, settings, and visual design.

## Ownership

| Location | Responsibility |
| --- | --- |
| `src/main.tsx` and `index.html` | Browser entry point |
| `src/auth/` | Browser runtime selection and cookie-session transport |
| `src/app/` | Browser navigation, history, workspace scope, and hosted titles |
| `src/runtime/` | Browser storage, canonical projections, uploads, downloads, and recording |
| `src/styles/` | Browser shell adaptations |
| `tests/unit/` | Browser runtime and isolation tests |
| `tests/e2e/` | Full application tests with explicitly synthetic API fixtures |
| `docs/` | Implementation plan, desktop alignment, and remaining capability gaps |
| `dist/` | Generated production artifact; not committed |

Shared UI and API clients remain in [`app/desktop/src`](../desktop/src), imported
through `@/`. Browser-owned modules use `@web/`. Shared components select browser
adapters only when running the web target; native desktop commands retain their
existing implementations. Assets are reused from the desktop public directory.

Backend authentication, chat authorization, and application static serving stay
in [`bridges/cloud-server`](../../bridges/cloud-server), where those services are
implemented. Moving browser files does not move server authorization into the
client or duplicate shared product pages.

## Commands

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm --dir app/web dev
pnpm --dir app/web build
pnpm --dir app/web typecheck
pnpm --dir app/web lint
pnpm --dir app/web test:unit
pnpm --dir app/web test:e2e
```

Root aliases `dev:web:app`, `build:web:app`, and `check:web:app` address this
workspace. The browser build writes `app/web/dist`; the desktop build continues
to write `app/desktop/dist`.

Development uses a loopback frontend and the existing authorized development
backend workflow. Set `VITE_KORDI_DEV_PROFILE=community` and set
`VITE_KORDI_CLOUD_API_BASE` to the frontend origin. An optional
`KORDI_WEB_API_PROXY_TARGET` must be a loopback backend origin. Backend public
origin and OAuth configuration must agree with the frontend. Secure cookie
acceptance requires a secure development origin; do not weaken cookie policy.

The end-to-end suite starts its own loopback server. Set
`KORDI_WEB_APP_TEST_PORT` to an available task-owned port when another preview is
running. It tests the complete application with synthetic protocol fixtures;
it does not sign into real accounts or prove live provider/call acceptance.

## Review and release scope

The web app omits macOS window controls and the desktop Dock icon picker.
Memory settings and chat Memory tabs follow the server's advertised capability;
the synthetic Memory fixture supplies matching routes and labeled sample data.

Hosted chat, attachments, browser recording, and account settings have browser
implementations. Factory builder workflows, transcript Fork, local memory
import, and on-device transcription still have native dependencies. Real OAuth,
hosted-agent streaming, calls, and multi-account collaboration require configured
development-service acceptance before claiming full desktop parity.

See the [implementation plan](docs/plan.md), [desktop alignment
report](docs/desktop-alignment.md), and [capability audit](docs/capabilities.md).
