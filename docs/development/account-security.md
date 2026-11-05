# Account security endpoints

The account Security page on the web and the apps use these routes. Each one
accepts either an app's `Authorization: Bearer` session or the web session
cookie (see [Browser sign-in](browser-sign-in.md#page-api-contract)). Cookie
requests other than `GET` also need the exact public `Origin` and the
`X-Kordi-CSRF-Token` header. An app's access token is never accepted as a
cookie. Error bodies are `{"errorCode", "message"}`.

All paths start with `/v1/cloud/account/security`.

| Method and path | Purpose |
| --- | --- |
| `GET` | Email, password state, linked providers, and sessions. |
| `POST /sessions/:id/revoke` | Sign out one session (`asi_…` app sign-in or `cs_…` session). |
| `POST /sessions/revoke-others` | Sign out every other device and every other session. |
| `POST /password/code` | Email a confirmation code (accounts without a password only). |
| `POST /password` | Set a first password or change it. |
| `POST /email/change` | Send a code to a new email address. |
| `POST /email/change/verify` | Make the new address the primary email. |
| `DELETE /providers/:provider` | Unlink `google`, `github`, or `x`. |

## Overview

```json
{
  "email": { "address": "person@example.test", "verified": true },
  "password": { "set": true, "updatedAt": "2026-01-01T00:00:00+00:00" },
  "providers": [
    { "provider": "google", "email": "person@example.test", "emailVerified": true,
      "linkedAt": "2026-01-01T00:00:00+00:00" }
  ],
  "sessions": [
    { "id": "cs_…", "kind": "web", "deviceId": "dev_…", "deviceName": "Web browser",
      "createdAt": "…", "lastUsedAt": "…", "current": true },
    { "id": "asi_…", "kind": "app", "clientId": "kordi-desktop", "appName": "Kordi for Mac",
      "deviceId": "dev_…", "deviceName": "Studio Mac", "platform": "macos",
      "createdAt": "…", "lastUsedAt": "…", "current": false }
  ],
  "canManageOtherSessions": true,
  "recentSignIn": false
}
```

`kind` is `web` for a browser (no registered installation key) and `app`
otherwise. The current session is listed first.

## Rules

- The current session is never signed out by these routes
  (`cannot_revoke_current_session`); use sign out instead.
- Signing out a session on another device needs a confirmed current device,
  like other device management (`device_review_required`, reflected by
  `canManageOtherSessions`). `revoke-others` uses the device revocation path:
  other devices are revoked with their sign-ins and live connections, and
  other sessions on the current device end too.
- Proof for a password change or an email change: `currentPassword` when the
  account has a password. Without one, either a sign-in within the last ten
  minutes (`recentSignIn`; for an app, the sign-in's start, not the hourly
  token) or `verificationId` and `verificationCode` from `POST /password/code`.
  Missing proof answers `current_password_required` or
  `reauthentication_required`; a wrong password answers
  `invalid_current_password`.
- `POST /password` takes `newPassword` and applies the password rule
  (`weak_password`: at least 8 characters with an uppercase letter, a
  lowercase letter, and a number). Changing an existing password signs out
  every other session; the response carries `revokedSessions`. A code proof
  also marks the primary email verified.
- `POST /email/change` takes `newEmail` and the proof, and answers
  `{verificationId, expiresAt, retryAfterSeconds}`. An address that is another
  account's primary email or a provider-verified email of another account gets
  the same answer but no code, so the answer never reveals another account.
  `POST /email/change/verify` takes `verificationId` and `verificationCode`;
  the new address becomes the verified primary email. If another account took
  it in the meantime the answer is `email_not_available`.
- Unlinking the last way to sign in answers `last_sign_in_method`. A password
  counts as a way to sign in.
- Changes share a per-account budget of 30 per hour; password checks and email
  codes share a budget of 20 per hour (`rate_limited` with `Retry-After`).
- Audit events: `account.session.revoked`, `account.sessions.revoked_others`,
  `account.password_set`, `account.password_changed`,
  `account.security.password_check_failed`, `account.email_change.requested`,
  `account.email_changed`, `account.provider_unlinked`.

Codes live in `cloud_account_email_change_codes` and
`cloud_account_reauth_codes` (migration 0170) and follow the signup code rules:
ten-minute expiry, five guesses, one send per minute, five sends per hour.
