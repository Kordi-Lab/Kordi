# Cloud Edition

Cloud Edition is the hosted, account-based Kordi desktop mode. It keeps the existing desktop chat UI and local agent runtime, but routes account auth, contacts, direct messages, group sync, read receipts, and Cloud-group agent mentions through the hosted Cloud API instead of localhost Bridges.

## Runtime model

- **Cloud API host:** production defaults to `https://kordi.cloud`.
- **Desktop runtime:** agents still run on the target user's local desktop. Cloud transports and syncs messages; it does not execute local desktop agents.
- **UI reuse:** Cloud conversations are adapted into Bridge-shaped desktop state so the existing left chat rail, transcript, composer, read receipts, and group-session UI stay in use.
- **Local override:** development can point Cloud Edition at a local tunnel with `VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081`.

## Launching Cloud Edition locally

### Single instance

```bash
VITE_KORDI_EDITION=cloud \
KORDI_EDITION=cloud \
VITE_KORDI_CLOUD_API_BASE=https://kordi.cloud \
pnpm --dir app/desktop tauri:dev
```

### Three local Cloud test users through the hosted tunnel

```bash
KORDI_CLOUD_USE_LOCAL_TUNNEL=1 \
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2,user3
```

The launcher opens or reuses an SSH tunnel to `shu_yang@takotako` in `us-central1-c` and expects the VM to forward the k3s service on port `17082` to the local tunnel port `17081`.

Expected local dev URLs:

- user1: `http://127.0.0.1:1482/`
- user2: `http://127.0.0.1:1484/`
- user3: `http://127.0.0.1:1486/`

Health check:

```bash
curl http://127.0.0.1:17081/health
# {"ok":true,"server":"kordi-cloud"}
```

## Social login and Cloud profiles

Cloud Edition supports email/password plus OAuth sign-in for Google and GitHub. The desktop login page calls `/v1/cloud/auth/oauth/:provider/start` and opens the provider in the user's default browser. In the native desktop shell, Kordi uses a short-lived localhost loopback callback so the provider never renders inside the compact app webview; the browser callback hands the Cloud session back to the desktop app and then tells the user to return to Kordi. Browser preview builds still consume the OAuth fragment directly from the page URL.

Required server environment variables:

```bash
KORDI_CLOUD_PUBLIC_BASE_URL=https://kordi.cloud
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
# Optional comma-separated redirect targets for dev/custom shells.
KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST=http://127.0.0.1:,http://localhost:,tauri://
```

Register these callback URLs with the providers:

- `https://kordi.cloud/v1/cloud/auth/oauth/google/callback`
- `https://kordi.cloud/v1/cloud/auth/oauth/github/callback`

First OAuth login creates or links a Cloud account. Provider name/avatar initialize the Cloud profile when the account has no profile values yet. Users can edit display name and avatar from the bottom-left Cloud profile popover; profile updates persist through `PATCH /v1/cloud/auth/me` and then flow into Contacts, chat participants, and group avatar identity sync.

## Cloud contacts and direct chat

Cloud contacts are rendered as normal Bridge-shaped peers:

- human peer: `bridge:cloud:<account_id>:person`
- agent peer: `bridge:cloud:<account_id>`

Direct Cloud chat uses the hosted Cloud message API and maps server `delivered_at` / `read_at` into the existing desktop delivery chips.

## Cloud groups

Cloud groups reuse the existing group/session UI, but transport sync through hidden pairwise Cloud group controls with the `kordi-cloud-group:` prefix.

Control kinds:

- `group-invite`
- `group-update`
- `group-title-update`
- `group-message`

Important IDs:

- `groupId` is the concrete child session id.
- `groupSpaceId` is the shared group space id.

This separation prevents messages from different child sessions merging together while still keeping the UI grouped under one shared group header.

Cloud group members can exchange group messages even when they are not direct contacts. Direct 1:1 Cloud messages still require accepted contacts.

## Cloud group agent mentions

Cloud group mentions stay on Cloud group transport:

- `@MyKordi` / `@Kordi` runs the sender's local desktop agent and syncs the visible result through Cloud.
- `@<User>Kordi` runs the named user's local desktop agent and syncs the visible result through Cloud.
- The owner sees local runtime/tool state while the group receives the final synced response.

Do not route Cloud group agent mentions through local Bridge outreach; the sentinel host id `cloud` is an adapter id, not a localhost Bridge host.

## Avatars

Cloud profile avatars use stable generated avatar seeds when the server returns `kordi-pixel-avatar://...` URLs. The same account id / seed must render identically across all local instances.

For known local test accounts:

- `acct_00d7f9801c2e4c779a5c82260577434b` → `cloud-signup:f72367aa-6714-44cd-904e-964d29914b9d`
- `acct_50a66b83799045daa1cd0ee1632e7d2c` → `cloud-signup:916cca7f-5055-4088-9b3a-b50298e75f7a`
- `acct_bdb0419a13094ee7932948d6e12d4ad5` → `cloud-signup:4352ad49-a4dc-40f6-92b9-5259f1f93496`

Group avatar stacks sort human participants by stable Cloud identity/account key so every instance shows the same first three avatars.

## Backend deployment

The hosted Cloud API currently runs on `takotako` under k3s. The local dev tunnel is:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c -- \
  -N -L 127.0.0.1:17081:127.0.0.1:17082
```

The in-VM port-forward is:

```bash
kubectl -n kordi-cloud port-forward --address 127.0.0.1 \
  svc/kordi-cloud-server 17082:17081
```

Current known deployed image for group-control support:

```text
docker.io/library/kordi-cloud-server:dev-20260511-group-controls
```

See also [`bridges/cloud-server/deploy/k3s/README.md`](../bridges/cloud-server/deploy/k3s/README.md).

## Validation commands

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop exec tsx --test \
  tests/cloudGroupMessages.test.tsx \
  tests/cloudBridgeState.test.tsx \
  tests/cloudContactsAdapter.test.tsx \
  tests/mentions.test.tsx \
  tests/useKordiAppModelBridgeMentions.test.tsx
cargo check --manifest-path Cargo.toml -p kordi-cloud-server
```
