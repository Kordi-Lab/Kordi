# Legacy systemd deploy for `kordi-cloud-server`

This directory contains the legacy/internal single-host systemd deploy path. Product-like Cloud deployments should use `bridges/cloud-server/deploy/k3s/`.

Production public base URL:

```text
https://kordi.ai
```

Development/QA should use an operator-provided public test Cloud API base or a self-hosted compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not commit or share provider tokens, auth tokens, database credentials, account secrets, or private operator host details.

Before using this deploy path, select and authorize the target through [Development environment isolation](../../../docs/development-environments.md) and the [hosted environment preflight](../../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug). Never treat an isolated development host as a product deployment target.

## Required operator environment

Set these locally before running helper scripts:

```bash
export KORDI_CLOUD_SSH_TARGET="<operator-gcloud-ssh-target>"
export KORDI_CLOUD_SSH_ZONE="<operator-gcloud-zone>"
export KORDI_CLOUD_GCP_PROJECT="<operator-gcp-project>"
export KORDI_CLOUD_REMOTE_DIR="$HOME/kordi-cloud-server-deploy"
```

The helpers reject an omitted project instead of inheriting the active gcloud project.

## Sync and build

```bash
bash bridges/cloud-server/deploy/sync-and-build.sh
```

## Install systemd service

Run only on an operator-provided host after reviewing `install.sh`:

```bash
ssh <operator-host> \
  'sudo KORDI_CLOUD_DEPLOY_USER=<operator-user> \
    KORDI_CLOUD_DEPLOY_GROUP=<operator-group> \
    bash /path/to/kordi/bridges/cloud-server/deploy/install.sh'
```

## Desktop testing

Point the desktop app at a public test or self-hosted Cloud API:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile approved-staging --title "Kordi Staging" --port 1422
```

Production builds default to `https://kordi.ai`.
