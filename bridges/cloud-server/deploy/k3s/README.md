# Kordi Cloud Server on k3s

Multi-session rollout for the production cloud topology — k3s + Postgres + Redis + NATS JetStream + MinIO + Temporal + WebSocket gateway + agent workers — on `takotako`. The full architecture spec lives at `docs/superpowers/specs/2026-05-10-kordi-cloud-target-architecture.md`.

## Why this exists alongside `bridges/cloud-server/deploy/`

Two parallel deploys live side-by-side intentionally:

- **`bridges/cloud-server/deploy/`** (the systemd path) — single-binary, single-machine, single-replica. Useful for quick dev iteration on the cloud-server crate. **Not the production target.**
- **`bridges/cloud-server/deploy/k3s/`** (this directory) — production target. Multi-replica via k3s, Postgres, Redis, the full stack.

The systemd path is **not** a stepping stone *into* the k3s path; they're independent. Pick one for any given environment.

## Decision log

- **Postgres + Redis are mandatory for the cloud version.** *Cloud means multi-replica; SQLite serialises writes per file and only one replica can hold the write lock. The local-first server (`bridges/cli`) keeps SQLite; the cloud server does not.*
- **Caddy stays the public TLS terminator.** k3s installs with `--disable traefik` so we don't fight over 443. Caddy reverse-proxies into the cluster (NodePort or LoadBalancer service).
- **Single-node k3s on `takotako` to start.** Multi-node is a later phase.
- **Existing services on the host are not migrated into k3s.** `bridges/cli`, `kordi-pr*` previews, and other in-place deployments stay on systemd.

## Multi-session sequence

| # | Session | Status | Deliverable |
|---|---|---|---|
| 1 | architecture + bootstrap artifacts | **done in this commit** | spec doc, Dockerfile, install-k3s.sh, manifest skeleton, this README |
| 2 | install k3s on takotako | pending — needs your authorization | `sudo bash install-k3s.sh` on the VM, verify `kubectl get nodes` |
| 3 | Postgres in cluster | pending | CloudNativePG operator (recommended) OR bitnami chart, provision `kordi_cloud` DB, secret-managed credentials |
| 4 | sqlx + Postgres port | pending | replace `rusqlite` calls in `bridges/cloud-server/src/{auth,messages,server,db_runner,schema}` with sqlx; tests stay green |
| 5 | deploy cloud-server | pending | build Docker image on the VM (or push from local), apply `manifests/cloud-server-deployment.yaml`, point Caddy at the Service |
| 6 | NATS JetStream | pending | `nats-io/nats` chart, JetStream enabled, cloud-server publishes `cloud.message.*` events |
| 7 | Redis | pending | bitnami Redis chart, port the in-memory rate-limiter + presence to Redis |
| 8 | WebSocket gateway endpoint | pending | `/ws` on cloud-server, authenticated by cloud session token, subscribed to NATS for that account's events; first user-visible 长连接 milestone |
| 9 | MinIO + attachment storage | pending | MinIO operator, attachment manifest table, signed-URL upload from desktop |
| 10 | Temporal | pending | `temporalio/temporal` chart (Postgres-backed), first workflow = signup verification |
| 11 | agent worker fleet | pending | new `kordi-cloud-agent-worker` crate, NATS-consumed |

After step 11 the topology is complete. Steps 12+ are observability + ops hardening.

## How to run session 2 (when ready)

```bash
# from your laptop — push the repo (uses the existing rsync target dir from
# bridges/cloud-server/deploy/sync-and-build.sh).
bash bridges/cloud-server/deploy/sync-and-build.sh

# install k3s — read install-k3s.sh first.
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo bash /home/shu_yang/kordi-cloud-server-deploy/bridges/cloud-server/deploy/k3s/install-k3s.sh'

# verify
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'kubectl get nodes -o wide'

# create the namespace
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'kubectl apply -f /home/shu_yang/kordi-cloud-server-deploy/bridges/cloud-server/deploy/k3s/manifests/namespace.yaml'
```

Stops there for session 2. Sessions 3+ are separate PRs.

## Building the Docker image

```bash
# from the repo root, on any machine with docker
docker build -t kordi-cloud-server:dev -f bridges/cloud-server/Dockerfile .
```

The image is multi-stage: `rust:1.83-slim-bookworm` for the build, `debian:bookworm-slim` + tini + the binary + a non-root `kordi` user for runtime. Final image is around 80–100 MB.

In session 5 we either:

- **Push to the VM's local image cache via SSH + `docker save / docker load`**, or
- **Stand up a private registry inside the cluster** (a deferred operational decision).

## Coexistence with the existing systemd deploy

If you've previously run `bridges/cloud-server/deploy/install.sh`, that systemd unit binds port 17081. **Stop it before running the cluster cloud-server**, otherwise two services compete for the port:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo systemctl stop kordi-cloud-server && sudo systemctl disable kordi-cloud-server'
```

Cluster cloud-server is reached via the in-cluster Service (kordi-cloud-server.kordi-cloud.svc.cluster.local:17081), fronted by Caddy on the host.

## Rollback for any session

Each session is reversible by reverting its commit. For session 2 specifically (k3s install) there's also `/usr/local/bin/k3s-uninstall.sh` (provided by the k3s installer) that removes the cluster cleanly.

## What this directory deliberately does NOT contain (yet)

- **Postgres, Redis, NATS, MinIO, Temporal manifests** — those land in their own PRs in their own subdirectories. Putting them in skeleton form now would tempt premature `kubectl apply`.
- **Helm chart values files** — same reason.
- **An `Ingress` resource** — Caddy handles ingress from outside the cluster; we use a `Service` of type `ClusterIP` and a Caddy reverse-proxy. No `IngressClass` / cert-manager involved.
- **Image registry config** — TBD in session 5.
