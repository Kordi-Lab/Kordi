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
3. The page signs the user in or creates an account through the existing
   account endpoints, then calls `POST /v1/cloud/auth/app/authorize` with
   the web session's bearer token. The response holds the redirect URL with
   the code, and the page navigates to it.
4. If the redirect to the app is blocked, the page calls
   `POST /v1/cloud/auth/app/authorize/display-code` instead and shows the
   code for the user to paste into the app.
5. The app checks `state` and calls `POST /v1/cloud/auth/app/token` with the
   code and its verifier.

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

Called by the web sign-in page. JSON body with the same fields as the query
above, and `Authorization: Bearer <web session token>`.

- Not signed in: `401` with `error` and `errorCode` set to
  `login_required`. The page signs the user in and retries.
- Signed in with an app's own access token instead of a web session: `403`
  `web_session_required`.
- Account not admitted on this server: the admission error the other sign-in
  endpoints return.
- Success: `{"redirectUrl", "expiresAt", "expiresIn"}`. `redirectUrl` is the
  redirect URI with `code` and `state` added. The code expires after 60
  seconds.

### `POST /v1/cloud/auth/app/authorize/display-code`

Same request as above. Success: `{"code", "state", "expiresAt",
"expiresIn"}`. The code expires after 5 minutes and is exchanged like any
other code, with the redirect URI from the original request and the app's
verifier, so a copied code is useless without that app instance.

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
- Codes are random 256-bit values, stored as SHA-256 hashes, bound to the
  client, redirect URI, challenge and account, and valid once. The first
  exchange consumes the code even when it fails, so a wrong verifier cannot
  be retried. A second exchange of a used code revokes the sign-in the first
  exchange started (RFC 6749, section 4.1.2).
- Refresh tokens are stored as hashes, rotate on every use, and expire after
  30 days without use. Presenting a rotated token again revokes the sign-in
  and every token it issued. Refreshes of one sign-in must not run
  concurrently.
- The authorization endpoint accepts only a bearer web session, never a
  cookie, so another site cannot request a code on the user's behalf.
- The authorization, token and revocation endpoints share the per-address
  limit of the other sign-in endpoints.

## Data

Migration 0165 adds `cloud_app_sign_ins`, `cloud_app_authorization_codes`,
`cloud_app_refresh_tokens`, and a nullable `app_sign_in_id` on session rows.
Registered clients live in configuration, not in the database.

## Tests

`auth::routes::app_sign_in_handlers::tests` needs a disposable database and
runs from `scripts/test-cloud-migrations.sh`. Client and PKCE rules have unit
tests in `auth::app_sign_in`.
