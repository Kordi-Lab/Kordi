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
| `pool`, `targetPool` | Pool bindings, carried for pool work. Admission does not read them. |
| `admission.claimedDomains` | Lowercase domains, at most 20. |
| `admission.domainMatch` | `exact` (the domain only) or `subdomains` (the domain and its subdomains; lookalike domains never match). |
| `admission.requireGoogleHostedDomain` | Google sign-in also needs the ID token's `hd` in a claimed domain. |
| `admission.autoJoinMethods` | Which verified evidence joins: `google`, `email_code`, `github`. GitHub joins only when listed. |
| `admission.reverifyIntervalMonths` | 1-120, or `null` for no re-verification. |
| `admission.googleSignInReverifies` | Whether a qualifying Google sign-in renews a membership. When `false`, Google joins only an account never admitted before; renewing needs an email code. |
| `admission.joinRequests.enabled` | Whether accounts may ask to join. |
| `admission.joinRequests.approval` | Must be `organization_admins` (owners and admins of the organization). |
| `admission.joinRequests.fields[]` | Up to 10 fields: `key` (letters, digits, underscores), `label`, `required` (`null` = not required), `maxLength` (1-4000, `null` = 1000). |
| `admission.joinRequests.retentionDays` | 1-365; requests and their field values are deleted this long after submission. Required while enabled; `null` while disabled purges after 30 days. |
| `admission.joinRequests.approvedMembershipExpiry` | `null` (approved memberships do not expire), `"set_by_approver"` (approval may give `expiresAt`), or a number of days (1-3650). |
| `membership.requireMemberOwner`, `outsidersAllowed`, `workEndBoundSeconds` | Carried for ownership and pool work; admission does not enforce them. |
| `adminsEnv` | Name of an environment variable holding a JSON array of admins: account ids (`acct_…`) or emails. Required for `interim` and `active`; the value is never logged. |
| `entryPage.title`, `summary`, `joinLabel`, `notOpenText` | Copy for the account page. |

## Admins

Startup grants `admin` to every listed account id and to accounts whose
verified primary email is listed (`cloud_organization_members.configured_admin`).
A listed email that signs up later becomes admin at its next verified sign-in.
An account dropped from the list loses the flag, and its membership unless an
admission still backs it. Configured admins never lapse.

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
active domain-claim membership per email and organization.

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
hourly; the account endpoint also expires the caller's due memberships
before answering. All memberships end in `store::end_membership`, the one
place for rules that follow a membership's end, such as moving owned content
back to the owner's personal organization.

Removing a domain-claim member through the members API does not block them:
their next qualifying sign-in joins again.

## API

All routes need a cloud session.

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
`pending`, `member`, `reverify` (a member within 30 days of `reverifyBy`),
`lapsed`, or `unavailable` (open, but no join path for the caller).

Errors: `404 organization_not_found`, `409 organization_not_open`,
`403 email_code_not_accepted`, `403 email_not_claimed`, `400 invalid_email`,
`400 invalid_verification_code`, `409 organization_email_in_use`,
`409 join_requests_closed`, `400 invalid_join_request`, `409 already_member`,
`409 join_request_exists`, `403 organization_forbidden`,
`404 join_request_not_found`, `400 invalid_expiry`, `400 invalid_body`,
`429 rate_limited`, `503 email_delivery_unavailable`.

## Schema

Migration 0166 adds `cloud_organizations.config_id` (unique, team only),
`cloud_organization_members.configured_admin`,
`cloud_account_identities.hosted_domain`, `cloud_organization_admissions`,
`cloud_organization_join_requests`, and `cloud_organization_email_codes`
(same rules as the account email codes).
