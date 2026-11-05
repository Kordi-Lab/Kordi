# Device code sign-in

A Mac without a usable browser (a remote Mac reached over SSH, a headless
runner host) signs in with a device code (RFC 8628). The host shows a short
code; a person signed in on another device types it on the approval page at
`/device` and approves. The host then receives the same token response as
[browser sign-in](browser-sign-in.md), and the new device appears in
Settings › Devices, where it can be revoked like any other.

## Flow

1. The host calls `POST /v1/cloud/auth/device/code` and shows `user_code`
   and `verification_uri`.
2. The host polls `POST /v1/cloud/auth/device/token` every `interval`
   seconds.
3. The person opens `/device`, signs in if needed (Google, GitHub, or email),
   types the code, checks the device details and the warning, and approves
   or denies.
4. After approval, the next poll registers the device, starts an app
   sign-in, and returns access and refresh tokens. The host refreshes later
   through `POST /v1/cloud/auth/app/token`, as browser sign-in does.

## Codes

- `device_code`: `kordi_dc_` and 32 random bytes, base64url. Only the host
  sees it.
- `user_code`: 8 characters from `CDFGHJKMNPQRTVWX` (no vowels and no
  look-alikes such as 0/O, 1/I/L, 2/Z, 5/S, 8/B), shown as `XXXX-XXXX`.
  Case, spaces and dashes do not matter when typed.
- The server stores only SHA-256 hashes of both codes
  (`cloud_device_authorizations`, migration 0172).
- A pair lasts 15 minutes and is redeemed once. A second redemption returns
  `invalid_grant` and revokes the sign-in the first one started.
- Rows are removed a day after they expire.

## Endpoints

### `POST /v1/cloud/auth/device/code`

Form or JSON body: `client_id` (a registered app with `deviceCode`), and
optionally `device_name`, `device_platform`, `device_os_version`,
`device_app_version`, `device_public_key`, `device_key_algorithm` (as in the
token request of browser sign-in). An invalid public key is refused now, not
after approval.

```json
{
  "device_code": "kordi_dc_…",
  "user_code": "CDFG-HJKM",
  "verification_uri": "https://kordi.ai/device",
  "expires_in": 900,
  "interval": 5
}
```

There is no `verification_uri_complete`: the person always types the code,
so a link someone sends cannot carry it. An unregistered app, or one without
`deviceCode`, gets 401 `invalid_client`. A server without this feature
answers 404; clients then keep browser sign-in.

### `POST /v1/cloud/auth/device/token`

Form or JSON body: `grant_type=urn:ietf:params:oauth:grant-type:device_code`,
`client_id`, `device_code`. Errors are 400 with RFC 6749 fields plus
`errorCode` and `message`:

| `error` | Meaning |
| --- | --- |
| `authorization_pending` | Not decided yet; keep polling. |
| `slow_down` | Polled before `interval` passed. The interval grows by 5 seconds (up to 60) and the body carries the new `interval`. |
| `access_denied` | Denied. `reason` is `user_denied`, `organization_policy`, or `account_not_admitted`; `error_description` is a sentence the client can show. |
| `expired_token` | The code expired; start again. |
| `invalid_grant` | Unknown code, a code issued to another app, or a code already redeemed. |

Success returns the token response of browser sign-in, including `account`.

### Approval page endpoints

Both need the web session cookie, the exact public `Origin`, and the CSRF
header, like the browser sign-in page.

- `POST /v1/cloud/auth/device/lookup` with `{"userCode"}` returns
  `appName`, `deviceName`, `platform`, `osVersion`, `appVersion`,
  `ipAddress`, `approximateLocation`, `requestedAt`, `expiresAt`, and
  `warning`. Unknown, expired or decided codes answer 404
  `invalid_user_code`.
- `POST /v1/cloud/auth/device/decision` with `{"userCode", "decision":
  "approve" | "deny"}` returns `{"status": "approved" | "denied"}`. When an
  organization of the account does not allow device code sign-in, the code
  is denied with reason `organization_policy` and the page gets 403
  `device_code_not_allowed` naming the organization.

### `GET /device`

The approval page, built into the server so it runs on the API origin where
the web session cookie lives. It loads only `/device/device.js` and
`/device/device.css`, under a content security policy that forbids inline
script and framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). It
shows the warning "Only continue if you started this sign-in yourself. Never
enter a code someone sent you." above the device name, app, system, location
and request time. The product edge routes `/device` and `/device/*` to the
cloud server.

## Location

`approximateLocation` comes from a request header that the edge sets, named
by `KORDI_CLIENT_LOCATION_HEADER` (for example a load balancer's client
region header). It is read only when the request came from a trusted proxy
(`KORDI_CLOUD_TRUSTED_PROXIES`), and the edge must overwrite any value the
client sent. Unset means the page shows the IP address alone.

## Organization policy

`cloud_organizations.device_code_sign_in` controls whether members may sign
in with a code. NULL follows the default: allowed for personal organizations
and for team organizations people created themselves, off for organizations
created from deployment configuration (`config_id` set) until an owner or
admin turns it on. The sign-in covers the whole account, so an account that
belongs to any organization where it is off cannot use it. The setting is
checked when the person approves and again when the host redeems the code.

`GET /v1/cloud/organizations/:organization_id/settings` (any member) and
`PATCH` with `{"deviceCodeSignIn": true | false | null}` (owners and admins;
null restores the default) read and change it.

## Rate limits

| Action | Key | Limit |
| --- | --- | --- |
| Code requests | client address | 10 per 10 minutes |
| Polls | client address | 150 per minute, plus `slow_down` per code |
| Code lookups | account | 10 per 10 minutes, plus the per-address sign-in limit |
| Decisions | account | 10 per 10 minutes, plus the per-address sign-in limit |

Guessing a code needs on the order of 2^31 lookups, far beyond these limits
within a code's 15 minutes.

## Clients

- `kordi login --device [--server <url>]` in the Kordi CLI prints the URL
  and code, polls, and saves the session where the Kordi app keeps the
  session from browser sign-in (the `com.kordi.cloud-session` keychain item),
  with the app's installation key (`com.kordi.cloud-device-identity`, created
  when missing). Over SSH the login keychain may be locked; run
  `security unlock-keychain` first. If saving fails, the command revokes the
  new sign-in. `KORDI_CLOUD_API_BASE` and `KORDI_APP_CLIENT_ID` override the
  server and the client ID.
- The desktop app offers "Sign in with a code" on the wait screen when the
  system browser cannot be opened. A 404 from the code endpoint returns to
  browser sign-in with a short message.

## Tests

- `cargo test -p kordi-cloud-server --lib auth::routes::app_sign_in_handlers::tests::device_code -- --ignored --test-threads=1`
  with `DATABASE_URL` naming a disposable database: the end-to-end flow,
  denied, expired, reused and too-fast polls, hashed storage, the web session
  requirement, and the organization policy.
- `organizations::tests::settings` for the settings route.
- `cargo test -p kordi-cli kordi_device` for the CLI polling loop.
- `tests/deviceCodeSignIn.test.ts` and `tests/browserSignInGate.test.tsx` in
  `app/desktop` for the desktop client and screen.
