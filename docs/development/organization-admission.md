# Organization admission

A deployment can define team [organizations](organizations.md) and how
people join them in one JSON file, without code changes. Everything specific
to an institution (domains, names, admins, copy) lives in that file and the
environment, never in this repository.

Without the file, nothing changes: every account keeps only its personal
organization.

## The file

`KORDI_ORGANIZATIONS_FILE` names a JSON file read at startup and reloaded
while the server runs (see [Reloading the file](#reloading-the-file)). Example
with synthetic values: [organization-admission.example.json](organization-admission.example.json).

Startup fails with a message naming the field when the file is invalid.
Unknown fields are rejected everywhere. `null` means undecided: an undecided
limit falls back to a bounded server default, never to unlimited.

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `personalOrganizations.pool` | Pool binding for personal organizations (read by pool work). |
| `organizations[].id` | Configuration id, 1-63 lowercase letters, digits or hyphens. Startup creates or updates one team organization per id (`cloud_organizations.config_id`). |
| `displayName` | Organization name, at most 120 characters; updated on every start and reload. |
| `state` | `disabled`: no domain claim, no auto-join, no join requests. `interim` and `active`: admission works. |
| `pool`, `targetPool` | Pool bindings, carried for pool work. Admission does not read them, and does not enforce that work bound to a missing pool is rejected: that belongs to the resource pool and pool worker changes. |
| `admission.claimedDomains` | Lowercase domains, at most 20. |
| `admission.domainMatch` | `exact` (the domain only) or `subdomains` (the domain and its subdomains; lookalike domains never match). |
| `admission.requireGoogleHostedDomain` | Google sign-in also needs the ID token's `hd` in a claimed domain. |
| `admission.autoJoinMethods` | Which verified evidence joins: `google`, `email_code`, `github`. GitHub joins only when listed. |
| `admission.reverifyIntervalMonths` | 1-120, or `null` for no re-verification. |
| `admission.googleSignInReverifies` | Whether a qualifying Google sign-in renews a membership. When `false`, Google joins only an account never admitted before; renewing needs an email code. |
| `admission.stripSubaddress` | Optional, default `true`: `local+tag@domain` counts as `local@domain` for the one-account-per-inbox rule. |
| `admission.joinRequests.enabled` | Whether accounts may ask to join. |
| `admission.joinRequests.approval` | Must be `organization_admins` (owners and admins of the organization). |
| `admission.joinRequests.fields[]` | Up to 10 fields: `key` (letters, digits, underscores), `label`, `required` (`null` = not required), `maxLength` (1-4000, `null` = 1000). |
| `admission.joinRequests.retentionDays` | 1-365; requests and their field values are deleted this long after submission. Required while enabled; `null` while disabled purges after 30 days. |
| `admission.joinRequests.approvedMembershipExpiry` | `"set_by_approver"` or `null` (undecided): the approver may give `expiresAt`, otherwise the membership ends after `reverifyIntervalMonths`, and without an interval `expiresAt` is required. A number (1-3650) sets that many days. Approved memberships always end. |
| `membership.requireMemberOwner`, `outsidersAllowed`, `workEndBoundSeconds` | Carried for ownership and pool work; admission does not enforce them. |
| `adminsEnv` | Name of an environment variable holding a JSON array of admins: account ids (`acct_…`, the stronger option) or emails. Required for `interim` and `active`; the value is never logged. |
| `entryPage.title`, `summary`, `joinLabel`, `notOpenText` | Copy for the account page. |

## Admins

Startup grants `admin` to every listed account id
(`cloud_organization_members.configured_admin`). A listed email is granted
only at a sign-in that proves it under the organization's own rules: an
email code, or an auto-join method that passes the hosted-domain rule (so
GitHub, or Google without a matching `hd`, does not count unless the rules
admit it). The grant records that email and lasts while it is listed.
Account ids are the stronger option because they do not depend on email
proof.

A disabled organization has no configured admins. An account dropped from
the list loses the flag, and its membership unless an admission still backs
it; owners keep their role. Configured admins never lapse and cannot be
removed through the members API.

## Domain claims

The server evaluates every configured organization when it has verified an
email itself:

- Google sign-in: the userinfo email. With the `openid` scope Google's token
  response carries an ID token; its issuer, audience, expiry and subject are
  checked (it comes straight from Google's token endpoint over TLS), the
  email counts as verified only when the token agrees (`email_verified` and
  the same email), and its `hd` is stored on
  `cloud_account_identities.hosted_domain`. A token that fails these checks
  fails the sign-in. Without a token there is no `hd`.
- GitHub sign-in: the primary verified email.
- Sign-up with an email code, and verifying the primary email with a code.
- An organization email code (below), for an email other than the primary one.

Evidence admits when the organization is not `disabled`, the email is
verified, its domain is claimed, the method is in `autoJoinMethods`, and for
Google the `hd` rule holds. Unverified or forged emails never join. One
active domain-claim membership per inbox and organization (see
`stripSubaddress`).

A sign-in hook never fails a sign-in: errors are logged and nothing is
granted.

## Re-verification and expiry

`cloud_organization_admissions` records how each account was admitted
(`domain_claim` or `join_request`), the verified email, method, approver,
`verified_at` and `expires_at`. A qualifying verification renews
`verified_at`. A membership ends when `verified_at` plus the interval passes
(domain claims) or `expires_at` passes (approvals): the record keeps
`lapsed_at` and `lapse_reason`, the membership row is removed, and an
`organization.membership_lapsed` audit event is written. A worker sweeps
hourly; the account endpoint also expires the caller's membership when it
is due before answering, and otherwise only reads. Due times are computed in
UTC. All memberships end in `store::end_membership`, the one
place for rules that follow a membership's end, such as moving owned content
back to the owner's personal organization.

## Members API on configured organizations

The generic members routes cannot add members to an organization from the
file or change roles there (`409 configured_organization`): membership comes
from admission and admins from the file. Removing a member lapses their
admission (`removed`) and frees their verified email; sign-in does not bring
them back, and only an approved join request admits them again.

## Organizations removed from the file

At startup, organizations with a configuration id no longer in the file are
retired: every admission lapses (`organization_removed`), every membership
except owners ends, configured admins lose their flag, and join requests are
purged after 30 days. The hourly sweep repeats this, also when the file is
unset. Adding the id back reopens it; former members join again by the
normal rules.

## Reloading the file

The server reloads the file on `SIGHUP` and within about 5 seconds of the file
or its signature changing. A reload that cannot be read, is not signed when a
signing key is set, or is invalid is logged and changes nothing.

Sign-in critical keys decide who gets in; a reload may only narrow them:

| Key | Narrower means |
| --- | --- |
| `state` | `disabled` (from `interim` or `active`; switching between those two applies) |
| `admission.claimedDomains` | a subset |
| `admission.domainMatch` | `exact` |
| `admission.requireGoogleHostedDomain` | `true` |
| `admission.autoJoinMethods` | a subset |
| `admission.reverifyIntervalMonths` | a smaller number (`null` is unbounded) |
| `admission.googleSignInReverifies` | `false` |
| `admission.stripSubaddress` | `true` |
| `admission.joinRequests.enabled` | `false` |
| `admission.joinRequests.approvedMembershipExpiry` | fewer days; any other change counts as widening |
| `membership.requireMemberOwner` | `true` |
| `membership.outsidersAllowed` | `false` |
| `membership.workEndBoundSeconds` | a smaller number; any change to or from `null` counts as widening |
| admins from `adminsEnv` | a subset of account ids and of emails |
| `organizations[]` | removing an organization (retired at once, as at startup) |

A change that widens one of these keys does not take effect: the key keeps its
running value until the next restart, and the server logs
`reload kept organizations[<id>].<key>: widening needs a restart (<diff>)`.
Admins are counted in the diff, never named. Adding an organization also waits
for a restart. Narrowed keys are logged as `reload narrowed ...`. Ordinary
keys (`displayName`, `pool`, `targetPool`, `personalOrganizations.pool`,
`entryPage`, join-request `fields` and `retentionDays`) always apply.

The resource pool reload reads `pool`, `targetPool` and `state` from the same
file for pool bindings only; it never admits anyone.

## Signed file

When `KORDI_ORGANIZATIONS_SIGNING_KEY` is set to an Ed25519 public key
(standard base64 of its 32 raw bytes), the file needs a detached signature in
`<file>.sig`: the standard base64 Ed25519 signature of the file's exact bytes.
An unsigned or badly signed file stops startup and is refused on reload. A
set but malformed key is an error, never a disabled check. Changing the key
needs a restart.

With OpenSSL 3, from a private key kept outside the server:

```sh
openssl genpkey -algorithm ed25519 -out organizations-signing.pem
openssl pkey -in organizations-signing.pem -pubout -outform DER | tail -c 32 | base64
openssl pkeyutl -sign -inkey organizations-signing.pem -rawin \
  -in organizations.json | base64 > organizations.json.sig
```

## Verified provider emails

A Google or GitHub identity joins an existing account by email only when the
provider verified that email (Google: `email_verified` in both userinfo and the
ID token; GitHub: the verified primary email) and the account's own primary
email is verified. Otherwise the sign-in is refused with
`oauth_email_requires_sign_in`. This rule governs new links only: an identity
that is already linked keeps signing in to its account, whether or not that
account's primary email is verified.

Once linked, an identity never moves to another account. Each identity keeps
the email it may be matched by (`cloud_account_identities.matching_email`).
When the provider reports a different email, or stops verifying it, the link
stays but that email is no longer evidence: it does not prove the account's
primary email and does not admit to organizations. The change is written to the
account's security log (`auth.identity.email_changed` or
`auth.identity.email_unverified`, provider only). Proving the new address with
a Kordi email code (account email or organization email code) makes it the
matching email again (`auth.identity.email_reverified`).

Managed devices can pin the apps to configured organizations; see
[managed-devices.md](managed-devices.md).

## API

The join-request admin routes need a bearer cloud session, like the other
organization routes. The four `/v1/cloud/account/organizations` routes also
accept the web session cookie (`__Host-kordi_web_session`), so the kordi.ai
pages can call them same-origin with `credentials: 'same-origin'`:

- A request with an `Authorization` header takes the bearer path unchanged.
- Otherwise the cookie must name a web session; an app's access token there
  is refused (`403 web_session_required`). Without one: `401 login_required`.
- Every `POST` also needs the exact public `Origin` (`403 origin_mismatch`)
  and the CSRF token from `__Host-kordi_web_csrf` in `X-Kordi-CSRF-Token`
  (`403 csrf_token_invalid`), as on the `/v1/cloud/auth/web/*` routes.
- Responses through the cookie path are marked `no-store`.

| Route | Result |
| --- | --- |
| `GET /v1/cloud/account/organizations` | `organizations` (as `GET /v1/cloud/organizations`) and `configured`: per configured organization `id`, `organizationId`, `displayName`, `state`, `admission`, `joinOptions {emailCode, joinRequest}`, `claimedDomains`, `joinRequestFields`, `joinRequest {requestId, status, createdAt}` (open request), `verifiedAt`, `reverifyBy`, `expiresAt`, `entryPage`. |
| `POST /v1/cloud/account/organizations/:id/email-code` | `{email}` in a claimed domain; sends a code; returns `{verificationId, expiresAt, retryAfterSeconds}`. |
| `POST /v1/cloud/account/organizations/:id/email-code/verify` | `{verificationId, verificationCode}`; joins or renews; returns `{configured}`. |
| `POST /v1/cloud/account/organizations/:id/join-requests` | `{fields: {key: value}}`; `201 {joinRequest}`. |
| `GET /v1/cloud/organizations/:organizationId/join-requests?status=pending` | Owners and admins: `joinRequests` (`requestId`, `accountId`, `displayName`, `verifiedEmail`, `fields`, `status`, `createdAt`, `decidedAt`) and the configured `fields`. |
| `POST /v1/cloud/organizations/:organizationId/join-requests/:requestId/approve` | Optional `{expiresAt}` per `approvedMembershipExpiry`; adds the member. |
| `POST /v1/cloud/organizations/:organizationId/join-requests/:requestId/reject` | Rejects. A rejected request blocks another until it is purged. |

`admission` is one of `not_open` (disabled; show `notOpenText`), `join`,
`pending`, `rejected` (another request is possible once this one is
purged), `member`, `reverify` (a member within 30 days of `reverifyBy`),
`lapsed`, or `unavailable` (open, but no join path for the caller).
`joinOptions` lists only paths that would succeed for the caller.

Errors: `404 organization_not_found`, `409 organization_not_open`,
`403 email_code_not_accepted`, `403 email_not_claimed`, `400 invalid_email`,
`400 invalid_verification_code`, `409 organization_email_in_use`,
`409 join_requests_closed`, `400 invalid_join_request`, `409 already_member`,
`409 join_request_exists`, `403 organization_forbidden`,
`404 join_request_not_found`, `400 invalid_expiry`, `400 invalid_body`,
`400 expiry_required`, `403 membership_removed`,
`409 configured_organization`, `409 configured_admin`, `429 rate_limited`,
`503 email_delivery_unavailable`.

Startup warns when a `subdomains` claim looks like a public suffix (for
example a two-label domain starting with `ac.` or `co.`).

## Schema

Migration 0167 adds `cloud_organizations.config_id` (unique, team only),
`cloud_organization_members.configured_admin` and `configured_admin_email`,
`cloud_account_identities.hosted_domain`, `cloud_organization_admissions`,
`cloud_organization_join_requests`, and `cloud_organization_email_codes`
(same rules as the account email codes). Migration 0173 adds
`cloud_account_identities.matching_email`, filled from verified provider
emails.
