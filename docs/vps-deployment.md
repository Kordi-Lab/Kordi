# Deploy Kordi on your own VPS

This path runs on a Linux amd64 VPS over ordinary SSH. It does not require
gcloud, a Google Cloud project, Kordi's deployment workflows, or Kordi's model
credentials. Existing GCP deployment helpers remain available separately.

It provisions a single-node k3s installation's application stack: PostgreSQL,
Redis, NATS JetStream, MinIO, Cloud API, OMP route worker, and Cloud Agent Runner.
Runner file and shell operations use Kubernetes jobs with persistent workspaces,
resource defaults, and a network policy that blocks private infrastructure.
Caddy on the host terminates HTTPS. This is a single-server deployment, not HA.

The initial stack covers accounts, messaging, attachments, provider routes, and
hosted agent execution. LiveKit calls, APNs, connector credentials, release-file
publishing, and the optional Temporal adapter require their own configuration.
The development Temporal manifest is not installed by this bootstrap.

## 1. Prepare a dedicated host

Start with an amd64 Ubuntu/Debian VPS, a non-root operator user with sudo, and
two DNS names pointing at the host: one for the API and one for object storage.
About 16-24 GB RAM gives a useful starting budget; measure your actual workload
and Agent concurrency. Leave disk space for container builds, volumes, and backups.

Install Git, Python 3.11 or newer with venv support, and Caddy using the operating system's
supported installation instructions. Install Docker with Buildx on your builder
(the VPS or a separate machine); k3s uses its own containerd at runtime.

Restrict public ingress to your SSH port and TCP 80/443 using the host/provider
firewall. Do not expose Kubernetes 6443, databases, the MinIO console, or NodePorts.
Keep the default k3s networking and network-policy controller enabled for this path.

Clone a reviewed Kordi revision on the VPS. From the repository root, install k3s:

```bash
sudo KORDI_KUBE_USER=YOUR_OPERATOR_USER \
  bash bridges/cloud-server/deploy/k3s/install-k3s.sh
sudo python3 -m venv /opt/kordi-vps-tools
sudo /opt/kordi-vps-tools/bin/pip install PyYAML==6.0.2
```

The installer records the loopback-only NodePort configuration. The deployment
helper refuses to run without that configuration and always addresses the local
k3s kubeconfig explicitly. It never uses the operator's current kubectl context.

## 2. Build and import your images

On the builder, use a clean checkout of the same reviewed revision:

```bash
bash scripts/build-vps-images.sh /var/tmp/kordi-images
```

This builds Linux amd64 OCI archives for all three applications. It emits
`images.json` and `SHA256SUMS` alongside them. Transfer that directory to the VPS
using your SSH account; no cloud-specific transfer command is needed.

On the VPS, verify the archive checksums and import the images:

```bash
cd /var/tmp/kordi-images
sha256sum --check SHA256SUMS
for archive in cloud-server cloud-agent-runner omp-route-worker; do
  sudo k3s ctr --namespace k8s.io images import "$archive.oci.tar"
done
```

Alternatively supply your own registry references pinned to `@sha256:...` and
configure registry access on k3s. Mutable tags such as `latest` are rejected.

## 3. Create private configuration

From the repository root on the VPS:

```bash
sudo install -d -m 0700 /etc/kordi-vps
sudo /opt/kordi-vps-tools/bin/python scripts/vps-deploy.py init \
  --config /etc/kordi-vps/config.json
sudoedit /etc/kordi-vps/config.json
```

`init` generates passwords, internal tokens, a provider-encryption secret, and
a stable storage ID. It creates a mode-0600 file and refuses to overwrite it.
Keep the file outside Git and include it in your encrypted backups. Do not
regenerate its `generated` values or `storage_id` when upgrading or adding a domain.

Set:

- `public_origin`: the canonical HTTPS API origin, for example `https://chat.example.com`.
- `additional_origins`: optional HTTPS aliases of this same backend and database.
- `object_origin`: a different HTTPS origin, for example `https://files.example.com`.
- `images`: copy the three entries from the builder's `images.json`.
- `server`: the operator-owned environment settings described below.

Every API alias routes to the same API deployment. Adding a domain does not create
another namespace, database, account store, or attachment bucket. Client endpoint
selection is separate; a domain alias does not update an already installed client.

## 4. Configure signup and service models

Configure at least one complete Google/GitHub OAuth client or working SMTP signup
delivery before deploying. Email/password signup requires SMTP delivery; OAuth-only
installations can register through their configured provider. No verification
bypass is enabled by this installer.

For each OAuth provider, register the callback under your canonical API origin:

```text
https://chat.example.com/v1/cloud/auth/oauth/google/callback
https://chat.example.com/v1/cloud/auth/oauth/github/callback
```

Set `KORDI_OAUTH_GOOGLE_CLIENT_ID` / `KORDI_OAUTH_GOOGLE_CLIENT_SECRET` and/or the
corresponding `GITHUB` settings. These are your own applications. Google OAuth
sign-in and Vertex model authentication are separate services.

SMTP settings are `KORDI_AUTH_SMTP_HOST`, `PORT`, `USERNAME`, `PASSWORD`, and `FROM`.
Supply provider credentials privately and verify actual email delivery after deployment.

System and Support model features are disabled in the generated configuration.
Accounts and human messaging do not require a service-model API key. To enable the
built-in model services, configure your chosen OpenAI-compatible Chat Completions
endpoint and a model supporting the required streaming/tool-calling behavior:

```json
{
  "KORDI_SERVICE_MODEL_PROVIDER": "openai-compatible",
  "KORDI_SERVICE_MODEL_BASE_URL": "https://models.example.com/v1",
  "KORDI_SERVICE_MODEL_MODEL": "your-model-id",
  "KORDI_SERVICE_MODEL_API_KEY": "your-private-api-key",
  "KORDI_SYSTEM_AGENT_ENABLED": "true",
  "KORDI_SUPPORT_ENABLED": "true",
  "KORDI_SUPPORT_OWNER_EMAIL": "support@example.com"
}
```

These are entries inside `server`, not a replacement for the complete config.
For OpenAI itself use `openai` and `https://api.openai.com/v1`. Model availability,
compatibility, and billing are determined by the operator's provider; arbitrary
native Anthropic/Gemini APIs are not automatically OpenAI-compatible.

Configuration precedence, from highest to lowest:

1. Feature settings: `KORDI_SYSTEM_AGENT_PROVIDER`, `KORDI_SYSTEM_AGENT_OPENAI_API_KEY`,
   `KORDI_SYSTEM_AGENT_OPENAI_BASE_URL`, `KORDI_SYSTEM_AGENT_OPENAI_MODEL`; or the
   corresponding `KORDI_SUPPORT_*` settings.
2. Existing legacy `KORDI_PIP_*` settings for the System agent only.
3. Shared `KORDI_SERVICE_MODEL_*` defaults.
4. Existing built-in defaults where provided by the server.

Overrides are per field. When moving a service to another provider, set its key,
endpoint, model, and provider together to avoid pairing one provider's key with
another provider's endpoint. `ENABLED=false` still disables the feature even when
a shared key exists. The VPS helper requires an explicit model for enabled services.

Vertex remains an explicit choice in the existing GCP deployment, using the
existing workload-identity configuration. The VPS bootstrap intentionally uses
operator API keys and does not create or copy Google identities. Member-owned
provider connections remain separate from these operator-funded System/Support keys.

## 5. Deploy and enable HTTPS

```bash
sudo /opt/kordi-vps-tools/bin/python scripts/vps-deploy.py check \
  --config /etc/kordi-vps/config.json
sudo /opt/kordi-vps-tools/bin/python scripts/vps-deploy.py apply \
  --config /etc/kordi-vps/config.json
```

`check` validates configuration and renders manifests in memory without contacting
the cluster or model provider. `apply` runs on the selected Linux host, locks its
deployment state, creates secrets, provisions storage, and waits for service rollouts.
It refuses to take over an existing namespace owned by another installation or
replace that installation's generated passwords and encryption keys. Network
policies and permissions are installed before workloads start. Model/OAuth/SMTP
configuration changes restart the applications even when their images are unchanged.

On this dedicated VPS, review the generated `/var/lib/kordi-vps/Caddyfile`. Install
it as your Caddy config (or merge its site blocks if you already host other sites):

```bash
sudo caddy validate --config /var/lib/kordi-vps/Caddyfile --adapter caddyfile
sudo install -m 0644 /var/lib/kordi-vps/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://chat.example.com/health
```

Only Caddy exposes HTTP(S). It proxies the API and signed S3 requests to loopback
NodePorts. The MinIO console stays internal. Attachment clients receive the public
object origin rather than a cluster-only address.

Before inviting users, verify signup/email delivery, each configured OAuth flow,
two-account messaging, attachment upload/download, reconnect/restart persistence,
and one real Agent turn with your selected model. Then verify the same account and
message IDs through each configured API alias.

## Clients, updates, and recovery

The hosted desktop and iPhone releases currently target Kordi's product origin.
This backend installer does not silently retarget those binaries. See the
[desktop source guide](run-cloud-desktop.md) for explicit API configuration;
an independently distributed client also needs consistent native/frontend endpoint
configuration, OAuth callbacks, and an operator-owned updater channel. The existing
iPhone production scheme remains pinned to the product origin. Do not redirect the
shared development/Beta scheme to a public deployment.

Keep the operator config, application revision, PostgreSQL data, MinIO objects,
and required Runner workspaces backed up together. Database dumps alone do not
include attachments. Take encrypted off-host backups and test a restore on an
isolated host before depending on the installation.

Reapplying the same installation retains volumes and generated credentials. Before
updating an already deployed API, the helper creates a private PostgreSQL dump and
stops if that fails. This is not a complete or restore-verified backup: arrange
object/workspace backups and a restore trial separately. The helper does not delete
PVCs, restore databases, automatically roll back schema changes, or reset accounts.
Review migrations before image upgrades; old images may not support a new schema.

Adding a second API domain is not a second server. Both aliases share this VPS's
availability. If an old installation later becomes accessible, migrate its data
through a separately scoped and verified restore/merge operation.
