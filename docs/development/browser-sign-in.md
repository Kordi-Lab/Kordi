# Browser sign-in for the apps

The desktop and iOS apps sign in through the system browser with an
authorization code and PKCE (RFC 6749, RFC 7636, RFC 8252). The app never
handles the user's password. The browser returns a short-lived, single-use
code, and the app exchanges it for tokens. Tokens never appear in a URL.

This document describes the cloud server side and the contract for the web
sign-in pages. The app screens and the pages themselves are separate steps.
Hosts without a usable browser use
[device code sign-in](device-code-sign-in.md) instead.

## Flow

1. The app creates a random `code_verifier` (43 to 128 characters), derives
   `code_challenge = BASE64URL(SHA256(code_verifier))`, picks a random
   `state`, and opens the system browser at
   `GET /v1/cloud/auth/app/authorize`.
2. The server validates the request and redirects the browser to the web
   sign-in page with the same parameters.
3. The page signs the user in or creates an account through the web session
   endpoints below. The session lives in an `HttpOnly` cookie, so page
   scripts never see a session token.
4. The page asks the user to approve the app (see
   [Approval](#approval)), then calls `POST /v1/cloud/auth/app/authorize`
   with the cookie, its CSRF token, and `"approved": true`. The response
   holds the redirect URL with the code, and the page navigates to it. A
   loopback or custom-scheme redirect is the preferred path.
5. Only if that redirect is blocked does the page fall back to a displayed
   code (see below).
6. The app checks `state` and calls `POST /v1/cloud/auth/app/token` with the
   code and its verifier.

## Web session

The sign-in page holds its session in cookies set by the server:

| Cookie | Attributes | Contents |
| --- | --- | --- |
| `__Host-kordi_web_session` | `Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000` | The session token. Never readable by scripts. |
| `__Host-kordi_web_csrf` | `Path=/; Secure; SameSite=Strict; Max-Age=2592000` | The CSRF token, readable by the page. |
| `__Host-kordi_oauth_bind` | `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` | A random value that binds a web Google or GitHub sign-in to this browser. |

The `__Host-` prefix makes both cookies host-only (no `Domain`), `Secure`,
and scoped to `Path=/`, so another subdomain cannot set or overwrite them.
The CSRF token is `SHA-256("kordi-web-csrf" || 0x00 || session token)`, so it
needs no storage, matches only its own session, and reveals nothing about
the session token.

Endpoints:

- `POST /v1/cloud/auth/web/login` and `POST /v1/cloud/auth/web/signup`: the
  same requests as `/v1/cloud/auth/login` and `/v1/cloud/auth/signup`. They
  set both cookies, remove the session token from the response body, and add
  `csrfToken`. They require the exact public `Origin`.
- `GET /v1/cloud/auth/web/oauth/:provider/start?returnTo=<path>`: Google or
  GitHub sign-in. The page links to it directly. It sets
  `__Host-kordi_oauth_bind` and stores the SHA-256 of its value with the
  provider state. The provider callback sets the session cookies and
  redirects to `returnTo` (a path on the public origin, default
  `/sign-in/app`) without the session in the URL, but only when the browser
  presents the matching binding cookie; it then clears that cookie. A
  callback without it (someone else's callback URL, or a start from another
  browser or an older tab) installs no session and returns to the page with
  `kordi_cloud_oauth_error_code=oauth_browser_mismatch` in the fragment. A
  failed sign-in lands on `/v1/cloud/auth/web/oauth/complete`, which returns
  to `returnTo` with the error in the fragment. Only one web provider
  sign-in per browser can be in progress; a second start replaces the
  binding of the first.
- A provider sign-in that returns to the public origin always uses this
  cookie hand-off, never a session in a URL fragment: the only accepted
  target there is `/v1/cloud/auth/web/oauth/complete`, only the web start
  may use it, and the callback refuses a public-origin target without a
  valid `returnTo` and the matching binding cookie. The legacy
  `GET /v1/cloud/auth/oauth/:provider/start` rejects every public-origin
  target with `400 invalid_redirect`. Loopback and allowlisted app targets
  keep their fragment hand-off.
- `GET /v1/cloud/auth/web/session`: `{account, csrfToken}` for the cookie
  session, or `401 login_required`.
- `POST /v1/cloud/auth/web/logout`: revokes the session and clears both
  cookies.

A web sign-in (password, sign-up, or provider) revokes the web session the
cookie held before, so replaced sessions do not linger. App access tokens are
never revoked this way.

Every state-changing request authenticated by the cookie (authorization,
display code, web sign-out) is checked in this order:

1. `Origin` must equal the public origin exactly, or `403 origin_mismatch`.
2. The session cookie must be present, or `401 login_required`.
3. The `X-Kordi-CSRF-Token` header must match the session's CSRF token, or
   `403 csrf_token_invalid`.
4. The session must be live and come from a web sign-in, not an app's access
   token (`401 login_required`, `403 web_session_required`).

Together with `SameSite=Strict` and the server's CORS policy, which never
allows credentials, another site can neither send the cookie with a request
nor read a response. The authorization endpoints accept only the cookie. The
apps and existing clients keep using bearer tokens everywhere else.

## Registered apps

Every app is a public client: a client ID and exact redirect URIs, no secret.
The built-in list:

| Client ID | Redirect URIs |
| --- | --- |
| `kordi-desktop` | `http://127.0.0.1/auth/callback`, `http://[::1]/auth/callback`, `kordi://auth/callback` |
| `kordi-ios` | `kordi://auth/callback` |
| `kordi-desktop-beta` | loopback as above, `kordi-beta://auth/callback` |
| `kordi-ios-beta` | `kordi-beta://auth/callback` |
| `kordi-desktop-staging` | loopback as above, `kordi-staging://auth/callback` |
| `kordi-ios-staging` | `kordi-staging://auth/callback` |

Redirect URIs match exactly. A loopback URI registered without a port
accepts the same URI with any explicit port, so the desktop app can listen
on an ephemeral port. `localhost` is not accepted.

`KORDI_AUTH_APP_CLIENTS` replaces the built-in list with a JSON array of
`{"clientId", "name", "redirectUris", "deviceCode"}` objects. `deviceCode`
(default `false`; `true` for the built-in desktop clients) allows
[device code sign-in](device-code-sign-in.md). Redirect URIs must be
`https`, loopback `http`, or a custom scheme; schemes the browser handles
itself (`javascript`, `data`, `file`, `blob`, `vbscript`, `about`,
`filesystem`, `view-source`) are refused. An invalid value disables browser
sign-in rather than falling back to the built-in list.

`KORDI_AUTH_APP_SIGN_IN_PAGE_URL` sets the web sign-in page. It defaults to
`/sign-in/app` on the public origin, which serves the login page when web
pages are configured (see below).

## Same-origin web pages

The session cookie is host-only, so the sign-in pages must be served from the
API origin. `KORDI_WEB_PAGES_DIR` names a directory of static pages that the
cloud server then serves. When it is unset or empty, no page route exists and
behavior is unchanged. When it is set to a path that is not a directory, the
server refuses to start.

| Request | File |
| --- | --- |
| `GET /login` | `login.html` or `login/index.html` |
| `GET /register` | `register.html` or `register/index.html` |
| `GET /login/done` | `login/done.html` or `login/done/index.html` |
| `GET /account` | `account.html` or `account/index.html` |
| `GET /account/<page>` | `account/<page>.html` or `account/<page>/index.html` |
| `GET /sign-in/app?<query>` | `303` to `/login?<query>`, query unchanged |
| `GET /<path>.<ext>` | the asset file, for the extensions below |

- Assets: `css`, `js`, `mjs`, `json`, `map`, `webmanifest`, `txt`, `svg`,
  `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `ico`, `woff2`, `woff`, `ttf`,
  `otf`. Other files, including other `.html` files, are not served. Asset
  requests under `/v1/` and `/v2/` are never served from the directory.
- Path segments may contain only ASCII letters, digits, `-`, `_` and `.`.
  Empty segments, segments that start with `.` (so `..` and hidden files),
  percent-encoded characters and backslashes return `404`. The resolved file,
  after following symbolic links, must stay inside the directory. Directories
  are never listed. Files larger than 16 MiB are not served.
- Pages: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-cache`,
  `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`. Pages cannot be framed, so the display-code
  confirmation cannot be clickjacked, and the sign-in query is not sent to
  other sites.
- Assets: their content type and `Cache-Control: public, max-age=3600`.
- Every file: `X-Content-Type-Options: nosniff` and a weak `ETag`;
  `If-None-Match` returns `304`. `HEAD` is supported.
- Links from the pages to other parts of a site must be absolute URLs, since
  only the routes above exist on the API origin.

In the Docker development stack, set `KORDI_DEBUG_WEB_PAGES_DIR` in
`deploy/dev/.env` to the pages directory (absolute, or relative to
`deploy/dev`). It is mounted read-only at `/srv/kordi-web-pages` and passed as
`KORDI_WEB_PAGES_DIR`. Unset, an empty volume is mounted and no pages are
served.

The `__Host-` cookies are `Secure`. Browsers accept them on `https` and treat
`http://127.0.0.1`, `http://[::1]` and `http://localhost` as secure origins
too, so a loopback development stack works. Check the target browser before
relying on that. A release build accepts a plain `http` public origin only for
those loopback hosts; every other host needs `https`.

Cookies are not isolated by port, and every port of one host is the same
site. On a loopback stack the `__Host-` cookies of an API at
`http://localhost:17081` are therefore sent to, and the CSRF cookie readable
by, any other page on `http://localhost:<port>`, such as a Vite dev server.
The exact `Origin` check still refuses requests from those pages, but keep
them apart anyway: serve the API and its pages on `localhost`, and run app
callbacks, loopback listeners and dev servers on `127.0.0.1` (or the other
way around, but never both on the same name). A loopback public origin is
also reachable under the other loopback names on its port, so the server
treats `http://127.0.0.1:<port>` and `http://localhost:<port>` alike when it
checks sign-in return targets: neither may receive a session in a URL.

## Page API contract

All requests are same-origin `fetch` calls with `credentials: "same-origin"`
(the default). The browser sends `Origin` on `POST`. Pages never read or store
a session token: they keep only the CSRF token in memory, read it from the
`__Host-kordi_web_csrf` cookie, or fetch it from `/v1/cloud/auth/web/session`.
Error bodies are `{"errorCode", "message"}`.

1. **Check the session.** `GET /v1/cloud/auth/web/session` returns
   `{"account", "csrfToken"}`, or `401 login_required` when signed out.
2. **Log in.** `POST /v1/cloud/auth/web/login` with JSON
   `{"email", "password"}`. Success sets both cookies and returns the
   `/v1/cloud/auth/login` body without `session.token`, plus `csrfToken`.
3. **Sign up.** `POST /v1/cloud/auth/signup/code` with `{"email"}` returns
   `{"verificationId", "expiresAt", "retryAfterSeconds"}` and emails a code
   (when the server requires email verification). Then
   `POST /v1/cloud/auth/web/signup` with `{"email", "password",
   "displayName", "avatarSeed", "verificationId", "verificationCode"}`.
   `avatarSeed` is any random string. Success is the same as log-in.
4. **Google or GitHub.** Navigate the page (not `fetch`) to
   `GET /v1/cloud/auth/web/oauth/google/start?returnTo=<path>` or
   `.../github/start?returnTo=<path>`. `returnTo` is a path on this origin,
   normally the current `/login?<query>` so the app request survives. Success
   returns to it with the cookies set. Failure returns to it with
   `#kordi_cloud_oauth_error=<message>&kordi_cloud_oauth_error_code=<code>`.
   `oauth_browser_mismatch` means the sign-in finished in a browser that did
   not start it (or a newer start replaced it); offer to start again.
   Always show both buttons. `GET /v1/cloud/auth/capabilities` is
   diagnostic only; a provider that is not configured fails at start with an
   error the page shows.
5. **Ask for approval.** Show the app name and the account, for example
   "Kordi for Mac wants to sign in" and a "Continue as Ada
   (ada@example.com)" button with a way to switch accounts. See
   [Approval](#approval). Skip the click only right after the user signed
   in, signed up, or finished Google or GitHub in this tab for this request.
6. **Send the code to the app.** With the query the page was opened with
   (`response_type`, `client_id`, `redirect_uri`, `code_challenge`,
   `code_challenge_method`, `state`), call `POST /v1/cloud/auth/app/authorize`
   with header `X-Kordi-CSRF-Token: <csrfToken>` and a JSON body of those six
   fields plus `"approved": true`. Without it the server returns
   `400 approval_required`. Navigate to `redirectUrl` from the response,
   then show `/login/done`.
7. **Display code, only if the redirect failed.** After the user confirms
   they started this sign-in from their own app on this device, call
   `POST /v1/cloud/auth/app/authorize/display-code` with the same header and
   body plus `"confirmed": true`. Show `code`, `appName`, `requestedAt`,
   `expiresAt` and `warning` as described above.
8. **Sign out.** `POST /v1/cloud/auth/web/logout` with the CSRF header
   clears the cookies.

A `401 login_required` from step 6 or 7 means the session ended: show the log-in
form again and keep the query.

## Endpoints

### `GET /v1/cloud/auth/app/authorize`

Query: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
`code_challenge_method=S256`, `state` (required, up to 512 characters), and
optionally `prompt`.

- Unknown client or unregistered redirect URI: `400` with `invalid_client`
  or `invalid_redirect_uri`. Nothing is sent to the redirect URI.
- Any other invalid parameter: a redirect to `redirect_uri` with `error`,
  `error_description` and `state`.
- Valid: a redirect to the web sign-in page with the same parameters.
- `prompt=create` (OpenID Connect) is forwarded to the sign-in page, which
  should then open on account creation instead of log-in. Any other `prompt`
  value is dropped. The page sends `prompt` back to
  `POST /v1/cloud/auth/app/authorize` or leaves it out; the server ignores it
  there. The apps send it for Sign up.

### `POST /v1/cloud/auth/app/authorize`

Called by the web sign-in page with the web session cookie and CSRF header.
JSON body with the same fields as the query above, plus `"approved": true`.

- Cookie, `Origin` or CSRF problems: see the web session checks above.
- `approved` missing or not `true`: `400 approval_required`
  (`error` and `errorCode`). No code is issued.
- Account not admitted on this server: the admission error the other sign-in
  endpoints return.
- Success: `{"redirectUrl", "expiresAt", "expiresIn"}`. `redirectUrl` is the
  redirect URI with `code` and `state` added. The code expires after 60
  seconds.

### Approval

A code sent to a redirect URI reaches whatever program holds that URI. Any
app on the device can claim a custom scheme or a loopback port, so the
server issues a redirect code only with the user's approval of this request
(RFC 8252, section 8.6). The page:

1. Shows the app name and the signed-in account, for example "Kordi for Mac
   wants to sign in" and a "Continue as Ada (ada@example.com)" button, with a
   way to switch accounts.
2. Sends `"approved": true` only after the user clicks that button, or
   automatically right after the user completed a fresh sign-in (password,
   sign-up, or provider) in this same tab for this same authorization
   request. A session that already existed when the page loaded always needs
   the click.
3. Never sends `approved` from a timer, an `onload` handler, or any other
   path without one of those two user actions.

The server can only check that `approved` is present; the page is what makes
it mean consent. A displayed code needs `confirmed` instead (below), because
it reaches only the person reading the page.

### `POST /v1/cloud/auth/app/authorize/display-code`

A last resort for when the redirect to the app is blocked. A displayed code
can be phished: someone who tricks the user into sharing it gets a sign-in.
So the page must:

1. Try the redirect first and offer the code only after it failed.
2. Ask the user to confirm they started this sign-in from their own app on
   this device, and only then call this endpoint with `"confirmed": true`.
   Without it the endpoint returns `400 confirmation_required`.
3. Show the code with the app name and request time, for example "Code for
   Kordi for Mac, requested at 10:42", and this warning, also returned as
   `warning`: "Only paste this code into the Kordi app on this device.
   Never share it."

Same request as above plus `confirmed`. Success: `{"code", "state",
"clientId", "appName", "requestedAt", "expiresAt", "expiresIn", "warning"}`.
The code is single use, expires after 60 seconds, and is bound to the PKCE
challenge, so it works only with the verifier of the app instance that
started the sign-in.

Limits: 30 codes of any kind per account per 10 minutes, and 5 displayed
codes per account and app per 10 minutes.

### `POST /v1/cloud/auth/app/token`

Form-encoded (RFC 6749) or JSON. Repeated parameters are rejected. Responses
carry `Cache-Control: no-store`. Errors use the RFC 6749 shape plus the
`errorCode` and `message` fields of other Kordi endpoints.

`grant_type=authorization_code`: `client_id`, `code`, `redirect_uri`,
`code_verifier`, and optional device details (`device_public_key`,
`device_key_algorithm`, `device_name`, `device_platform`,
`device_os_version`, `device_app_version`) that register the installation
the same way password sign-in does.

`grant_type=refresh_token`: `client_id`, `refresh_token`.

Success:

```json
{
  "access_token": "kordi_cs_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "kordi_rt_...",
  "refresh_token_expires_in": 2592000,
  "device_id": "dev_...",
  "sign_in_id": "asi_...",
  "account": {}
}
```

Code exchanges are limited to 30 per account and 10 per account and app per
10 minutes. A limited exchange leaves the code unused.

A refresh may be retried: presenting a rotated refresh token again within 60
seconds of its rotation, while its successor is unused, returns the same
successor pair (same refresh token, same access token) instead of revoking
the sign-in. This covers a lost response and two refreshes racing. Any other
reuse revokes the sign-in.

`account` is present for the code exchange only. The access token is an
ordinary session token, so every existing API and realtime connection accepts
it. Unlike other sessions, its expiry does not slide forward on use. Realtime
connections close when it expires, so the app refreshes before expiry and
reconnects with the new token.

### `POST /v1/cloud/auth/app/revoke`

RFC 7009. `client_id` and `token` (a refresh token or an access token).
Revokes the whole sign-in: every refresh token and access token it issued.
Unknown tokens, and tokens of another client, succeed without effect.
`POST /v1/cloud/auth/logout` with an app access token also ends its sign-in.

### `GET /v1/cloud/auth/app/sign-ins` and `DELETE /v1/cloud/auth/app/sign-ins/:sign_in_id`

Signed-in apps of the current account: `signInId`, `clientId`, `appName`,
`deviceId`, `deviceName`, `platform`, `createdAt`, `lastActiveAt`, and
`current` for the sign-in behind the calling token. Delete revokes one;
another account's sign-in returns `404`. Revoking a device through the
existing devices API also ends its sign-ins at once, and they stay ended if
the same device key signs in again: refresh refuses any sign-in created
before the device's last revocation, which a database trigger records on
every revocation.

## Security properties

- Only S256 PKCE. `plain` and missing challenges are refused.
- Codes are random 256-bit values, valid for 60 seconds, stored as SHA-256
  hashes, bound to the client, redirect URI, challenge and account, and
  valid once. The first
  exchange consumes the code even when it fails, so a wrong verifier cannot
  be retried. A second exchange of a used code revokes the sign-in the first
  exchange started (RFC 6749, section 4.1.2).
- Refresh tokens are stored as hashes, rotate on every use, and expire after
  30 days without use. Presenting a rotated token again revokes the sign-in
  and every token it issued, except within 60 seconds of the rotation while
  the successor is unused, when it returns that same successor. The
  successor is derived from the presented token and a random salt stored on
  the rotated row, so only hashes are stored and only the holder of the
  rotated token can obtain it again.
- The web session token lives only in an `HttpOnly`, `Secure`,
  `SameSite=Strict`, host-only cookie. Cookie-authenticated requests need the
  exact public `Origin` and a session-bound CSRF token.
- The authorization endpoints accept only that cookie session, never an
  app's access token, and a redirect code needs the user's approval.
- Web provider sign-ins are bound to the starting browser, so a callback URL
  cannot plant another person's session (login CSRF).
- Displayed codes need an explicit confirmation, name the app, and are
  limited per account and app.
- The authorization endpoint and the `authorization_code` grant share the
  per-address limit of the other sign-in endpoints, and code issuance and
  redemption are also limited per account and per account and app.
  Refreshes and revocations do not spend that limit, so many users behind
  one address stay signed in; they have their own limit of 600 per minute
  per app and client address.

## Data

Migration 0165 adds `cloud_app_sign_ins`, `cloud_app_authorization_codes`,
`cloud_app_refresh_tokens`, and a nullable `app_sign_in_id` on session rows.
It also adds the successor salt and hash on refresh tokens,
`last_revoked_at` on devices with the trigger that sets it, and the browser
binding hash and replaced session on provider states.
Registered clients live in configuration, not in the database.

## Tests

`auth::routes::app_sign_in_handlers::tests` needs a disposable database and
runs from `scripts/test-cloud-migrations.sh`. It covers the cookie, `Origin`
and CSRF checks, approval, the display-code confirmation and limits, the
browser binding of web provider sign-ins, session replacement, device
revocation, the refresh grace period and concurrency, the rate limits, and
every code and refresh rejection. Client, PKCE, redirect and return-path
rules have unit tests. `web_pages::tests` covers page and asset serving,
traversal and symbolic-link escapes, headers, and the `/sign-in/app`
redirect. `distribution::tests` covers the loopback `http` rule.

## Desktop app

The desktop app shows a welcome screen with Log in and Sign up. Both open
the system browser at `GET /v1/cloud/auth/app/authorize` on the configured
API origin; Sign up adds `prompt=create` so the page can open on account
creation. The code lives in `app/desktop/src/features/cloud/appSignIn/`.

- Client ID: derived from the build's callback scheme (`kordi` ->
  `kordi-desktop`, `kordi-beta` -> `kordi-desktop-beta`, `kordi-staging` ->
  `kordi-desktop-staging`). Development builds may set
  `VITE_KORDI_APP_CLIENT_ID`.
- Redirect: a loopback listener in the native shell on an ephemeral port
  (`http://127.0.0.1:<port>/auth/callback`). It completes only for the
  `state` the app generated; the app checks `state` again before the
  exchange. It serves connections concurrently, so an idle preconnect cannot
  hold up the redirect, and refuses a repeated `state`, `code` or `error`.
  Its pages send `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and a CSP that allows only inline style,
  script and `data:` images. The listener stops after 10 minutes, on Cancel,
  or once a code is exchanged.
- Paste code: the wait screen accepts the displayed code and exchanges it
  with the same verifier and redirect URI. One attempt exchanges at most one
  code; a refused code (expired or used) can be replaced by another. Cancel
  is disabled while a pasted code is exchanged; a sign-in that completes
  after Cancel is revoked.
- Availability: before offering browser sign-in the app sends
  `GET /v1/cloud/auth/app/authorize?client_id=<id>`. `invalid_redirect_uri`
  means the server knows the client. A 404, a 405 or `invalid_client` shows
  the in-app email form instead, so older servers keep working. Any other
  answer (a rate limit, a proxy or captive portal, an outage) keeps browser
  sign-in and is not remembered, so the next launch asks again.
- Tokens: the access token, refresh token, client ID and token endpoint are
  stored with the Cloud session in the OS keychain. The native shell
  refreshes five minutes before expiry under one process-wide lock
  (`cloud_session_refresh`), so windows and background tasks never present
  a rotated refresh token twice. The refresh writes its result only while
  the stored session is still the one it refreshed, and sign-in and
  sign-out take the same write lock, so a sign-out or account switch during
  a refresh is never overwritten. A refused refresh signs the app out.
- Native callers (scheduled tasks, account memory, connector and digest
  tools, agent exchange, hosted provider auth) keep the account, not the
  access token: each request or turn reads the stored session and refreshes
  it first when the token expires within five minutes, for example after the
  Mac wakes from sleep.
- Sign-out revokes the refresh token through `POST /v1/cloud/auth/app/revoke`.
- Account changes: Cloud caches, the group outbox, attachments and file
  storage are keyed by account ID, and signing in as a different account
  activates that account's storage and reloads the window before any of its
  data is shown.

Provider sign-ins for model accounts are unchanged.

## iPhone app

The iPhone app shows a welcome screen with Log in and Sign up. Both open
`GET /v1/cloud/auth/app/authorize` on the build's API origin in an
`ASWebAuthenticationSession`; Sign up adds `prompt=create`. The code lives in
`app/ios/Kordi/Core/Auth/AppSignInClient.swift`,
`app/ios/Kordi/Core/Auth/AppSignInController.swift`,
`app/ios/Kordi/App/AppModel+BrowserSignIn.swift` and
`app/ios/Kordi/Features/Auth/WelcomeView.swift`.

- Client ID and redirect: derived from the build's callback scheme, with an
  iPhone client separate from the desktop one (`kordi` -> `kordi-ios`,
  `kordi-beta` -> `kordi-ios-beta`, `kordi-staging` -> `kordi-ios-staging`).
  The redirect is `<scheme>://auth/callback`, the only redirect URI those
  clients register. `Kordi Beta` uses `kordi-beta` against the loopback
  development API; `Kordi` uses the production scheme against
  `https://kordi.ai`. A build whose scheme has no registered client gets
  `invalid_client` and shows the in-app form.
- The web authentication session itself receives the callback for the
  scheme, so the code never passes through the system URL router. The app
  checks the callback's scheme, host, path and its single `state` before the
  exchange. Because the session always receives the redirect, the iPhone app
  has no paste-code step.
- Availability: the same probe and rules as the desktop app. The answer is
  remembered for the rest of the launch only when it is settled
  (`invalid_redirect_uri`, 404, 405 or `invalid_client`).
- Requests go through the app's Cloud transport, which connects loopback
  directly and works around a broken system proxy.
- Tokens: the access token stays in the existing Keychain session item, and
  the refresh token, client ID, token endpoint, expiry and account ID are a
  second Keychain item (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
  Both are updated in place, so a failed write never loses a rotated refresh
  token. Removing the session item always removes the second one too.
- Refresh: five minutes before expiry, at launch, when the app returns to the
  foreground, and before background Nearby posts. One store per process runs
  one refresh at a time and holds background execution time for it (the reuse
  grace is 60 seconds). Its result is written only while the stored sign-in is
  still the one it refreshed, so a sign-out during a refresh wins and the new
  tokens are revoked. A refused refresh (`invalid_grant` or `invalid_client`)
  signs out; anything else keeps the session and retries.
- Session identity: work started under an earlier access token of the same
  sign-in stays current after a refresh, so in-flight requests are not
  dropped. A refresh reconnects realtime with the new token.
- Launch: a stored sign-in for another server is dropped. The refresh
  credential is the source of truth, so a session token left behind by a
  refresh whose second write failed is repaired. A password or provider
  sign-in removes and revokes any kept browser sign-in first. Only the server ending the session (401,
  `invalid_session`, `account_missing`) discards the stored sign-in, revoking
  it; a connection or server error keeps it, and the welcome screen restores
  it when it appears or the app returns to the foreground. Log in and Sign up
  stay usable during that; tapping one cancels the restore.
- Share extension: it never refreshes (a second process could present a
  rotated token). With an expired token it shows "Open Kordi to continue";
  opening the app refreshes the session and rewrites the extension's copy.
- Sign-out revokes the refresh token through `POST /v1/cloud/auth/app/revoke`
  and then calls `POST /v1/cloud/auth/logout`.
- Account changes: caches are keyed by account ID, and a browser sign-in that
  returns a different account than the one in memory signs that account out,
  clearing its caches, before the new account's data loads.

A server that sets `KORDI_AUTH_APP_CLIENTS` replaces the built-in list, so
it must include `kordi-ios` (and `kordi-ios-beta` on development servers) or
iPhone users fall back to the in-app form.

Follow-up: any app on the device can register a custom URL scheme. The next
step is a claimed `https` universal-link redirect (an associated domain on
the API origin and an `ASWebAuthenticationSession` HTTPS callback, available
from iOS 17.4), registered as the iPhone clients' redirect URI in place of the
custom scheme.
