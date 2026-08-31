# Hosting Kordi voice and video calls

Use this guide whenever an isolated development host or product host is created,
replaced, rebuilt, or redeployed. A healthy Cloud API does not prove that calls
work. Calling is ready only after the API, LiveKit signaling, WebRTC transport,
and a two-account media test all pass.

Never copy call credentials between development and product. Keep real project,
zone, instance, IP, account, and credential values out of commits and shared
logs.

## The required contract

Kordi splits a call across four layers:

| Layer | Responsibility | Required proof |
| --- | --- | --- |
| Cloud API | Call lifecycle, authorization, revisions, and short-lived room tokens | Server log says `Kordi call media is configured` |
| LiveKit signaling | Room connection over WebSocket | Both clients connect to the issued media URL |
| WebRTC transport | Audio and video over ICE/TCP, ICE/UDP, or TURN | Both clients publish and subscribe |
| Kordi clients | Permissions, ringing UI, media rendering, and terminal state | Two accounts complete and end a real call |

The Cloud API reads these variables once at startup. Configure all three or
none; a partial configuration makes startup fail.

```text
KORDI_LIVEKIT_URL
KORDI_LIVEKIT_API_KEY
KORDI_LIVEKIT_API_SECRET
```

The API key and secret must exactly match the `key: secret` entry loaded by
LiveKit. Rotate and restart both services together. The URL is returned to
clients, so it must be reachable from the client. Never use a Kubernetes
Service name, Docker service name, or remote loopback port that only the server
can reach.

Allowed URL forms are:

- product: `wss://` on the public TLS origin;
- isolated development: `ws://` on `localhost` or another loopback address.

If the variables are absent, call creation returns
`CALL_MEDIA_UNAVAILABLE` with “Calling is not configured for this Kordi
environment.”

## Isolated development host

This path is for a private Linux development host reached through an approved
IAP-style SSH tunnel. It uses separate development credentials and no product
data or services. The base `deploy/dev/compose.yaml` stack does not start
LiveKit by itself.

### 1. Create development-only credentials

Start the isolated stack once so the ignored `deploy/dev/.env` exists:

```bash
pnpm debug:cloud:up
```

On a new development host, add a fresh key pair without printing it. Do not run
this block when the file already contains `KORDI_LIVEKIT_` entries; edit the
existing entries instead of appending duplicates.

```bash
if grep -q '^KORDI_LIVEKIT_' deploy/dev/.env; then
  echo "Call media entries already exist; do not append another set."
else
  umask 077
  dev_livekit_key="$(openssl rand -hex 16)"
  dev_livekit_secret="$(openssl rand -hex 32)"
  {
    printf 'KORDI_LIVEKIT_URL=ws://127.0.0.1:17880\n'
    printf 'KORDI_LIVEKIT_API_KEY=%s\n' "$dev_livekit_key"
    printf 'KORDI_LIVEKIT_API_SECRET=%s\n' "$dev_livekit_secret"
  } >> deploy/dev/.env
  unset dev_livekit_key dev_livekit_secret
  chmod 600 deploy/dev/.env
fi
```

`17880` is the signaling port on the developer's Mac after tunneling. It is
deliberately different from LiveKit's remote port `7880`.

For a fully local backend and local LiveKit process, use
`ws://127.0.0.1:7880` instead and omit the media tunnel.

### 2. Run LiveKit on the development host

Create a host-local configuration outside the repository:

```bash
install -d -m 700 "$HOME/.config/kordi-dev"
cat > "$HOME/.config/kordi-dev/livekit.yaml" <<'YAML'
port: 7880
rtc:
  tcp_port: 17881
  force_tcp: true
  use_external_ip: false
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
logging:
  level: info
YAML
chmod 600 "$HOME/.config/kordi-dev/livekit.yaml"
```

Load the ignored environment file, then run the pinned LiveKit image with host
networking. Host networking is required here because forwarding an ICE/TCP
candidate through Docker's bridge can accept the socket while never completing
the peer connection.

```bash
set -a
. deploy/dev/.env
set +a

test -n "$KORDI_LIVEKIT_API_KEY"
test -n "$KORDI_LIVEKIT_API_SECRET"

docker rm -f kordi-dev-livekit 2>/dev/null || true
docker run --detach \
  --name kordi-dev-livekit \
  --restart unless-stopped \
  --network host \
  --env "LIVEKIT_KEYS=$KORDI_LIVEKIT_API_KEY: $KORDI_LIVEKIT_API_SECRET" \
  --volume "$HOME/.config/kordi-dev/livekit.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:v1.12.0 \
  --config /etc/livekit.yaml \
  --bind 127.0.0.1
```

The `--bind` flag keeps signaling on remote loopback. LiveKit's ICE/TCP
listener may still bind to all host interfaces, so the development host's
cloud firewall must deny public TCP `17881`. Do not add a public ingress rule
for the development media ports.

Restart the isolated API so it reads the three variables:

```bash
pnpm debug:cloud:up

docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml logs --tail=200 cloud-server \
  | grep -F 'Kordi call media is configured'
```

Do not continue if the log says calling is disabled or the expected configured
line is absent.

### 3. Open one explicit IAP tunnel

On the developer's Mac, first check that the local ports are free. A stale
tunnel can silently point every client at the wrong backend.

```bash
lsof -nP -iTCP:17081 -sTCP:LISTEN
lsof -nP -iTCP:17880 -sTCP:LISTEN
lsof -nP -iTCP:17881 -sTCP:LISTEN
```

Stop a stale listener only after confirming its process and target. Then open
the API, signaling, and ICE/TCP forwards with every target value explicit:

```bash
gcloud compute ssh "<DEV_GCE_INSTANCE>" \
  --project "<DEV_GCP_PROJECT>" \
  --zone "<DEV_GCP_ZONE>" \
  --tunnel-through-iap -- \
  -N \
  -L 127.0.0.1:17081:127.0.0.1:17081 \
  -L 127.0.0.1:17880:127.0.0.1:7880 \
  -L 127.0.0.1:17881:127.0.0.1:17881 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3
```

IAP SSH forwarding is TCP-only, which is why this isolated configuration forces
ICE/TCP. Keep the tunnel open for the entire test.

Verify all three local endpoints before launching a client:

```bash
curl --fail --silent --show-error http://127.0.0.1:17081/health
nc -z 127.0.0.1 17880
nc -z 127.0.0.1 17881
```

Also inspect the port owner locally and confirm its command names the intended
development target, project, and zone. Do not share the resulting command line.

### 4. Launch development clients

Desktop instances must use the explicit loopback API and isolated profile:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-calls-a --title "Kordi Calls A" --port 1482
```

Use a different profile, identifier, data directory, and port for the second
desktop account. Native simulator testing must use the `Kordi Beta` scheme;
the production iOS identity must never point at development.

After changing the backend or reseeding accounts, restart every client. A
session issued by another backend correctly fails with “Session is expired or
revoked.”

## Product host

The product path uses the reviewed k3s deployment, public TLS signaling,
host-networked LiveKit, UDP-first media, ICE/TCP fallback, and TURN/UDP. Do not
adapt the isolated IAP configuration for product.

### 1. Create the product media secret

Generate a dedicated product key and a secret of at least 32 random bytes in a
trusted operator shell. Store the public client URL and the same key pair used
by LiveKit without printing either credential:

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

The checked-in Cloud server deployment reads `url`, `api-key`, and
`api-secret`; the LiveKit deployment reads `keys`. Never rotate only one side.

### 2. Install the reviewed edge and firewall

Use these files without inventing a second media topology:

- `bridges/cloud-server/deploy/k3s/manifests/livekit.yaml`
- `bridges/cloud-server/deploy/Caddyfile.snippet`
- `bridges/cloud-server/deploy/k3s/configure-product-firewall.sh`

The product media manifest requires `hostNetwork: true`. Caddy terminates TLS
and sends `/rtc` to LiveKit signaling on host loopback. The instance-scoped
firewall permits only the reviewed product media ports:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `443` | TCP | TLS and LiveKit WebSocket signaling through Caddy |
| `7881` | TCP | ICE/TCP fallback |
| `7882` | UDP | ICE/UDP mux |
| `3478` | UDP | TURN/UDP |
| `30000-30100` | UDP | TURN relay range |

Postgres, Redis, NATS, MinIO, the Cloud API, and the Kubernetes NodePort must
remain private. See LiveKit's official [ports and firewall
reference](https://docs.livekit.io/transport/self-hosting/ports-firewall/) and
[deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/)
for the underlying transport requirements.

Run the product firewall helper and deployment helpers only with the authorized
target, project, and zone explicitly set. The Cloud deploy checks that every
`kordi-livekit` secret field exists before reconciling LiveKit.

```bash
bash bridges/cloud-server/deploy/k3s/configure-product-firewall.sh
bash bridges/cloud-server/deploy/sync-and-build.sh
bash bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

### 3. Verify product call readiness

Run these checks on the authorized product host without decoding or printing
secrets:

```bash
for key in url api-key api-secret keys; do
  test -n "$(kubectl -n kordi-cloud get secret kordi-livekit \
    -o "jsonpath={.data.$key}")"
done

kubectl -n kordi-cloud rollout status deployment/livekit --timeout=180s
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s

kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m \
  | grep -F 'Kordi call media is configured'

curl --fail --silent --show-error https://kordi.ai/health
sudo ss -lntup | grep -E ':(7880|7881|7882|3478)\\b'
```

Verify that Caddy's `/rtc` handler appears before the catch-all handler and
that the public firewall has the reviewed media rule. Do not treat a running
pod, a passing readiness probe, or `/health` alone as proof that clients can
exchange media.

### 4. Configure iOS background ringing separately

Foreground calls can work without APNs. Incoming calls while iOS is
backgrounded require all five APNs variables on the Cloud server:

```text
KORDI_APNS_ENVIRONMENT
KORDI_APNS_KEY_ID
KORDI_APNS_TEAM_ID
KORDI_APNS_PRIVATE_KEY_BASE64
KORDI_APNS_BUNDLE_ID
```

Use `production` and the production bundle identity on product. Use separate
developer-owned Apple credentials and `development` in isolation. The server
must log `Kordi Apple notifications are configured`; otherwise test only
foreground ringing and do not report background calling as ready. See
[`cloud-edition.md`](cloud-edition.md#voice-calls-and-video-chats) for the APNs
contract.

The product manifest reads these values from the optional `kordi-apns` Secret.
Create it before deployment from a trusted operator shell. The `.p8` file stays
local and its encoded value is never printed:

```bash
read -r -p "APNs environment: " KORDI_APNS_ENVIRONMENT
read -r -p "APNs key ID: " KORDI_APNS_KEY_ID
read -r -p "Apple team ID: " KORDI_APNS_TEAM_ID
read -r -p "Product bundle ID: " KORDI_APNS_BUNDLE_ID
read -r -p "Path to APNs .p8 key: " KORDI_APNS_KEY_FILE
KORDI_APNS_PRIVATE_KEY_BASE64="$(base64 < "$KORDI_APNS_KEY_FILE" | tr -d '\n')"

kubectl -n kordi-cloud create secret generic kordi-apns \
  --from-literal=KORDI_APNS_ENVIRONMENT="$KORDI_APNS_ENVIRONMENT" \
  --from-literal=KORDI_APNS_KEY_ID="$KORDI_APNS_KEY_ID" \
  --from-literal=KORDI_APNS_TEAM_ID="$KORDI_APNS_TEAM_ID" \
  --from-literal=KORDI_APNS_PRIVATE_KEY_BASE64="$KORDI_APNS_PRIVATE_KEY_BASE64" \
  --from-literal=KORDI_APNS_BUNDLE_ID="$KORDI_APNS_BUNDLE_ID" \
  --dry-run=client -o yaml | kubectl apply -f -

unset KORDI_APNS_ENVIRONMENT KORDI_APNS_KEY_ID KORDI_APNS_TEAM_ID
unset KORDI_APNS_PRIVATE_KEY_BASE64 KORDI_APNS_BUNDLE_ID KORDI_APNS_KEY_FILE
```

Apply the Cloud server deployment after creating or rotating this Secret, then
verify the configured Apple-notifications startup log.

## Required two-account acceptance test

Complete this test after every new host, firewall change, Caddy change,
LiveKit change, credential rotation, Cloud API deploy, or call-client change:

1. Sign in as two disposable accepted contacts on separate client profiles.
2. Start a voice call from account A and answer on account B.
3. Confirm both sides hear remote audio, then end the call.
4. Start a video call and answer it.
5. Confirm both clients publish camera and microphone tracks.
6. Confirm each client subscribes to remote video and renders a first frame.
7. End the call from one side and confirm both clients leave the call UI.
8. Confirm a delayed join is rejected and neither account reports an active
   call.
9. For product iOS background support, repeat with the receiver locked or in
   the background and answer through CallKit.

Record only pass/fail stages and redacted error codes. Never attach room tokens,
session tokens, LiveKit credentials, private host commands, or unredacted logs.

## Failure guide

| Symptom | Most likely cause | Check |
| --- | --- | --- |
| “Calling is not configured” | Client reached an API that started without all three LiveKit variables | Confirm tunnel target and the server's configured startup log |
| “Session is expired or revoked” | Client retained a session from another backend | Restart or sign in again on the selected backend |
| Call starts, then signaling fails | `KORDI_LIVEKIT_URL` is not reachable by the client, or `/rtc` is not proxied | Check the issued client URL, tunnel, TLS, and Caddy route |
| Signaling connects, then ICE or TURN times out | RTC ports, candidates, Docker networking, or firewall are wrong | Check host networking, listeners, tunnel or product media ports |
| Ringing never reaches a foreground peer | Realtime event delivery or the peer session is stale | Check the durable chat WebSocket and restart both clients |
| Ringing never reaches background iOS | APNs/PushKit is absent or uses the wrong environment or bundle | Check all five APNs variables and the server startup log |
| Audio works but video stays blank | Camera publication, remote subscription, or first-frame rendering failed | Check client camera permission and staged call diagnostics |
| Ended call remains visible | Client or server is older than the call revision/tombstone fix | Deploy the same current revision everywhere and rerun the full test |

The deployment is complete only when the two-account acceptance test passes.
