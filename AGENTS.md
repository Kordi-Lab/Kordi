# Repository agent instructions

## Global constraints

- Never install, invoke, or use the Superpowers skill/plugin or any skill sourced from `obra/superpowers`.
- Keep committed source, documentation, configuration, tests, and commit messages in English. Before every commit and push, stage the intended files and run `pnpm check:english`.
- Never commit credentials, account sessions, production data, private hostnames, private project or instance names, public IP addresses, or private infrastructure paths.

## Preview and debug environment selection

Before starting a desktop preview or debug session, follow [Development environment isolation](docs/development-environments.md), including the [hosted environment preflight](docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), and classify the work:

- Isolated development uses the loopback Docker backend or an explicitly approved remote development backend reached through an IAP-style SSH tunnel. Use an explicit loopback API origin, `VITE_KORDI_DEV_PROFILE=community`, and a named `io.kordi.cloud.*` desktop profile. Production updater endpoints must remain disabled.
- Desktop-only production operator previews require an active GitHub account listed in `deploy/dev/operator-github-allowlist.txt`, the approved `scripts/dev-cloud-operator.sh` launcher, its acknowledgement, and `https://kordi.ai`.
- Work that can affect or restart a product server must run on the corresponding product-server machine. Validate the deployed product through the canonical production origin `https://kordi.ai`, never through an isolated local profile.
- If impact, authorization, or environment identity is uncertain, fail closed. Do not change environments or bypass a guard to continue.

Never copy production credentials or production data into an isolated development environment. Never publish database, cache, event bus, object-store, or sandbox ports publicly; bind every deliberately host-published development port to loopback. Product deployment helpers must receive an explicit project, zone, and instance instead of inheriting a gcloud default.
