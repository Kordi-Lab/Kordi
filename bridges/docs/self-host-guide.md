# Bridges Server Setup Guide

This guide is for people who want to run their own Bridges server for Kordi on infrastructure they control.

Use it when you want to host Bridges on:

- your own **GCP / AWS / Azure / Hetzner / DigitalOcean VM**
- another always-on **cloud machine**
- a **lab machine** or team member's always-on computer for local-group collaboration
- a **private network** reached through Tailscale, WireGuard, or your company VPN

The goal is to end with one stable URL that Kordi Desktop can use, for example:

- `https://bridge.example.com`
- `https://bridge.lab.example.edu`
- `https://bridge.your-tailnet.ts.net`

> Important: Kordi Desktop accepts plain `http://` only for localhost development. If the server is on another machine, use `https://`.

## Quick links

- Want the private-team version first? Jump to [Practical lab / local-team setup](#9-practical-lab--local-team-setup).
- Want the public-cloud version first? Jump to [Practical GCP example](#8-practical-gcp-example).
- Need the fastest bootstrap path? Jump to [Linux-generic bootstrap script](#linux-generic-bootstrap-script).
- Need the reverse proxy config? Jump to [Put HTTPS in front with Caddy](#7-put-https-in-front-with-caddy).
- Prefer Nginx? Jump to [Nginx alternative config](#nginx-alternative-config).
- Running inside a tailnet? Jump to [Tailscale-specific `*.ts.net` setup](#tailscale-specific-tsnet-setup).
- Need the final app-side step? Jump to [What each collaborator does after the server exists](#10-what-each-collaborator-does-after-the-server-exists).

### Lab / private network quick path

If you are setting this up for a lab or an internal team, the shortest good path is:

1. pick one always-on Linux machine
2. give it a stable hostname
3. make it reachable through **Tailscale**, VPN, or internal DNS
4. run `bridges serve` as a systemd service
5. put **Caddy** in front of it for HTTPS
6. give teammates the final URL, such as:
   - `https://bridge.lab.example.edu`
   - `https://bridge.internal.example`
   - `https://bridge.your-tailnet.ts.net`

Avoid using a raw LAN URL such as `http://192.168.1.23:17080` as the final user-facing address.

---

## 1. What you are hosting

A Bridges deployment has two layers:

1. **Bridges coordination server**
   - project membership
   - contacts
   - discovery
   - key lookup
   - mailbox / relay fallback

2. **Each user's local runtime and desktop app**
   - Kordi Desktop runs on each collaborator's own machine
   - the packaged Kordi Desktop app already includes the local Bridges runtime/sidecar it needs
   - each person still uses their own local agents and local sessions

So the server is the shared meeting point, not the place where everyone's models must run.

---

## 2. Choose a deployment shape

### Option A — Public internet VM

Use this when collaborators are in different places.

Examples:
- GCP Compute Engine
- AWS EC2
- Azure VM
- Hetzner Cloud
- DigitalOcean Droplet
- any Ubuntu/Linux VPS

Recommended because:
- easiest to share with remote collaborators
- easiest to give a single HTTPS URL
- easiest to keep always-on

### Option B — Lab or team machine on a private network

Use this when the server is only for your lab, office, or local team.

Examples:
- an always-on workstation in the lab
- a small Linux box on the office network
- a server reachable through Tailscale or VPN

Recommended when:
- only local lab members need access
- you do not want to expose the server to the public internet
- you can provide a stable hostname and HTTPS inside the lab network

### Option C — Localhost development only

Use this only for personal testing.

Examples:
- `http://localhost:17080`
- `http://127.0.0.1:17080`

This is **not** the normal collaboration setup because other people cannot reach it.

---

## 3. Recommended production-style shape

For most real deployments, use this shape:

- Bridges server listens on `127.0.0.1:17080` or `0.0.0.0:17080` on the host machine
- Caddy or Nginx terminates HTTPS on port `443`
- public or private DNS points a hostname at that machine
- collaborators paste the final HTTPS URL into Kordi Desktop

Example:

```text
https://bridge.example.com  --->  Caddy / Nginx  --->  http://127.0.0.1:17080
```

This keeps the Bridges process simple and gives users a clean HTTPS URL.

---

## 4. Minimum server requirements

A small server is enough to start.

Recommended starter machine:

- 2 vCPU
- 2-4 GB RAM
- 20+ GB disk
- Ubuntu 22.04 or 24.04 LTS

Open these ports:

- `80` for ACME / initial HTTP
- `443` for HTTPS
- `17080` only if you are directly exposing Bridges without a reverse proxy

If you use Caddy or Nginx, you usually only need `80` and `443` open publicly.

### Linux-generic bootstrap script

If you want a faster setup path than doing each step manually, use one of these:

- `bridges/scripts/install-bridges-linux-generic.sh` — **Caddy** variant
- `bridges/scripts/install-bridges-linux-generic-nginx.sh` — **Nginx** variant

These scripts are **best-effort Linux-generic bootstraps** for common **systemd-based** VMs:

- Ubuntu / Debian
- Fedora / RHEL / Rocky / AlmaLinux
- Arch
- openSUSE

The Caddy variant will:

- install build dependencies
- install Rust with `rustup` if needed
- clone and build Bridges from source
- install the `bridges` binary
- install a Caddy binary
- write `bridges.service` and `caddy.service`
- write a Caddy config for your domain
- print distro-appropriate firewall hints
- start both services

Run it like this:

```bash
bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com
```

You can also pin a branch or tag:

```bash
bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com --repo-ref main
```

Preview what the installer would do without changing the machine:

```bash
bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com --dry-run
```

Reuse an already-installed Bridges binary instead of rebuilding:

```bash
bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com --skip-build
```

If you prefer Nginx instead of Caddy:

```bash
bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
  --domain bridge.example.com \
  --email admin@example.com
```

Nginx supports the same preview/build-skip flags:

```bash
bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
  --domain bridge.example.com \
  --email admin@example.com \
  --dry-run

bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
  --domain bridge.example.com \
  --email admin@example.com \
  --skip-build
```

If you already have certificates and only want the Nginx/bootstrap part:

```bash
bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
  --domain bridge.example.com \
  --skip-cert
```

Notes:

- these scripts expect a **systemd-based VM**
- they are not the right path for Alpine or non-systemd environments
- you still need DNS for your final hostname
- you still need ports `80` and `443` open in your cloud or VM firewall
- the Nginx variant requires a real email address for Let's Encrypt unless you use `--skip-cert`
- `--skip-cert` leaves the machine on the HTTP bootstrap config unless matching cert files already exist

If you prefer the manual path, continue below.

---

## 5. Build and install Bridges on the server

SSH into the machine, then use the Kordi monorepo checkout as the source tree. Bridges is no longer documented as a separate standalone repo for this flow.

```bash
git clone https://github.com/Kordi-AI/Kordi.git kordi
cd kordi
cargo build --release --manifest-path bridges/cli/Cargo.toml
```

If you already have a local `kordi/` checkout, reuse it instead of cloning again.

The binary will be at:

```bash
./target/release/bridges
```

Create a place for persistent data:

```bash
sudo mkdir -p /opt/bridges/data
sudo cp ./target/release/bridges /usr/local/bin/bridges
sudo chmod +x /usr/local/bin/bridges
```

Quick manual test:

```bash
bridges serve --port 17080 --db /opt/bridges/data/bridges-server.db
```

In another shell:

```bash
curl http://127.0.0.1:17080/health
# expected: {"ok":true}
```

If that works, stop it and continue with a service.

---

## 6. Run Bridges as a system service

Create `/etc/systemd/system/bridges.service`:

```ini
[Unit]
Description=Bridges coordination server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bridges
ExecStart=/usr/local/bin/bridges serve --port 17080 --db /opt/bridges/data/bridges-server.db
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bridges
sudo systemctl status bridges
```

Check logs:

```bash
sudo journalctl -u bridges -f
```

Verify local health again:

```bash
curl http://127.0.0.1:17080/health
```

---

## 7. Put HTTPS in front with Caddy

Caddy is the easiest path for most users because it handles TLS automatically.

### Install Caddy

On Ubuntu:

```bash
sudo apt update
sudo apt install -y caddy
```

### Configure a hostname

Point your DNS record at the server first.

Examples:
- `bridge.example.com`
- `bridge.lab.example.edu`
- `bridge.your-tailnet.ts.net`

Then create `/etc/caddy/Caddyfile`.

### Copyable Caddy config for a real domain

Use this when you have a real hostname such as `bridge.example.com`:

```caddy
bridge.example.com {
  encode zstd gzip

  reverse_proxy 127.0.0.1:17080 {
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-For {remote_host}
  }

  log {
    output file /var/log/caddy/bridge-access.log
    format console
  }
}
```

If you are hosting for a lab or private network with a different hostname, replace only the top line:

```caddy
bridge.lab.example.edu {
  encode zstd gzip
  reverse_proxy 127.0.0.1:17080
}
```

Useful commands:

```bash
sudo mkdir -p /var/log/caddy
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

Now verify externally:

```bash
curl https://bridge.example.com/health
# expected: {"ok":true}
```

At this point, the URL you paste into Kordi Desktop is:

```text
https://bridge.example.com
```

### Nginx alternative config

If you prefer Nginx instead of Caddy, this is the equivalent reverse proxy shape.

You can either configure it manually using the example below, or use the companion script:

```bash
bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
  --domain bridge.example.com \
  --email admin@example.com
```

Example server block:

```nginx
server {
    listen 80;
    server_name bridge.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name bridge.example.com;

    ssl_certificate /etc/letsencrypt/live/bridge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:17080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Typical commands:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nginx -t
sudo systemctl enable --now nginx
sudo certbot --nginx -d bridge.example.com
curl https://bridge.example.com/health
```

Use Nginx when:

- your team already standardizes on Nginx
- you already have certbot / Let's Encrypt automation in place
- you want Bridges to fit into an existing reverse-proxy stack

---

## 8. Practical GCP example

If you want a concrete cloud path, GCP works well.

### GCP console checklist

In the GCP web console, the flow is usually:

1. **Compute Engine → VM instances → Create instance**
2. choose:
   - machine type: `e2-standard-2` or similar
   - boot disk: Ubuntu LTS
   - external IP: static if possible
3. under **Firewall**, allow:
   - **Allow HTTP traffic**
   - **Allow HTTPS traffic**
4. create the VM
5. SSH into it from the console or your local terminal
6. deploy Bridges and Caddy using sections 5, 6, and 7 above

### GCP CLI-style checklist

If you prefer commands, the rough shape is:

```bash
gcloud compute instances create bridges-server \
  --zone=us-central1-a \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --tags=http-server,https-server
```

Reserve a static IP if you want a stable DNS target:

```bash
gcloud compute addresses create bridges-ip --region=us-central1
gcloud compute addresses list
```

Then attach that IP to the VM from the console, or recreate/update the instance to use it.

### Firewall checklist

In the console, check:

- **VPC network → Firewall**
- confirm rules exist for:
  - TCP `80`
  - TCP `443`
- confirm they target the VM by network tag or instance scope

You do **not** need to publicly expose `17080` if Caddy is on the same machine.

If you need explicit rules, the command shape is:

```bash
gcloud compute firewall-rules create allow-bridges-http \
  --allow tcp:80 \
  --target-tags=http-server

gcloud compute firewall-rules create allow-bridges-https \
  --allow tcp:443 \
  --target-tags=https-server
```

### DNS checklist

Once the VM has a stable external IP:

1. go to your DNS provider
2. create an **A record**
3. use a name such as:
   - `bridge.example.com`
   - `bridge.team.example.com`
4. point it at the VM's static external IP

Example:

```text
Type: A
Name: bridge
Value: 34.123.45.67
TTL: 300
```

Then verify from your terminal:

```bash
dig +short bridge.example.com
curl http://bridge.example.com/health
```

The first `curl` may fail before Caddy is configured. After section 7 is complete, verify with:

```bash
curl https://bridge.example.com/health
# expected: {"ok":true}
```

### Final GCP sanity check

Before giving the URL to teammates, make sure all of these are true:

- `sudo systemctl status bridges` is healthy
- `sudo systemctl status caddy` is healthy
- `curl http://127.0.0.1:17080/health` works on the server
- `curl https://bridge.example.com/health` works from another machine
- the final user-facing URL is HTTPS, not raw IP + port

That gives you a stable hosted Bridges server for your team.

---

## 9. Practical lab / local-team setup

If this is only for lab members or teammates on the same internal network, the easiest safe pattern is:

### Good pattern

- choose one always-on machine in the lab
- give it a stable name or static IP
- put it behind **Tailscale**, your company VPN, or internal DNS
- still expose Bridges to users as an **HTTPS URL**

Examples:
- `https://bridge.lab.example.edu`
- `https://bridge.internal.example`
- `https://bridge.your-tailnet.ts.net`

### Why this matters

Kordi Desktop expects a real remote server URL, and remote URLs should use HTTPS.

So even on a private lab network, do **not** build the user flow around:

```text
http://192.168.1.23:17080
```

That may work for raw testing, but it is not the right finished setup for the app.

### Best private-network options

#### Option 1: Tailscale + MagicDNS

This is one of the easiest private setups.

- install Tailscale on the server machine
- install Tailscale on each collaborator machine
- use the server's Tailscale hostname
- terminate HTTPS with Caddy on that host

You end up with a clean internal URL such as:

```text
https://bridge.your-tailnet.ts.net
```

### Tailscale-specific `*.ts.net` setup

If you want the server to live entirely inside your tailnet, this is the practical path.

1. Install Tailscale on the server:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up
```

2. In the Tailscale admin panel, enable **MagicDNS** if it is not already enabled.

3. Find or choose the machine's MagicDNS name, for example:

```text
bridge-host.your-tailnet.ts.net
```

4. Generate a certificate for that hostname on the server:

```bash
sudo mkdir -p /etc/ssl/tailscale
sudo tailscale cert \
  --cert-file /etc/ssl/tailscale/bridge.crt \
  --key-file /etc/ssl/tailscale/bridge.key \
  bridge-host.your-tailnet.ts.net
```

5. Use that certificate from Caddy:

```caddy
bridge-host.your-tailnet.ts.net {
  tls /etc/ssl/tailscale/bridge.crt /etc/ssl/tailscale/bridge.key
  reverse_proxy 127.0.0.1:17080
}
```

6. Reload Caddy:

```bash
sudo systemctl reload caddy
curl https://bridge-host.your-tailnet.ts.net/health
```

7. Give teammates this final URL:

```text
https://bridge-host.your-tailnet.ts.net
```

Notes:

- every collaborator machine must also be connected to the same tailnet
- `tailscale cert` certificates need renewal; rerun it when rotating or renewing certificates
- if you want the simplest automatic HTTPS story, a normal public DNS hostname is still easier than `*.ts.net`

#### Option 2: Internal DNS + trusted TLS

If your lab or company has internal DNS and certificate tooling:

- create an internal hostname
- terminate TLS with Caddy or Nginx
- make sure client machines trust the issuing CA

#### Option 3: Public DNS, private team access policy

You can also expose the service publicly with HTTPS but only share the URL with your team.

That is often simpler than managing private PKI.

---

## 10. What each collaborator does after the server exists

Once the server is live, every collaborator can use the same Bridges host URL in Kordi Desktop.

For Kordi Desktop users, there is no separate Bridges CLI / daemon / skill install step just to connect to the hosted server. The desktop app already bundles the local bridge tooling it needs.

They only need the final URL, for example:

```text
https://bridge.example.com
```

Inside the app:

1. open **Bridge**
2. choose **I have a bridge host URL**
3. paste the hosted URL
4. save / join

After that, Kordi Desktop will manage the desktop-side bridge host state, identity, discovery, contacts, and conversations. Manual `bridges setup` on the client is only optional for debugging or non-desktop runtime workflows.

---

## 11. Optional CLI validation on a client machine

If you want to validate the server outside the desktop app, you can also test with the Bridges CLI.

Build locally:

```bash
git clone https://github.com/Kordi-AI/Kordi.git kordi
cd kordi
cargo build --release --manifest-path bridges/cli/Cargo.toml
```

Then run:

```bash
./target/release/bridges setup --coordination https://bridge.example.com --name "Alice"
./target/release/bridges status
./target/release/bridges service status
```

This is optional for Kordi Desktop users, but useful for debugging.

---

## 12. Troubleshooting

### `curl https://.../health` fails

Check:
- DNS points to the correct machine
- ports 80 and 443 are open
- Caddy or Nginx is running
- Bridges service is running behind the proxy

Useful commands:

```bash
sudo systemctl status bridges
sudo journalctl -u bridges -f
sudo systemctl status caddy
sudo journalctl -u caddy -f
curl http://127.0.0.1:17080/health
curl https://bridge.example.com/health
```

### Kordi Desktop rejects the URL

Common reason:
- using `http://` on a non-localhost machine

Fix:
- switch to an HTTPS URL such as `https://bridge.example.com`

### Lab members can reach the machine but HTTPS is broken

Check:
- the hostname in the URL matches the certificate
- clients trust the issuing CA if you use internal certificates
- if using Tailscale or VPN, use the correct hostname instead of a raw IP

### Server works locally but not remotely

Check:
- cloud firewall rules
- OS firewall rules
- reverse proxy configuration
- whether the DNS record has propagated

---

## 13. Recommended next step after server setup

After your server is reachable over HTTPS:

- connect it in Kordi Desktop
- set your bridge identity
- choose discovery mode
- add teammates as contacts or invite them into shared projects

---

## 14. Related docs

For architecture and lower-level details, also read:

- [addressing-model.md](addressing-model.md)
- [test-guide.md](test-guide.md)
- [README.md](README.md)
