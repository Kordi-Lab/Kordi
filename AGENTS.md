# Repository agent instructions

## Global constraints

- Never install, invoke, or use the Superpowers skill/plugin or any skill sourced from `obra/superpowers`.
- Keep committed source, documentation, configuration, tests, and commit messages in English. Before every commit and push, stage the intended files and run `pnpm check:english`.
- Never commit credentials, account sessions, production data, private hostnames, private project or instance names, public IP addresses, or private infrastructure paths.

## Preview and debug environment selection

Before starting a desktop preview or debug session, follow [Development environment isolation](docs/development-environments.md), including the [hosted environment preflight](docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), and classify the work:

- Isolated development uses the loopback Docker backend or an explicitly approved remote development backend reached through an IAP-style SSH tunnel. Use an explicit loopback API origin, `VITE_KORDI_DEV_PROFILE=community`, a named `io.kordi.cloud.*` desktop profile, and the gray development app icon. Production updater endpoints must remain disabled.
- For an approved remote development preview, use `pnpm dev:cloud:remote` with locally exported target variables so the IAP tunnel, OAuth capability preflight, client process, and cleanup share one lifecycle. Never commit those target values.
- iOS backend development uses the `Kordi Beta` scheme, the `ai.kordi.ios.beta` bundle, and the loopback development API. The `Kordi` scheme is the production client and must remain pinned to `https://kordi.ai`. Never cross-connect either scheme.
- Desktop-only production operator previews require an active GitHub account listed in `deploy/dev/operator-github-allowlist.txt`, the approved `scripts/dev-cloud-operator.sh` launcher, its acknowledgement, the color product app icon, and `https://kordi.ai`.
- Work that can affect or restart a product server must run on the corresponding product-server machine. Validate the deployed product through the canonical production origin `https://kordi.ai`, never through an isolated local profile.
- If impact, authorization, or environment identity is uncertain, fail closed. Do not change environments or bypass a guard to continue.

Never copy production credentials or production data into an isolated development environment. Never publish database, cache, event bus, object-store, or sandbox ports publicly; bind every deliberately host-published development port to loopback. Product deployment helpers must receive an explicit project, zone, and instance instead of inheriting a gcloud default.

Use the supported Tauri debug commands so `scripts/run-with-debug-artifact-maintenance.sh` enforces the local disk budget before launch and after exit. Treat desktop `*:raw` debug commands as wrapper internals only. Artifact maintenance may delete only the regenerable paths documented in `docs/development/desktop-rust-build-artifacts.md`; it must preserve release outputs, archives, sources, application data, and worktrees, and must defer while a relevant build is active.

## Desktop auth and session loading

- Treat provider connection state and chat-ready model state as separate contracts. Authentication UI must reflect saved auth immediately, while send-time gating may still require a compatible discovered model.
- Keep Google and GitHub sign-in available on Kordi-controlled development and product login surfaces. Server capability discovery is diagnostic and must not hide or disable those official OAuth entry points; surface an actionable start error if a provider request fails.
- Do not block session selection on transcript hydration or live provider model discovery. Select the requested session immediately, render the shared transcript loading notice for an uncached local runtime, and replace it with authoritative messages when hydration completes.
- Start canonical group/contact page hydration on the user selection path. Keep the first page bounded and load older history through the existing sequence cursor.
- Live provider catalog discovery is best-effort. Fetch authenticated providers concurrently, keep a short timeout with static catalog fallback, and clear the desktop model-option cache after every successful auth mutation.
- Read-only background report agents must receive `search_sessions` and `read_session`, must not receive shell or file-mutation tools, and must fail closed instead of scanning broad filesystem roots when session observation is unavailable. Child processes must terminate with their owning runtime and keep the bounded process timeout.
