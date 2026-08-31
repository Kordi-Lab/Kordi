# Kordi Cloud Server on k3s

Deployment assets for the Cloud product backend topology: k3s + Postgres + Redis + NATS JetStream + MinIO + Temporal + WebSocket gateway + Cloud agent workers.

Production public base URL:

```text
https://kordi.ai
```

Development/QA should use an operator-provided public test Cloud API base or a self-hosted compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not commit provider tokens, auth tokens, database credentials, account secrets, or private operator host details.

Before using this deploy path, select and authorize the target through [Development environment isolation](../../../../docs/development-environments.md) and the [hosted environment preflight](../../../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug). Obtain the real product project, zone, and instance values privately; never commit them.

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
export KORDI_CLOUD_GCP_PROJECT="<operator-gcp-project>"
export KORDI_CLOUD_REMOTE_DIR="$HOME/kordi-cloud-server-deploy"
```

The helpers reject an omitted project instead of inheriting the active gcloud project. Review the target summary printed before any remote operation.

## Install k3s on an operator-provided host

```bash
KORDI_CLOUD_SSH_TARGET="<PRODUCT_GCE_INSTANCE>" \
KORDI_CLOUD_SSH_ZONE="<PRODUCT_GCP_ZONE>" \
KORDI_CLOUD_GCP_PROJECT="<PRODUCT_GCP_PROJECT>" \
  bash bridges/cloud-server/deploy/k3s/bootstrap-product-host.sh

KORDI_CLOUD_SSH_TARGET="<PRODUCT_GCE_INSTANCE>" \
KORDI_CLOUD_SSH_ZONE="<PRODUCT_GCP_ZONE>" \
KORDI_CLOUD_GCP_PROJECT="<PRODUCT_GCP_PROJECT>" \
  bash bridges/cloud-server/deploy/k3s/configure-product-firewall.sh

bash bridges/cloud-server/deploy/sync-and-build.sh

ssh <operator-host> \
  'sudo bash /path/to/kordi/bridges/cloud-server/deploy/k3s/install-k3s.sh'

ssh <operator-host> 'kubectl get nodes -o wide'
ssh <operator-host> \
  'kubectl apply -f /path/to/kordi/bridges/cloud-server/deploy/k3s/manifests/namespace.yaml'
```

The instance-specific firewall tag allows public TCP 22, 80, and 443, keeps
private VPC traffic available, and denies every other public ingress port.
This protects k3s, Postgres, Redis, and application ports even when the shared
VPC still has older broad allow rules for unrelated hosts.

## Build and deploy Cloud server

```bash
bash bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-$(date +%Y%m%d-%H%M%S)" \
  bash bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Required production server environment:

```bash
KORDI_CLOUD_PUBLIC_BASE_URL=https://kordi.ai
KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST=http://127.0.0.1:,http://localhost:,https://kordi.ai,kordi://oauth/callback
KORDI_CHAT_SYNC_CURSOR_SECRET=<from kordi-chat-sync>
KORDI_CHAT_REALTIME_ALLOWED_ORIGINS=https://kordi.ai,tauri://localhost,http://tauri.localhost,http://127.0.0.1:1420,http://127.0.0.1:1422,http://127.0.0.1:1482,http://127.0.0.1:1484,http://127.0.0.1:1486
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
```

For test/self-hosted Cloud servers, use that server's public HTTPS origin for `KORDI_CLOUD_PUBLIC_BASE_URL` and provider callback URLs.

Production provider callback URLs:

- `https://kordi.ai/v1/cloud/auth/oauth/google/callback`
- `https://kordi.ai/v1/cloud/auth/oauth/github/callback`

Health check:

```bash
curl https://kordi.ai/health
```

## Built-in Kordi Support contact

When `KORDI_SUPPORT_ENABLED=true`, the server prepends one locked, system-owned
`Kordi Support` agent to every signed-in user's contact list. Direct messages
to that exact agent are queued for the hosted runner. The contact detail also
contains a support form for questions, product issues, and feedback.

Support form submissions are written to Postgres before email delivery is
attempted. A background worker retries failed notifications without requiring
the desktop to remain open. Production addresses are stored in Kubernetes
Secrets rather than this repository. The locked support-owner account,
notification inbox, and outbound-mail identity are configured independently.

Never use a Google account password for SMTP and never place mail credentials
in a manifest, shell history, desktop environment, or repository. Enable
two-step verification on the mailbox, create a dedicated Gmail app password,
then create the Kubernetes Secret from a trusted operator shell:

```bash
read -r -p "Support owner email: " KORDI_SUPPORT_OWNER_EMAIL
read -r -p "Support inbox: " KORDI_SUPPORT_INBOX
read -r -p "SMTP username: " KORDI_SUPPORT_SMTP_USERNAME
read -r -p "SMTP From mailbox: " KORDI_SUPPORT_SMTP_FROM
read -s -p "SMTP app password: " KORDI_SUPPORT_SMTP_PASSWORD
echo
kubectl -n kordi-cloud create secret generic kordi-support-config \
  --from-literal=enabled=true \
  --from-literal=owner-email="$KORDI_SUPPORT_OWNER_EMAIL" \
  --from-literal=inbox="$KORDI_SUPPORT_INBOX" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n kordi-cloud create secret generic kordi-support-smtp \
  --from-literal=username="$KORDI_SUPPORT_SMTP_USERNAME" \
  --from-literal=from="$KORDI_SUPPORT_SMTP_FROM" \
  --from-literal=app-password="$KORDI_SUPPORT_SMTP_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
unset KORDI_SUPPORT_OWNER_EMAIL KORDI_SUPPORT_INBOX
unset KORDI_SUPPORT_SMTP_USERNAME KORDI_SUPPORT_SMTP_FROM KORDI_SUPPORT_SMTP_PASSWORD
```

The hosted support chat uses a dedicated OpenAI API key owned by the service.
It never borrows a provider-auth snapshot from the support owner or the person
asking for help. Store the key only in the `kordi-support-openai` Secret:

```bash
read -s -p "Kordi Support OpenAI API key: " KORDI_SUPPORT_OPENAI_API_KEY
echo
kubectl -n kordi-cloud create secret generic kordi-support-openai \
  --from-literal=api-key="$KORDI_SUPPORT_OPENAI_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
unset KORDI_SUPPORT_OPENAI_API_KEY
```

The system agent is created and locked by the server; it is intentionally
hidden from normal Factory edit/archive routes.

Verify without printing any secret values:

```bash
kubectl -n kordi-cloud get secret kordi-support-smtp
kubectl -n kordi-cloud get secret kordi-support-config
kubectl -n kordi-cloud get secret kordi-support-openai
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m \
  | grep -E 'Kordi support|support tickets'
```

## Voice and video media

Read [Hosting Kordi voice and video calls](../../../../docs/call-hosting.md)
before creating credentials or changing the edge. It is the operational source
of truth for development tunnels, product ports, readiness checks, iOS
background ringing, and the required two-account acceptance test.

Production calls use the single-node LiveKit deployment in `manifests/livekit.yaml`.
Create one API key and a secret of at least 32 random bytes, then store the
client URL and the LiveKit `key: secret` pair without printing either value:

```bash
read -s -p "LiveKit API key: " KORDI_LIVEKIT_API_KEY
echo
read -s -p "LiveKit API secret: " KORDI_LIVEKIT_API_SECRET
echo
kubectl -n kordi-cloud create secret generic kordi-livekit \
  --from-literal=url=wss://kordi.ai \
  --from-literal=api-key="$KORDI_LIVEKIT_API_KEY" \
  --from-literal=api-secret="$KORDI_LIVEKIT_API_SECRET" \
  --from-literal=keys="$KORDI_LIVEKIT_API_KEY: $KORDI_LIVEKIT_API_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
unset KORDI_LIVEKIT_API_KEY KORDI_LIVEKIT_API_SECRET
```

Install the reviewed Caddy file and run `configure-product-firewall.sh` before
deploying. Caddy sends only `/rtc` to LiveKit. The firewall exposes ICE
TCP/UDP, TURN/UDP, and the bounded TURN relay range; database and application
ports stay private. During CDN staging, direct HTTP/HTTPS remains available;
after cutover it must be disabled with `KORDI_CLOUD_CDN_ENABLED=true`.

The public `kordi.ai` origin is a global external Application Load Balancer.
It routes `/updates/releases/*` through a Cloud CDN-enabled backend and every
other path through a non-CDN backend. Both backends use the same private Caddy
origin. Cross-host redirects must never match product routes because they
break browser CORS preflights and can also disable WebSockets and desktop
updates.

Before DNS cutover, set
`KORDI_VERIFY_RESOLVE_IP=<GREEN_STATIC_IP>` so the deploy checks exercise the
green edge rather than the host currently returned by public DNS. Use
`KORDI_VERIFY_PUBLIC_ORIGINS=false` only when the edge is intentionally absent.
After cutover, leave public-origin checks enabled without the resolution
override.

## Product edge

The load balancer reaches Caddy through the zonal VM endpoint on port `8080`.
Only Google Front End proxy ranges may reach that port. Caddy then reaches the
Kubernetes Service through its fixed TCP NodePort at `127.0.0.1:30081`.
Kubernetes routes the connection to ready pods without an embedded cluster IP
or a long-running `kubectl port-forward` process. The reviewed K3s drop-in
restricts NodePorts to loopback, and the product firewall must continue
denying public TCP access to the NodePort.

Install the K3s drop-in and restart K3s first. Then deploy the updated Cloud
server manifest with `deploy-cloud-server.sh`; the deploy fails closed unless
the host NodePort is healthy. Switch Caddy only after that check passes.

From the synced repository on the product host:

```bash
sudo install -d -m 0755 /etc/rancher/k3s/config.yaml.d
sudo install -m 0644 \
  bridges/cloud-server/deploy/k3s/config/90-kordi-cloud-nodeport.yaml \
  /etc/rancher/k3s/config.yaml.d/90-kordi-cloud-nodeport.yaml
sudo systemctl restart k3s

# Run deploy-cloud-server.sh from the operator workstation before continuing.
curl --fail --silent --show-error http://127.0.0.1:30081/health

sudo install -m 0644 \
  bridges/cloud-server/deploy/Caddyfile.snippet \
  /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

sudo systemctl disable --now kordi-cloud-port-forward.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/kordi-cloud-port-forward.service
sudo systemctl daemon-reload
```

The complete Caddy config preserves both public responsibilities:

- website and beta intake on `kordi.ai`;
- Cloud API, WebSocket, health, and updater routes on `kordi.ai`.

### CDN staging and cutover

Use a global Certificate Manager certificate that was provisioned with DNS
authorization and is already `ACTIVE`; this avoids a certificate outage during
the DNS cutover. If the DNS provider temporarily blocks authorization changes,
a self-managed copy of the current valid Caddy certificate may bootstrap the
edge, but its expiry must be recorded and it must be replaced by the managed
certificate before renewal. Keep certificate resource names local to the
operator environment. Then stage the edge without changing DNS:

```bash
export KORDI_CLOUD_SSH_TARGET="<PRODUCT_GCE_INSTANCE>"
export KORDI_CLOUD_SSH_ZONE="<PRODUCT_GCP_ZONE>"
export KORDI_CLOUD_GCP_PROJECT="<PRODUCT_GCP_PROJECT>"
export KORDI_CLOUD_CDN_CERTIFICATE="<ACTIVE_CERTIFICATE_MANAGER_CERTIFICATE>"

bash bridges/cloud-server/deploy/k3s/configure-product-firewall.sh
bash bridges/cloud-server/deploy/k3s/configure-updater-cdn.sh
```

The CDN helper creates a zonal `GCE_VM_IP_PORT` endpoint for Caddy, separate
cacheable and non-cacheable backend services, the release-path URL rule, HTTP
redirect, and global HTTPS frontend. It never changes DNS. `USE_ORIGIN_HEADERS`
keeps the stable `latest/Kordi.dmg` alias at `no-store`, while versioned assets
retain their one-year immutable policy. Dynamic compression is disabled on the
release backend so byte ranges continue to describe the signed artifact bytes.

Before cutover, use the staged edge IP printed by the helper with `curl
--resolve` and verify the homepage, health, auth preflight, WebSocket upgrade,
updater decision matrix, immutable GET/HEAD, and a bounded byte range. An
immutable response must include `X-Kordi-CDN-Cache: miss` or `hit`, and a warm
repeat must become `hit`. A range must return `206`, `Accept-Ranges: bytes`, an
exact `Content-Range`, the expected range length, and matching local bytes.

After that matrix passes, point `kordi.ai` and `www.kordi.ai` at the staged
global edge IP. Repeat the matrix through normal DNS, then close the direct
origin path:

```bash
KORDI_CLOUD_CDN_ENABLED=true \
  bash bridges/cloud-server/deploy/k3s/configure-product-firewall.sh
```

Verify the matrix again. If edge verification fails before the origin is
closed, restore the prior DNS record. If it fails afterward, first restore the
direct firewall mode with `KORDI_CLOUD_CDN_ENABLED=false`, then restore prior
DNS. Never change or delete an immutable release object during edge rollback.

Keep Caddy stopped on a green host until its website assets, beta-intake
database, TLS state, and product data have been migrated and verified. During
the final cutover, start Caddy before changing DNS and verify it with
`curl --resolve` against the green host.

## Production host cutover

Treat a host replacement as a short, reversible write freeze. Do not point DNS
at a green host merely because `/health` passes.

Before the freeze:

1. Reserve the green host's external IP and confirm deletion protection,
   Secure Boot, vTPM, integrity monitoring, unattended upgrades, snapshots,
   and the instance-scoped firewall.
2. Add the canonical Google OAuth callback:
   - `https://kordi.ai/v1/cloud/auth/oauth/google/callback`
3. The production GitHub credential is an OAuth App, which supports only one
   authorization callback URL. The lowest-risk migration is to create a second
   OAuth App for the green host with:
   - homepage: `https://kordi.ai`
   - callback: `https://kordi.ai/v1/cloud/auth/oauth/github/callback`
   Install that app's client ID and secret only on the green host. The old host
   then keeps its current OAuth App throughout DNS propagation and rollback.
   If the existing OAuth App must be reused, replace its callback only during
   the coordinated cutover, after the active server generates and accepts the
   canonical callback.
4. Restore a recent copy of Postgres, MinIO, NATS JetStream, the beta-intake
   SQLite database, the website, and Caddy TLS state to the green host.
5. Keep the green agent runner scaled to zero until the final database copy is
   complete. This prevents copied queued work from being executed twice.
6. Verify the green origin without changing DNS:

   ```bash
   curl --resolve kordi.ai:443:<GREEN_STATIC_IP> https://kordi.ai/health
   ```

For the final cutover:

1. Stop writes on the old API and beta-intake service, and scale its agent
   runner to zero.
2. Take a fresh consistent Postgres dump and SQLite backup, mirror MinIO with
   metadata preserved, and take a final JetStream snapshot.
3. Restore those final copies on the green host and compare schema versions,
   row counts, object counts and bytes, stream messages and bytes, and beta
   table counts. Do not compare or print credentials.
4. Start Caddy, keep the green runner at zero, and repeat the canonical,
   CORS-preflight, updater, OAuth-start, homepage, and beta-intake
   checks with `curl --resolve`.
5. Change the `kordi.ai` and `www.kordi.ai` records as required so the product
   origin reaches the green static IP.
6. After public DNS and TLS checks pass, scale the green runner to one and
   require a stable Ready pod with zero restarts.
7. Exercise email/password login, Google and GitHub OAuth, WebSocket sync,
   direct and group messages, agent execution, beta intake, and desktop update
   metadata before ending the freeze.

Keep the old VM stopped but intact for the rollback window. A rollback points
the product origin back to the old static IP and resumes only the old workloads.
Remove every temporary migration key from both hosts after acceptance.

For test servers:

```bash
curl <PUBLIC_TEST_CLOUD_API_BASE>/health
```

## Private desktop release storage

Desktop release objects live in the private MinIO bucket `kordi-releases`. The Cloud server receives a dedicated read-only identity through Kubernetes Secret `kordi-release-reader`; the release publisher uses a separate identity stored in GCP Secret Manager. The publisher can create and read objects but cannot delete any object. Channel cleanup and rollback use strict unpublished tombstones written with ETag compare-and-swap, so every normal transition uses conditional PUT and cannot erase a concurrent pointer. Neither identity reuses `minio-credentials` or the attachment bucket.

After MinIO is running, provision or reconcile the scoped identities from a trusted operator machine:

```bash
export KORDI_CLOUD_SSH_TARGET="<PRODUCT_GCE_INSTANCE>"
export KORDI_CLOUD_SSH_ZONE="<PRODUCT_GCP_ZONE>"
export KORDI_CLOUD_GCP_PROJECT="<PRODUCT_GCP_PROJECT>"
bash bridges/cloud-server/deploy/k3s/create-release-credentials.sh
```

The script creates no anonymous access. It verifies that the reader cannot write, that the publisher can write/read, and that the publisher cannot delete either immutable objects or channel pointers. Publisher values are stored under:

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
