# Deploying `kordi-cloud-server` on `takotako`

These artifacts deploy the cloud-native collaboration server to the user's GCP
Compute VM (`shu_yang@takotako` in `us-central1-c`). The VM already has Rust,
Caddy, and existing Kordi infrastructure running — these scripts coexist with
that.

## Files

| File | Where it runs | What it does |
|---|---|---|
| `sync-and-build.sh` | **Local** (your laptop) | Rsyncs the repo to the VM, runs `cargo build --release -p kordi-cloud-server` over SSH. |
| `install.sh` | **VM** (as root) | Stops whatever is on port 17081 (with confirmation), installs the systemd unit, enables + starts the new service, hits `/health`. |
| `uninstall.sh` | **VM** (as root) | Stops + disables + removes the systemd unit. Pass `--purge-data` to wipe the SQLite DB too. |
| `kordi-cloud-server.service` | **VM** | systemd unit template installed by `install.sh`. |
| `Caddyfile.snippet` | **VM** | Drop-in stanza for the existing Caddy config to terminate TLS for `kordi-cloud.<your-domain>` and reverse-proxy to `127.0.0.1:17081`. |

## Layout on the VM

```
/home/shu_yang/
├── kordi-cloud-server-deploy/      # source + target/release/kordi-cloud-server
└── kordi-cloud-server-data/        # SQLite database + WAL/SHM
```

## First-time deploy

From your laptop:

```bash
bash bridges/cloud-server/deploy/sync-and-build.sh
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo bash /home/shu_yang/kordi-cloud-server-deploy/bridges/cloud-server/deploy/install.sh'
```

`install.sh` will:

1. Detect what's bound to port 17081 (the previous auth-foundation preview, per
   what we saw on the probe).
2. Print the process tree and ask `y/N` before stopping it.
3. Install `/etc/systemd/system/kordi-cloud-server.service`.
4. `systemctl enable --now kordi-cloud-server`.
5. `curl http://127.0.0.1:17081/health` and exit non-zero if it doesn't respond.

## TLS via Caddy

The cloud server speaks plain HTTP. Caddy on the VM should terminate TLS and
reverse-proxy the request. Steps:

1. Create a DNS A record for `kordi-cloud.<your-domain>` pointing at the VM's
   public IP. Caddy auto-provisions the Let's Encrypt cert from there.
2. Append the contents of `Caddyfile.snippet` to the VM's existing Caddyfile
   (likely `/etc/caddy/Caddyfile`), replacing `kordi-cloud.example.com` with
   your real domain.
3. `sudo systemctl reload caddy`.
4. `curl https://kordi-cloud.<your-domain>/health` — should return `{"ok":true,"server":"kordi-cloud"}`.

Until the domain is set up, you can test the cloud server by hitting it
directly on the VM's external IP at port 17081 (you'll need to allow that port
in the GCP firewall — by default it's blocked from outside).

## Repointing the desktop

The desktop's `VITE_KORDI_CLOUD_API_BASE` defaults to `http://127.0.0.1:17081`
(the local dev port). To talk to the deployed server:

```bash
VITE_KORDI_EDITION=cloud \
VITE_KORDI_CLOUD_API_BASE=https://kordi-cloud.<your-domain> \
pnpm --dir app/desktop tauri:dev
```

## Redeploy after a code change

Just re-run `sync-and-build.sh` from your laptop, then either:

```bash
# fast path: rebuild already-deployed binary; bounce the unit
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo systemctl restart kordi-cloud-server'
```

Or re-run `install.sh` if you also want it to re-confirm port ownership and
write the unit fresh.

## Tail logs

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo journalctl -u kordi-cloud-server -f --no-pager'
```

## Inspect the database

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo -u shu_yang sqlite3 /home/shu_yang/kordi-cloud-server-data/kordi-cloud.db .tables'
```

## Rollback

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c \
  --command 'sudo bash /home/shu_yang/kordi-cloud-server-deploy/bridges/cloud-server/deploy/uninstall.sh'
```

To also remove the database, add `--purge-data`. To restart the previous
auth-foundation preview after rolling back: that's manual — the install
script doesn't remember what was there.

## What's intentionally NOT in this deploy

- **No automatic firewall management.** The GCP firewall has to be configured
  outside this script. By default, port 17081 is only reachable from localhost
  on the VM, which is exactly what you want once Caddy fronts the service on
  443. If you want to expose 17081 directly, that's a separate `gcloud
  compute firewall-rules create` call.
- **No backup automation.** The user already has `bridges-db-backups` running
  for the local-first server. A parallel cron for the cloud DB is a follow-up.
- **No autoscaling / failover.** Single-VM deploy. Phase 3+ work.
