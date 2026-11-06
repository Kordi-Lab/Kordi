# Sign in with Apple

Kordi offers Sign in with Apple on the web login and sign-up pages, next to
Google and GitHub (App Store Review guideline 4.8). The Mac and iOS apps reach
it through the [app sign-in hand-off](browser-sign-in.md): the app opens
`/v1/cloud/auth/app/authorize`, the browser lands on the web login page, the
person continues with Apple, and the page then approves the app as it does
after any other sign-in. The apps have no Apple button of their own.

The provider ID is `apple`. The server lists it in
`GET /v1/cloud/auth/capabilities` (`oauthProviders`) only when its
configuration is complete.

## Starting from the web page

The page links (a top-level navigation, not `fetch`) to:

```
GET /v1/cloud/auth/web/oauth/apple/start?returnTo=<path>
```

`returnTo` is a path on the public origin, default `/sign-in/app`. On the
login page of the app hand-off, pass the page's own path and query (for
example `/login?client_id=...&state=...`) so the browser returns to the same
authorization. The start sets the `__Host-kordi_oauth_bind` cookie and sends
the browser to Apple. Afterwards the browser comes back to `returnTo`:

- signed in: with the web session cookie set and nothing in the URL. The page
  reads the session from `GET /v1/cloud/auth/web/session` and continues (for
  the hand-off, asks the person to approve the app);
- not signed in: through `/v1/cloud/auth/web/oauth/complete`, with
  `#kordi_cloud_oauth_error=<message>` and, for known cases,
  `kordi_cloud_oauth_error_code=<code>` (for example
  `oauth_email_requires_sign_in`, `oauth_browser_mismatch`) in the fragment.
  A canceled Apple page gives the message "Sign-in was canceled.".

This is the same contract as Google and GitHub; only the provider in the path
changes.

## How the server finishes it

The start sends the browser to Apple with `response_mode=form_post`,
`scope=name email`, the state, and a nonce derived from the state's secret
verifier. Apple posts `code`, `state`, and on the first authorization `user`
(the name) to `POST /v1/cloud/auth/oauth/apple/callback`. That cross-site
`POST` carries no `SameSite=Lax` cookie, so the server stores the code and name
with the state and answers `303` to
`GET /v1/cloud/auth/oauth/apple/callback?state=...`. That navigation carries
the binding cookie, and the callback finishes like Google and GitHub: it
exchanges the code at `https://appleid.apple.com/auth/token` with an ES256
client secret, verifies the identity token, and signs the person in. A code in
the `GET` URL is ignored for Apple. The Apple flow sends no PKCE parameters;
the nonce binds the code to its state. The legacy
`GET /v1/cloud/auth/oauth/apple/start?redirectAfter=...` works too, for
loopback and allowlisted app targets.

The identity token is checked against Apple's keys
(`https://appleid.apple.com/auth/keys`, cached for an hour and refetched when
a token names an unknown key): issuer `https://appleid.apple.com`, audience
the Services ID, expiry and issue time, and the nonce.

Apple sends the name only on the first authorization; it becomes the new
account's display name. The email comes from the identity token. A verified
Apple email joins an existing account with the same verified email, like
Google. A private relay address (`@privaterelay.appleid.com`) never joins an
existing account.

## Token revocation

Each code exchange stores Apple's refresh token in `cloud_apple_tokens`,
sealed with the provider-auth cipher
(`KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY`). Without that key no token is
kept and nothing can be revoked, so set it wherever Apple is enabled.
`crate::auth::oauth::apple::revoke_apple_tokens_for_account(&state, account_id)`
sends every stored token to `https://appleid.apple.com/auth/revoke` and deletes
the revoked rows; tokens that fail are kept and counted. Account deletion calls
it before its transaction. Tokens it could not revoke move, in the deletion
transaction, to `cloud_apple_token_revocations`, which keeps no account ID. A
background worker retries them with backoff, up to one day apart, and drops a
token after 24 failed attempts (about two weeks). Unlinking Apple in account
security calls it after the identity is removed.

## Server configuration

| Variable | Value |
| --- | --- |
| `KORDI_OAUTH_APPLE_CLIENT_ID` | The Services ID. |
| `KORDI_OAUTH_APPLE_TEAM_ID` | The Apple Developer team ID. |
| `KORDI_OAUTH_APPLE_KEY_ID` | The Sign in with Apple key ID. |
| `KORDI_OAUTH_APPLE_PRIVATE_KEY` | The `.p8` key: PEM text (real or `\n` line breaks) or the PEM base64-encoded. |

Apple is available when all four are set and the key parses. Distribution
profiles bind them through the optional `authentication.oauthBindings` fields
`appleClientId`, `appleTeamId`, `appleKeyId` and `applePrivateKey` (see
[distribution configuration](../distribution-configuration.md)). Keep every
value in the deployment's secret store, never in Git.

## Apple Developer setup (owner)

The apps never call Apple themselves, so they need no Sign in with Apple
entitlement and no capability in Xcode. The portal still groups the Services
ID and the key under one primary App ID that has Sign in with Apple enabled.

1. Under Identifiers, pick the primary App ID (an existing team App ID) and
   enable Sign in with Apple on it as a primary App ID. If that App ID ships
   an app, its provisioning profiles may need regenerating; the app itself
   does not change.
2. Create a Services ID for the web login, enable Sign in with Apple on it,
   group it with that primary App ID, and add:
   - the domain of the public origin (for example `kordi.ai`), and
   - the return URL `<origin>/v1/cloud/auth/oauth/apple/callback`. The web
     start and the legacy start share this one callback. Add one domain and
     return URL per environment origin (production, staging).
3. Under Keys, create a key with Sign in with Apple enabled for that primary
   App ID. Download the `.p8` once and note its key ID.
4. Give the server the Services ID, team ID, key ID and `.p8` contents,
   together with `KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY`.

Apple requires an `https` return URL on a registered domain, so a loopback
development stack cannot complete the flow; use a hosted staging origin.
