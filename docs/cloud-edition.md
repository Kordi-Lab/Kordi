# Kordi

Kordi is the account-based desktop product on `main`. It routes auth, contacts, direct messages, groups, read state, sync, provider-auth snapshots, and hosted agent fallback through the hosted API.

Production API:

```text
https://coordinar.io
```

Testing should use an operator-provided public test hosted API base or a self-hosted compatible hosted server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

## Runtime model

- **Hosted API:** product builds default to `https://coordinar.io`.
- **Hosted server:** owns accounts, contacts, direct/group messages, read state, sync events, provider-auth snapshots, update manifests, and runner coordination.
- **Hosted runner:** owns hosted fallback execution and sandboxed tool/model loops.
- **Desktop shell:** owns the native window, login/session restoration, local cached UI state, OAuth loopback handoff, and hosted API client integration.
- **Adapter naming:** some internal code still uses Bridge-shaped types while migration cleanup continues. These are compatibility adapters backed by hosted APIs, not the old local peer-to-peer transport.

## Launching Kordi Desktop

For a quick start, see [Run Kordi Desktop](run-cloud-desktop.md).

```bash
pnpm dev
```

For test or self-hosted APIs:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

For multiple local desktop users against a test/self-hosted API:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

## Social login and profiles

Kordi supports email/password plus OAuth sign-in for configured providers. The desktop login page calls `/v1/cloud/auth/oauth/:provider/start` and opens the provider in the user's default browser. In the native shell, Kordi uses a short-lived localhost loopback callback so the provider does not render inside the compact app webview; the browser callback hands the account session back to the desktop app.

Required production server environment:

```bash
KORDI_CLOUD_PUBLIC_BASE_URL=https://coordinar.io
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST=http://127.0.0.1:,http://localhost:,https://coordinar.io
```

For a test or self-hosted server, register callback URLs for that server's public HTTPS origin:

```text
<PUBLIC_TEST_CLOUD_API_BASE>/v1/cloud/auth/oauth/google/callback
<PUBLIC_TEST_CLOUD_API_BASE>/v1/cloud/auth/oauth/github/callback
```

## Contacts and person chats

Contacts are rendered in the existing chat UI. Person chats use the hosted message API and map server `delivered_at` / `read_at` into desktop delivery chips.

## Groups

Groups reuse the chat/session UI while syncing through group controls with the `kordi-cloud-group:` prefix.

Control kinds:

- `group-invite`
- `group-update`
- `group-title-update`
- `group-message`

Important IDs:

- `groupId` is the concrete child session id.
- `groupSpaceId` is the shared group space id.

Group members can exchange group messages even when they are not direct contacts. Direct 1:1 messages still require accepted contacts.

## Group agent mentions

Group mentions stay on hosted transport:

- `@MyKordi` / `@Kordi` targets the sender's agent route.
- `@<User>Kordi` targets the named user's agent route.
- Hosted fallback can process work through the hosted runner/sandbox when applicable.
- The group receives the final synced response in the conversation.

Do not route group agent mentions through old local Bridge outreach.

## Avatars

Profile avatars use stable generated avatar seeds when the server returns `kordi-pixel-avatar://...` URLs. The same account id / seed must render consistently across instances.

Group avatar stacks sort human participants by stable account key so each instance shows the same first three avatars.

## Validation commands

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop exec tsx --test \
  tests/cloudEdition.test.tsx \
  tests/cloudSurfaceCleanup.test.ts \
  tests/cloudNoLegacyBridgeTransport.test.ts \
  tests/cloudGroupMessages.test.tsx \
  tests/cloudBridgeState.test.tsx
cargo check -p kordi-cloud-server
```
