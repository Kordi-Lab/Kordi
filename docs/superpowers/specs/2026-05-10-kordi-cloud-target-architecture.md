# Kordi Cloud Target Architecture (k3s + WS Gateway + NATS + PG + Redis + Temporal + MinIO + Agent Workers)

The user's stated production target: **a multi-service stack on k3s supporting 长连接 (long-lived realtime connections)**. This spec maps every component to its role, sequences the build into single-session-sized PRs, and pins the smallest first slice that's actually achievable in one turn.

## Component map

| Component | Role | First-session form |
|---|---|---|
| **k3s** | Single orchestration plane | Single-node cluster on `takotako`; `--disable traefik` so Caddy stays the public TLS terminator |
| **WebSocket Gateway** | Authenticates client long-connections, fans events to subscribers | Endpoint inside the existing `kordi-cloud-server` binary first; split into its own service later |
| **Message / Sync Services** | Append-only message log + per-user/per-device sync cursors | Already partly built: `bridges/cloud-server/src/messages/log.rs`. Cursor + `/v1/sync` is Phase 3 of #332 |
| **NATS JetStream** | Durable pub/sub bus + work queues | Helm chart in cluster; cloud-server publishes `message.arrived.<account>` events |
| **PostgreSQL** | Primary data store | CloudNativePG operator or bitnami chart; backfill from SQLite via dump+import |
| **Redis** | Presence (online flag), cross-replica rate-limit counters, session cache | bitnami chart; cloud-server gains a `redis` feature flag |
| **Temporal** | Durable workflows for signup verification, scheduled jobs, multi-step migrations | Official `temporal` helm chart; first workflow is "send signup verification email" once SMTP is wired |
| **MinIO / S3** | Content-addressed object storage for attachments | MinIO operator; the message-log gains an attachment manifest table referencing object keys |
| **Agent Workers** | Background fleet that consumes agent-run requests from NATS | New `kordi-cloud-agent-worker` crate; its first job is server-side LLM tool execution dispatched from the chat surface |

## Sequenced sessions

Each row is a single-session deliverable. Each ends with verification (cluster-side health check, DB query, or test). Each is reversible.

| # | Session | Deliverable | Verification |
|---|---|---|---|
| 1 | This session | Design spec + k3s install script (unrun) + Dockerfile + manifest skeleton + README | All artifacts under `bridges/cloud-server/deploy/k3s/`. No infra changes. |
| 2 | k3s install | Run `install-k3s.sh` on `takotako` with `--disable traefik`. Verify single-node cluster. Add Caddy → cluster reverse-proxy. | `kubectl get nodes` shows Ready; existing services on the VM untouched. |
| 3 | Postgres | Deploy CloudNativePG (or bitnami) chart. Provision a `kordi-cloud` database. | `kubectl exec ... -- psql -c '\l'` shows the DB. |
| 4 | Cloud-server containerized + Postgres-backed | Build Docker image. Replace SQLite calls in `bridges/cloud-server` with sqlx/Postgres. Deploy as Deployment + Service in k3s. | `curl https://kordi-cloud.<domain>/health` returns ok; signup persists to Postgres. |
| 5 | NATS JetStream | Deploy NATS chart with JetStream enabled. Cloud-server publishes `message.created.<account>` on every signup/contact-add. | `nats stream info` shows messages queued. |
| 6 | Redis | Deploy Redis chart. Move presence + rate-limit counters from in-memory to Redis. | Cross-replica rate-limit test: 2 cloud-server pods share the same lockout decision. |
| 7 | WebSocket Gateway endpoint | Add `/ws` to `kordi-cloud-server`, authenticated by the cloud session token. Each connection subscribes to NATS for `message.arrived.<own-account>`. | A second user adds the first as a contact; the first's open WS receives the event live. |
| 8 | MinIO + attachments | Deploy MinIO chart. New `attachments` table referencing object keys; signed-URL upload from the desktop. | Upload an avatar from desktop signup; object lands in MinIO; subsequent `/me` returns the signed download URL. |
| 9 | Temporal | Deploy temporal-server chart. First workflow: signup verification (SMTP send + cooldown + retry). | Sign up a new account; receive verification email; workflow shows in Temporal UI. |
| 10 | Agent worker fleet | New `kordi-cloud-agent-worker` crate consumes `agent.run.requested` from NATS. | A chat message that triggers an agent run completes via the worker, response published back. |

After step 10 the full topology is running. Steps 11+ are operational: monitoring (Prometheus), tracing (OpenTelemetry), backups, rolling-update verification, etc.

## Migration invariants

1. **Existing single-VM cloud-server keeps working through every step.** Each session migrates one component. If a session breaks, you roll back that one commit and the previous state is intact.
2. **Caddy stays the TLS terminator.** k3s gets `--disable traefik` so we don't fight over 443. Caddy reverse-proxies to a NodePort on the cluster.
3. **Existing local-first services on `takotako` (`bridges-server`, the various `kordi-pr*` deploys) are not migrated into k3s.** They keep running on the host. k3s is for the cloud-native services only.
4. **No data loss.** When the SQLite → Postgres migration lands, both databases live side-by-side until the cutover is verified, then SQLite is retired.
5. **No surprise costs.** Every chart we deploy uses sensible-default resource requests. The total stack should fit comfortably on a single multi-core VM during early phases.

## Coexistence with `takotako` today

From the read-only probe earlier:
- Debian 12, x86_64
- Caddy on 80/443/2019, multiple `kordi-pr*` services, bridges-server, etc.
- Ports 17080 + 17081 already bound

The k3s install must:
- Bind only to ports it doesn't already use. k3s defaults to 6443 (API server), 10250 (kubelet), 8472/UDP (flannel VXLAN). None conflict with what's there.
- Run with `--disable traefik` — we use Caddy.
- Run with `--write-kubeconfig-mode 644` so non-root (`shu_yang`) can `kubectl`.
- Use a non-default cluster CIDR if the standard 10.42.0.0/16 collides with anything (probe shows nothing in that range, so the default should be fine).

## Out of scope for this spec

- Multi-cluster / multi-region. Single-node k3s on `takotako` only.
- Network mesh (Istio, Linkerd). Plain Kubernetes Services through cluster DNS.
- Custom CRDs / operators beyond what the dependency charts ship.
- Authn beyond what `kordi-cloud-server` already does (cloud session tokens). External SSO is a future phase.

## What this session delivers

Files, no infrastructure changes:

- `docs/superpowers/specs/2026-05-10-kordi-cloud-target-architecture.md` — this doc.
- `bridges/cloud-server/Dockerfile` — multi-stage build producing a slim runtime image of the existing single-binary cloud-server.
- `bridges/cloud-server/deploy/k3s/install-k3s.sh` — unrun script that lays out the k3s install on `takotako` with the constraints above.
- `bridges/cloud-server/deploy/k3s/manifests/` — namespace, deployment, service skeleton for the cloud-server (used by session 4).
- `bridges/cloud-server/deploy/k3s/README.md` — operator playbook indexing the multi-session sequence.

Verification this session: nothing on the VM. The Dockerfile builds a working image locally (`docker build` succeeds). All other artifacts are reviewable text.
