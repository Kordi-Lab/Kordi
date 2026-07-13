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

## Private desktop release storage

Desktop release objects live in the private MinIO bucket `kordi-releases`. The Cloud server receives a dedicated read-only identity through Kubernetes Secret `kordi-release-reader`; the release publisher uses a separate identity stored in GCP Secret Manager. The publisher can create and read versioned objects and can delete only mutable `desktop/channels/*/latest.json` pointers for CAS-safe rollback and acceptance cleanup. It cannot delete immutable release objects. Neither identity reuses `minio-credentials` or the attachment bucket.

After MinIO is running, provision or reconcile the scoped identities from a trusted operator machine:

```bash
export KORDI_CLOUD_SSH_TARGET="kordi-product"
export KORDI_CLOUD_SSH_ZONE="us-central1-a"
export KORDI_CLOUD_GCP_PROJECT="hai-gcp-representation"
bash bridges/cloud-server/deploy/k3s/create-release-credentials.sh
```

The script creates no anonymous access. It verifies that the reader cannot write, that the publisher can write/read and delete channel pointers, and that the publisher cannot delete immutable versioned objects. Publisher values are stored under:

- `kordi-release-publisher-access-key`
- `kordi-release-publisher-secret-key`

Run the credential script before `deploy-cloud-server.sh`. Server deployment re-applies the private bucket bootstrap and runs a read-only `release-store-check` pod before rolling the Cloud server.

Required Cloud server variables are supplied by the deployment manifest:

```text
KORDI_RELEASE_S3_ENDPOINT=http://minio.kordi-cloud.svc.cluster.local:9000
KORDI_RELEASE_S3_BUCKET=kordi-releases
KORDI_RELEASE_S3_REGION=us-east-1
KORDI_RELEASE_S3_ACCESS_KEY=<from kordi-release-reader>
KORDI_RELEASE_S3_SECRET_KEY=<from kordi-release-reader>
```

## Coexistence with old systemd deploys

If a legacy systemd Cloud server is running on the same host, stop it before running the cluster Cloud server so two services do not compete for the same port.

```bash
ssh <operator-host> \
  'sudo systemctl stop kordi-cloud-server && sudo systemctl disable kordi-cloud-server'
```

## Rollback

Each deployment is image-tagged. Roll back by applying the previous known-good image tag to the relevant Deployment and waiting for rollout.
