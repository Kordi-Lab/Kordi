# Organization admission

A deployment can define team [organizations](organizations.md) and how
people join them in one JSON file, without code changes. Everything specific
to an institution (domains, names, admins, copy) lives in that file and the
environment, never in this repository.

Without the file, nothing changes: every account keeps only its personal
organization.

## The file

`KORDI_ORGANIZATIONS_FILE` names a JSON file read once at startup. Example
with synthetic values: [organization-admission.example.json](organization-admission.example.json).

Startup fails with a message naming the field when the file is invalid.
Unknown fields are rejected everywhere. `null` means undecided: an undecided
limit falls back to a bounded server default, never to unlimited.

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `personalOrganizations.pool` | Pool binding for personal organizations (read by pool work). |
| `organizations[].id` | Configuration id, 1-63 lowercase letters, digits or hyphens. Startup creates or updates one team organization per id (`cloud_organizations.config_id`). |
| `displayName` | Organization name, at most 120 characters; updated on every start. |
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
| `membership.requireMemberOwner` | Sets the organization's owner-eligibility rule (`memberOwnedContent`, see [organizations](organizations.md)). |
| `outsidersAllowed`, `workEndBoundSeconds` | Carried for pool work; admission does not enforce them. |
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
(same rules as the account email codes).
