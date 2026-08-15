# Kordi

Kordi is the account-based desktop product on `main`. It routes auth, contacts, direct messages, groups, read state, sync, provider-auth snapshots, and hosted agent fallback through the hosted API.

Production API:

```text
https://kordi.ai
```

Testing should use an operator-provided public test hosted API base or a self-hosted compatible hosted server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Before a preview or debug session, select the path in [Development environment isolation](development-environments.md) and follow the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug). If the session can affect or require restarting the product server, develop and test on the corresponding product-server machine and validate the deployed product through `https://kordi.ai`, never through a local community/debug-server profile. Desktop-only remote operator previews use the same origin through the allowlisted launcher. Isolated testing cannot substitute for product-server validation.

## Runtime model

- **Hosted API:** product builds default to `https://kordi.ai`.
- **Hosted server:** owns accounts, contacts, direct/group messages, read state, sync events, provider-auth snapshots, update manifests, and runner coordination.
- **Hosted runner:** owns hosted fallback execution and sandboxed tool/model loops.
- **Desktop shell:** owns the native window, login/session restoration, local cached UI state, OAuth loopback handoff, and hosted API client integration.
- **Adapter naming:** some internal code still uses Bridge-shaped types while migration cleanup continues. These are compatibility adapters backed by hosted APIs, not the old local peer-to-peer transport.

## Launching Kordi Desktop

For a quick start, see [Run Kordi Desktop](run-cloud-desktop.md).

For an isolated loopback backend:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-isolated --title "Kordi Dev" --port 1422
```

For an explicitly approved test or self-hosted API, replace the API origin and use a separate named profile. Desktop-only production operator previews must use the allowlisted launcher documented in [Development environment isolation](development-environments.md#product-paths).

Community and staging profiles use the gray development icon. Product and allowlisted operator previews retain the color icon, with the choice derived from the validated environment profile rather than the window title.

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile approved-staging --title "Kordi Staging" --port 1422
```

For multiple local desktop users against a test/self-hosted API:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

## Social login and profiles

Kordi supports email/password plus OAuth sign-in for configured providers. The desktop login page calls `/v1/cloud/auth/oauth/:provider/start` and opens the provider in the user's default browser. In the native shell, Kordi uses a short-lived localhost loopback callback so the provider does not render inside the compact app webview; the browser callback hands the account session back to the desktop app.

Google and GitHub are stable login entry points in Kordi-controlled development and product environments. Capability discovery may confirm server configuration, but a delayed, empty, or failed capability request must not hide or disable either entry point. A provider-start failure is reported through the normal login error surface.

Required production server environment:

```bash
KORDI_CLOUD_PUBLIC_BASE_URL=https://kordi.ai
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST=http://127.0.0.1:,http://localhost:,https://kordi.ai,https://coordinar.io
```

For a test or self-hosted server, register callback URLs for that server's public HTTPS origin:

```text
<PUBLIC_TEST_CLOUD_API_BASE>/v1/cloud/auth/oauth/google/callback
<PUBLIC_TEST_CLOUD_API_BASE>/v1/cloud/auth/oauth/github/callback
```

## Contacts and person chats

Contacts are rendered in the existing chat UI. Person chats use the hosted message API and map server `delivered_at` / `read_at` into desktop delivery chips.

Every production account also receives a locked `Kordi Support` contact from
the hosted server. It is a distinct system-agent identity even when its owner
account is also present as a normal human contact. Users can chat with that
agent or submit a durable question, issue report, or feedback form from its
contact detail. Form notification credentials remain server-side; desktop
clients never receive SMTP or mailbox secrets.

## Groups

Groups reuse the chat/session UI while syncing through group controls with the `kordi-cloud-group:` prefix.

## Voice calls and video chats

Kordi uses the hosted API for call lifecycle, participant authorization, and
short-lived media credentials. LiveKit carries audio and video after the API
authorizes a participant. Direct calls use PushKit and CallKit for incoming
ringing, while group meetings use ordinary APNs alerts plus a durable Join card
in the conversation timeline.

Configure the LiveKit variables together. `KORDI_LIVEKIT_URL` must use `wss`,
except that an isolated development service may use `ws` on a loopback host.
The API key and secret remain on the server and are never sent to a client.

```bash
KORDI_LIVEKIT_URL=wss://<LIVEKIT_HOST>
KORDI_LIVEKIT_API_KEY=...
KORDI_LIVEKIT_API_SECRET=...
```

APNs delivery is optional and is enabled only when all of these variables are
present. Use developer-owned Apple credentials in isolated development.

```bash
KORDI_APNS_ENVIRONMENT=development
KORDI_APNS_KEY_ID=...
KORDI_APNS_TEAM_ID=...
KORDI_APNS_PRIVATE_KEY_BASE64=...
KORDI_APNS_BUNDLE_ID=...
```

The APNs key value is the base64 encoding of the private key file. Direct-call
VoIP tokens and ordinary notification tokens are registered separately so an
alert token is never used for a PushKit request.

Ordinary APNs tokens also receive message attention events after the message
transaction commits. Delivery excludes the sender, respects conversation mute
state, deduplicates each recipient and message pair, and carries only opaque
account, session, and message identifiers for in-app routing. Each iOS device
registers its own message, sound, preview, and badge preferences. macOS uses
the live synchronized conversation state to present a native local alert,
maintain the Dock badge, and focus the exact message when the alert is opened.
Both clients suppress an alert only while that same conversation is visible,
foregrounded, and positioned at the latest message.

Open-source implementation references:

- [LiveKit Swift CallKit example](https://github.com/livekit-examples/swift-example-collection/tree/main/callkit)
  for PushKit timing and CallKit-owned audio-session activation.
- [Element Call](https://github.com/element-hq/element-call) for keeping room
  lifecycle and authorization in the host messenger while LiveKit carries media.
- [Mattermost Calls](https://github.com/mattermost/mattermost-plugin-calls) for
  joinable calls attached to durable channel conversations.

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
