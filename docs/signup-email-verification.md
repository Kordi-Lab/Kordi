# Email verification for password signup

Password signup requires proof that the person can read the supplied inbox.
The apps first request a code with `POST /v1/cloud/auth/signup/code` and an
`email` field. The response contains `verificationId`, `expiresAt`, and
`retryAfterSeconds`. It contains no code, account, or session. The person then
enters the six-digit email code. The apps submit `verificationId` and
`verificationCode` with the existing signup fields to
`POST /v1/cloud/auth/signup`.

Only successful verification creates the account, confirmed first device, and
session. The account's `primary_email_verified_at` is set in the same transaction
that consumes the code. This column also supports the OAuth email-linking checks
in the sign-in hardening work. Existing password accounts and sign-in remain
usable; this change does not certify previously claimed email addresses.

Codes expire after ten minutes, permit five guesses, and can be used once.
Requesting another code invalidates the previous challenge. A normalized email
can receive one code per minute and five per hour. The existing client address
request limiter also applies. Resend budgets, attempts, and consumption are
stored in Postgres so restarting a server or using another replica does not
reset them. The database stores HMAC digests, never plaintext codes. Codes are
bound to the challenge and email; account creation and consumption are atomic.

## Verifying an existing account's email

Accounts created with a password before signup verification existed have an
unverified primary email. Such an account can prove ownership while signed in:

1. `POST /v1/cloud/auth/email/verification/code` with an empty JSON body sends a
   six-digit code to the account's primary email. The response has the signup
   shape: `verificationId`, `expiresAt`, and `retryAfterSeconds`.
2. `POST /v1/cloud/auth/email/verification` with `verificationId` and
   `verificationCode` consumes the code and sets `primary_email_verified_at` in
   one transaction. It returns `204 No Content`.

Both routes require a session. Account payloads addressed to the signed-in
owner report the state as `primaryEmailVerified`: `GET` and `PATCH
/v1/cloud/auth/me`, and the `account` in signup, login, and OAuth sign-in
responses. Payloads describing other accounts, such as profiles and contacts,
omit it. Error codes:

| Status | `errorCode` | Meaning |
| --- | --- | --- |
| 400 | `email_missing` | The account has no primary email |
| 400 | `invalid_verification_code` | Wrong, expired, used, or unknown code; failed guesses still count |
| 409 | `email_already_verified` | Nothing to verify |
| 429 | `rate_limited` | A cooldown or budget applies; see `Retry-After` |
| 503 | `email_delivery_unavailable` | Mail is not configured or delivery failed |

Codes follow the signup rules: ten-minute expiry, five guesses, single use, one
send per minute and five per rolling hour, and a failed delivery refunds the send
budget. Challenges are stored per account in `cloud_account_email_codes` and are
bound to the challenge and the primary email it was sent to, so a code stops
working if the primary email changes. A send re-checks the account inside the
transaction that charges the send budget, so an account verified concurrently
gets `email_already_verified` and is not charged. The client address request
limiter applies first. Each account may then make ten requests or guesses per
hour across both routes; requests rejected by the address limiter or as
`email_missing`, `email_already_verified`, or unconfigured mail are not charged.

After verification, the existing provider-by-email linking applies: a Google or
GitHub sign-in whose provider-verified email matches the primary email joins
this account instead of being refused.

## Mail configuration and rollout

Set these private server environment values through the deployment secret store:

| Variable | Purpose |
| --- | --- |
| `KORDI_AUTH_SMTP_HOST` | SMTP submission host |
| `KORDI_AUTH_SMTP_PORT` | Submission port, defaults to 587 |
| `KORDI_AUTH_SMTP_USERNAME` | SMTP login |
| `KORDI_AUTH_SMTP_PASSWORD` | SMTP password or scoped provider credential |
| `KORDI_AUTH_SMTP_FROM` | Sender mailbox authorized by the email provider |
| `KORDI_AUTH_EMAIL_CODE_SECRET` | Independent random secret of at least 32 bytes, shared by every server replica |

SMTP uses required STARTTLS and bounded delivery timeouts. Use an authorized
transactional sender with the provider's domain authentication configured.
Keep the email code secret separate from SMTP credentials and session secrets.
Rotating it invalidates outstanding codes; the person can request another after
the resend cooldown.

The Kubernetes manifest reads these values from the optional `kordi-auth-email`
secret. The development compose stack accepts the same variables from its local
private environment. Use separate mail credentials and code secrets for each
environment. Never copy product credentials into development.

Deploy updated desktop and iPhone clients before enabling the new server's
signup enforcement. Older apps can still sign in, but their signup requests
receive `email_verification_required` with an instruction to update. Google and
GitHub sign-in remain available. Reconcile migration registration when combining
these changes with other pending schema changes.
Every serving replica must run the new server for verification to be enforced;
older server replicas can still accept unverified signup during a rolling update.

Missing or invalid SMTP settings or a short code secret make password signup
unavailable. Delivery failures return `email_delivery_unavailable`, retain the
resend budget, and make the failed challenge unusable. There is no unverified
fallback. Before a product rollout, verify that an email reaches a controlled
real inbox and that an incorrect or missing code cannot create an account.

## Validation

`cloud_auth_e2e::signup_email` exercises the HTTP flow with a private synthetic
mailbox on disposable Postgres: delivery, absent proof, wrong recipient, guess
exhaustion, expiry, resend replacement, hourly limits, unavailable delivery, and
concurrent reuse. `cloud_auth_e2e::account_email` covers verifying an existing
account's email the same way. Other authenticated API suites seed explicit
synthetic code proofs. Never run these fixtures against product or shared development data.
