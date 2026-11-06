# Kordi browser application implementation plan

## Objective and scope

Deliver the current Kordi application in a browser at `/app`, using the existing
React page composition and hosted services. Browser and desktop users must share
accounts, conversations, messages, attachments, organizations, and hosted agents.
The first delivery is browser parity for existing hosted capabilities. New Slack
or Discord product concepts are separate features, not implied by this port.

Baseline: current `origin/main` at implementation start. The older desktop
checkout is not the baseline. Main already has web cookie authentication,
organization admission, hosted chat APIs, LiveKit calling, document collaboration,
and account-page serving; reuse those contracts rather than rebuilding them.

This is a delivery plan, not a claim that every listed flow has passed acceptance.
See the validation record at the end for actual evidence and remaining work.

## Complete page inventory

| Surface | Browser behavior | Acceptance |
| --- | --- | --- |
| Sign-in and account creation | Existing email and Google/GitHub entry points; cookie session restoration; verification/admission errors; safe return to the requested conversation | Reload retains sign-in; invalid session returns to sign-in without a redirect loop; OAuth never places a session token in a URL |
| Organization selection | Reuse membership and admission flow; switch organization through the existing server contract | A switch clears the old organization's conversation projection and never exposes another organization's history |
| Application shell | Current brand, Classic default, navigation order, search, profile menu, header actions, sidebar and detail panes | Compare the complete rendered page with the current app; no substitute navigation from fixtures |
| Contacts | Existing people, contact requests, groups, profiles and common-ground controls | Open a profile, start a real chat, and follow an invitation without native calls |
| Chats | Existing lists, projects/channels where available, unread indicators, message search, conversation selection and creation | Two accounts can create/open a chat, send, receive, mark read, refresh and recover history |
| Conversation messages | Existing virtual transcript, composer, mentions, replies, threads, reactions, edits/deletion, forwards, pins and selection controls | Delivery is authoritative; retry and reconnect do not duplicate messages; older history uses bounded cursors |
| Conversation destinations | Preserve Messages, Info, Artifacts, Tasks and Memory according to existing capability rules | Every visible tab opens its real content; unavailable services produce a clear existing error or capability state |
| Conversation header | Preserve context-specific voice/video, Chat, Digest and Calendar actions and session menus | Each action opens the corresponding real destination; no decorative replacements |
| Attachments and artifacts | File picker, drag/drop, pasted files, upload progress, authenticated preview, download and editor where supported | A second account can open the uploaded file; object URLs are released; local desktop paths are not required |
| Agent Chats | Existing personal and shared agent sessions, streaming output, stop/retry and history | Hosted execution continues independently of the tab; reconnect reconciles the final result |
| Factory | Current agent list, editor, configuration and hosted execution routes | Create/edit an agent through real APIs; native-only execution settings explain the required desktop capability |
| Digest and calendar | Existing personal/shared destinations and permissions | Fetch current server data; show loading, empty, denied and retry states |
| Account/settings | Current profile, appearance, account/security, organizations, devices and provider settings | Settings persist under the correct account; sign-out invalidates the cookie and clears account caches |
| Calls | Reuse hosted call signaling and browser media implementation | Permission denial, no-device, join/leave and reconnect checked with configured development media services |
| Documents | Reuse the existing editor and collaboration transport | Authorized peers can edit; revoked sharing stops access; reconnect preserves authoritative content |
| Help and legal | Preserve current help and license destinations | Browser URLs resolve under the application base; no native-only window dependency |

## Navigation and responsive behavior

The real primary navigation is Contacts, Chats, Agent Chats, Factory and Digest.
Settings remains in the account menu. Preserve current organization/project
context rather than inventing a server rail or a separate channel taxonomy.

| URL | Destination |
| --- | --- |
| `/app` | Default Agent Chats destination, matching the current app |
| `/app/contacts` | Contacts |
| `/app/chats` | Chat list / current chat |
| `/app/chats/:conversationId` | Selected human/group conversation |
| `/app/agent-chats` | Agent conversation list |
| `/app/agent-chats/:conversationId` | Selected agent conversation |
| `/app/factory` | Factory |
| `/app/digest` | Digest |

IDs are URL-encoded opaque values, not filesystem paths. Direct loading, refresh,
Back/Forward, invitation parameters and delayed conversation hydration must work.
An inaccessible or removed conversation must not silently open a different chat.
Do not add browser history entries for every sync/render update.

- Wide screens: full viewport, complete sidebar, current main pane, optional
  detail/companion pane and existing resizable layout.
- Narrow screens: accessible navigation toggle and focused content; detail panels
  fit the available viewport rather than forcing horizontal document scrolling.
- Touch and keyboard: visible focus, Escape dismissal, usable targets, correct
  scroll ownership and preserved composer focus.
- Preserve user-selected themes; new sessions use Classic. Native titlebar drag,
  window resize and updater operations remain native capabilities.

## Architecture and boundaries

1. Keep one React product interface. Add an explicit `web` Vite build target
   (`VITE_KORDI_WEB_APP=1`) instead of treating every existing browser fixture as
   the shipping web app. Native and existing preview behavior remain distinguishable.
2. Serve the browser build at `/app/` on the API origin. Host-only cookies require
   this topology. Keep `/v1` and `/v2` outside the SPA fallback.
3. Reuse web-session endpoints. No bearer or refresh tokens in localStorage,
   IndexedDB, browser URLs, or page scripts. The client may hold a nonsecret,
   account-bound marker to adapt existing typed clients.
4. Cookie-authenticated mutations require the existing exact-origin and CSRF
   protections. Preserve bearer authentication for installed clients. WebSockets
   use cookie authentication and validate Origin; reconnect after session changes.
5. Replace native canonical-store calls with a browser projection adapter. Hosted
   chat APIs remain the source of truth. Browser persistence is only a cache,
   scoped by account and organization, with bounded history loading.
6. Separate native capabilities from hosted capabilities. Never make
   `isNativeShell` true in a browser to unlock a feature. Native-only operations
   must report actionable unsupported behavior rather than fake success.
7. Use browser File/Blob APIs for attachments and browser media APIs for calls.
   Hosted tools run on the hosted runner. Local files/models/tools require a
   real connected desktop capability and are not simulated.

## Parallel work packages

| Owner | Implementation | Dependencies |
| --- | --- | --- |
| Browser authentication agent | Cookie session restore/login/signup/OAuth/logout; account-bound transport; CSRF; cookie API and WebSocket authentication; organization restoration; security tests | Existing server web-session contract |
| Browser runtime agent | Canonical projection/cache; real chat lifecycle; native boundary; browser attachments; projection/account isolation tests | Browser runtime flag and authenticated transport |
| Browser navigation agent | Real route map; Back/Forward; full viewport/responsive shell; hosted-action capability gates; route tests | Browser runtime flag and canonical adapter |
| Integration owner | This page inventory; Vite/build scripts; same-origin static hosting; production-bundle browser acceptance; regression and security review | All three work packages |

Agents share one isolated worktree with explicit file ownership. They do not
commit, deploy, restart shared services or mutate production. Integration resolves
interface changes before broad validation; package reuse avoids unnecessary new
dependencies or a separate duplicate frontend.

## Delivery sequence and exit criteria

### 1. Browser foundation

- Build an independent `/app/` artifact without changing desktop packaging.
- Restore a browser cookie session and render the actual full app shell.
- Direct routes and Back/Forward select the intended destination.
- No startup exceptions, native IPC calls, synthetic chats or leaked credentials.

### 2. Real collaboration

- Two isolated browser accounts send and receive direct/group messages.
- Refresh reconstructs history; paginated loading and read/unread state agree.
- Contact/group creation and invitation acceptance reach authoritative APIs.
- Attachments upload, preview and download across accounts.
- Network interruption and retries recover without duplicates or lost drafts.

### 3. Hosted capability parity

- Hosted agents stream, stop, recover and retain final output after refresh.
- Existing Info, Artifacts, Tasks, Memory, Digest and Calendar destinations work
  in their supported contexts.
- Organization switching, provider/account settings, calls, documents and Factory
  are verified with the required development services configured.
- Native-only integrations are explicit and do not silently fail.

### 4. Release qualification

- Desktop regression tests and browser security tests pass.
- Chromium and WebKit exercise the production bundle at wide and narrow sizes.
- Compare the complete UI and controls with the current native product before
  describing screenshots or recordings as authentic parity.
- Verify build size, lazy document/media loading, and bounded transcript rendering.
- Validate real OAuth with separate development providers and two-account
  collaboration on a task-owned development backend.
- Prepare deployment configuration and rollback instructions. Deployment and
  product-server validation are separate authorized operations.

## Failure and security cases

- Expired/revoked session, account switch in another tab, stale in-flight request.
- Organization switch during transcript loading or message send.
- Wrong Origin, missing/mismatched CSRF, invalid cookie and bearer precedence.
- WebSocket handshake from another origin and reconnect after expiration.
- Invalid/deleted/inaccessible route and direct refresh after sign-in.
- Upload failure, permission denial, unsupported local file path and canceled send.
- Background tab, offline startup, disconnect during agent streaming, duplicate
  push event and missed-event catch-up.
- Missing asset/API route returns a real 404, never application HTML.
- Static traversal and symbolic-link escape remain rejected.

## Build and hosting contract

`pnpm build:web:app` (or `pnpm --dir app/web build`) creates `app/web/dist`. Stage the contents inside
`app/` beneath the server's configured `KORDI_WEB_PAGES_DIR`, alongside existing
account pages. Do not replace account pages or serve arbitrary repository files.
The server serves `/app` and known app routes from `app/index.html`, static assets
from `/app/assets/`, and keeps account and API routes independent.

For local frontend iteration, `pnpm dev:web:app` uses a loopback frontend. Set
`VITE_KORDI_CLOUD_API_BASE` to that frontend origin, `VITE_KORDI_DEV_PROFILE=community`,
and optionally `KORDI_WEB_API_PROXY_TARGET` to a task-owned loopback backend.
The backend's public origin must agree with the browser origin for Origin and
OAuth validation. Use a secure development origin when exercising Secure cookies;
do not weaken cookie policy to make a preview work.

## Desktop alignment follow-up

The user confirmed the latest main-branch desktop UI as the reference. See the
[alignment audit](desktop-alignment.md) for additional fixes, verified flows,
and confirmed behavioral gaps. Shared components alone do not establish parity.

## Validation record

Implemented in the first delivery:

- Separate browser artifact and same-origin application routes, with the existing
  desktop build retained under its original size budget.
- Cookie-backed sign-in/session transport, CSRF and account/organization binding,
  WebSocket authentication, safe invitation entry and account-cache cleanup.
- Account-and-organization-scoped IndexedDB chat projections, hosted delivery,
  outbox reconciliation, authoritative history and browser attachments.
- Full shared shell, real navigation, direct conversation URLs, Back/Forward,
  narrow-screen sidebar and removal of synthetic startup conversations.
- Organization remount and captured-scope guards for delayed work, so previous
  organization responses cannot populate the current conversation cache.

Verified locally:

- Backend: 37 authentication/session tests, 12 static-serving tests and 8 invitation
  tests pass. The authentication suite includes real server-router cookie login,
  contact acceptance, two-account direct messaging, CSRF rejection, idempotent
  delivery, history and outsider access denial against an isolated database.
- Compiled browser: Chromium and WebKit cover real shared UI history, send,
  attachment bytes and refresh against explicitly synthetic hosted API fixtures.
  All 18 cross-browser acceptance checks pass, including organization switching.
  Responsive navigation/history checks pass at desktop and 390-pixel widths.
- Frontend unit run: 2,964 component tests pass; 1,780 of 1,785 TypeScript
  tests passed on the broad run. The five failures were source-structure assertions
  affected by extracted modules and browser-specific copy; all were corrected and
  their owning suites passed focused reruns (10 group, 18 settings, 3 favicon).
- Rendered Classic theme and complete conversation controls were inspected in
  synthetic screenshots. These checks do not establish live product parity.

Release acceptance still required:

- Real Google/GitHub provider round trips and email delivery/admission.
- Two-account browser collaboration and attachment access on the configured
  development backend, including prolonged disconnect/reconnect.
- Hosted agent streaming/stop/recovery; Factory/provider configuration; all
  applicable Tasks, Memory, Digest and Calendar flows with real services.
- Configured voice/video permissions and call lifecycle; collaborative document
  editing with multiple peers and revoked sharing.
- Full comparison against the running native product and any supplied references.
- Deployment configuration review, rollout/rollback and authorized deployed checks.

Browser site storage must be available. Local models, arbitrary local filesystem
access and native tool execution remain desktop capabilities. No production
access or deployment is part of this implementation. Both production frontend
builds, TypeScript, full frontend lint, Rust formatting and strict Clippy checks
pass. Repository privacy, English-only and maintainability checks are included
in the local handoff.
