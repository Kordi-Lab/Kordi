# Browser sign-in for the apps

The desktop and iOS apps sign in through the system browser with an
authorization code and PKCE (RFC 6749, RFC 7636, RFC 8252). The app never
handles the user's password. The browser returns a short-lived, single-use
code, and the app exchanges it for tokens. Tokens never appear in a URL.

This document describes the cloud server side. The app screens and the web
sign-in page are separate steps.

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
4. The page calls `POST /v1/cloud/auth/app/authorize` with the cookie and
   its CSRF token. The response holds the redirect URL with the code, and
   the page navigates to it. A loopback or custom-scheme redirect is the
   preferred path.
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
  GitHub sign-in. The provider callback sets the cookies and redirects to
  `returnTo` (a path on the public origin, default `/sign-in/app`) without
  the session in the URL. A failed sign-in lands on
  `/v1/cloud/auth/web/oauth/complete`, which returns to `returnTo` with the
  error in the fragment. App and existing web flows keep their current
  hand-off.
- `GET /v1/cloud/auth/web/session`: `{account, csrfToken}` for the cookie
  session, or `401 login_required`.
- `POST /v1/cloud/auth/web/logout`: revokes the session and clears both
  cookies.

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
`{"clientId", "name", "redirectUris"}` objects. An invalid value disables
browser sign-in rather than falling back to the built-in list.

`KORDI_AUTH_APP_SIGN_IN_PAGE_URL` sets the web sign-in page. It defaults to
`/sign-in/app` on the public origin.

## Endpoints

### `GET /v1/cloud/auth/app/authorize`

Query: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
`code_challenge_method=S256`, `state` (required, up to 512 characters).

- Unknown client or unregistered redirect URI: `400` with `invalid_client`
  or `invalid_redirect_uri`. Nothing is sent to the redirect URI.
- Any other invalid parameter: a redirect to `redirect_uri` with `error`,
  `error_description` and `state`.
- Valid: a redirect to the web sign-in page with the same parameters.

### `POST /v1/cloud/auth/app/authorize`

Called by the web sign-in page with the web session cookie and CSRF header.
JSON body with the same fields as the query above.

- Cookie, `Origin` or CSRF problems: see the web session checks above.
- Account not admitted on this server: the admission error the other sign-in
  endpoints return.
- Success: `{"redirectUrl", "expiresAt", "expiresIn"}`. `redirectUrl` is the
  redirect URI with `code` and `state` added. The code expires after 60
  seconds.

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
existing devices API also ends its sign-ins.

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
  and every token it issued. Refreshes of one sign-in must not run
  concurrently.
- The web session token lives only in an `HttpOnly`, `Secure`,
  `SameSite=Strict`, host-only cookie. Cookie-authenticated requests need the
  exact public `Origin` and a session-bound CSRF token.
- The authorization endpoints accept only that cookie session, never an
  app's access token.
- Displayed codes need an explicit confirmation, name the app, and are
  limited per account and app.
- The authorization, token and revocation endpoints share the per-address
  limit of the other sign-in endpoints, and code issuance and redemption are
  also limited per account and per account and app.

## Data

Migration 0165 adds `cloud_app_sign_ins`, `cloud_app_authorization_codes`,
`cloud_app_refresh_tokens`, and a nullable `app_sign_in_id` on session rows.
Registered clients live in configuration, not in the database.

## Tests

`auth::routes::app_sign_in_handlers::tests` needs a disposable database and
runs from `scripts/test-cloud-migrations.sh`. It covers the cookie, `Origin`
and CSRF checks, the display-code confirmation and limits, and every code and
refresh rejection. Client, PKCE and return-path rules have unit tests.
