# Kordi Cloud Server on k3s

Deployment assets for the Cloud product backend topology: k3s + Postgres + Redis + NATS JetStream + MinIO + Temporal + WebSocket gateway + Cloud agent workers.

Production public base URL:

```text
https://coordinar.io
```

Development/QA should use an operator-provided public test Cloud API base or a self-hosted compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not commit provider tokens, auth tokens, database credentials, account secrets, or private operator host details.

## Why this exists alongside `bridges/cloud-server/deploy/`

Two deploy paths live side-by-side:

- `bridges/cloud-server/deploy/` — legacy/internal single-host systemd path.
- `bridges/cloud-server/deploy/k3s/` — Cloud product topology target.

Use k3s for product-like Cloud deployments.

## Required operator environment

Set these locally before running deploy scripts:

```bash
export KORDI_CLOUD_SSH_TARGET="<operator-gcloud-ssh-target>"
export KORDI_CLOUD_SSH_ZONE="<operator-gcloud-zone>"
export KORDI_CLOUD_REMOTE_DIR="$HOME/kordi-cloud-server-deploy"
```

## Install k3s on an operator-provided host

```bash
bash bridges/cloud-server/deploy/sync-and-build.sh

ssh <operator-host> \
  'sudo bash /path/to/kordi/bridges/cloud-server/deploy/k3s/install-k3s.sh'

ssh <operator-host> 'kubectl get nodes -o wide'
ssh <operator-host> \
  'kubectl apply -f /path/to/kordi/bridges/cloud-server/deploy/k3s/manifests/namespace.yaml'
```

## Build and deploy Cloud server

```bash
bash bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-$(date +%Y%m%d-%H%M%S)" \
  bash bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Required production server environment:

```bash
KORDI_CLOUD_PUBLIC_BASE_URL=https://coordinar.io
KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST=http://127.0.0.1:,http://localhost:,https://coordinar.io
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
```

Optional global support-agent environment:

```bash
KORDI_SUPPORT_AGENT_ENABLED=true
KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID=acct_<admin-or-system-owner>
KORDI_SUPPORT_AGENT_ID=cloud_agent_kordi_support
KORDI_SUPPORT_AGENT_NAME="Kordi Support"
KORDI_SUPPORT_AGENT_DESCRIPTION="Ask questions about Kordi or suggest improvements."
KORDI_SUPPORT_AGENT_DEFAULT_MODEL=<hosted-runner-model-id>
KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER=openai
KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE=<server-admin-auth-choice>
```

When enabled, the server bootstraps a locked system-managed Cloud Agent and exposes it as a default `Kordi Support` contact for every Cloud user. The support owner account must be an admin/system account with provider auth available for the hosted runner; end-user provider auth is not used for support responses.

The k3s manifest reads these values from an optional Secret named `kordi-cloud-support-agent` with keys `enabled`, `owner-account-id`, `agent-id`, `name`, `description`, `default-model`, `default-auth-provider`, and `default-auth-choice`.

For test/self-hosted Cloud servers, use that server's public HTTPS origin for `KORDI_CLOUD_PUBLIC_BASE_URL` and provider callback URLs.

Production provider callback URLs:

- `https://coordinar.io/v1/cloud/auth/oauth/google/callback`
- `https://coordinar.io/v1/cloud/auth/oauth/github/callback`

Health check:

```bash
curl https://coordinar.io/health
```

For test servers:

```bash
curl <PUBLIC_TEST_CLOUD_API_BASE>/health
```

## Coexistence with old systemd deploys

If a legacy systemd Cloud server is running on the same host, stop it before running the cluster Cloud server so two services do not compete for the same port.

```bash
ssh <operator-host> \
  'sudo systemctl stop kordi-cloud-server && sudo systemctl disable kordi-cloud-server'
```

## Rollback

Each deployment is image-tagged. Roll back by applying the previous known-good image tag to the relevant Deployment and waiting for rollout.
