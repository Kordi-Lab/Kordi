# Organization on every request

Every account has one personal organization and may belong to team
organizations ([organizations.md](organizations.md)). A client acts in one
organization at a time. The server binds that organization into the access
token and checks it on every request, so a client that has not caught up with
a switch is told to refresh instead of acting in the wrong place. Switching
organization never switches the account, its sign-in, or its device.

## The organization claim

Each session row (`cloud_refresh_tokens`) carries `organization_id`, and each
browser sign-in (`cloud_app_sign_ins`) remembers the organization its next
access tokens get (migration 0171). An empty claim means the account's
personal organization, so every token issued before this change keeps
working as before.

The request organization is the claim while the account is still an active
member of it. When the member has been removed, or the membership has expired,
the request falls back to the personal organization and is treated as a
mismatch (below).

## Switching: `POST /v1/cloud/auth/organization-token`

Authenticated by the bearer access token (apps) or by the web session cookie
with the CSRF header (kordi.ai pages).

Request body (JSON): `{ "organization_id": "org_…" }` (`organizationId` is
accepted too).

The account must be an active member of the target organization; anything
else answers `404 organization_not_found`, the same answer for an organization
that does not exist.

`200` response:

| Field | Meaning |
| --- | --- |
| `access_token` | Access token bound to the target organization (bearer callers only) |
| `token_type` | `Bearer` (bearer callers only) |
| `expires_in` | Seconds until `access_token` expires (bearer callers only) |
| `account_id` | Always the caller's account |
| `device_id` | Always the caller's device |
| `sign_in_id` | The browser sign-in, when the caller's token came from one |
| `organization_id` | The organization now in the claim |

- **Browser sign-in tokens** (desktop and iOS): the server issues a new access
  token for the same sign-in and device and records the organization on the
  sign-in, so later refreshes keep it. The refresh token is not rotated and
  is not in the response. The previous access token keeps its own
  organization until it expires.
- **Older long-lived session tokens**: the claim on the same session row
  changes; `access_token` is the token the caller presented.
- **Web session cookie**: the claim on the cookie session changes; the cookie
  itself is unchanged and the body has no token.

Clients must check that `account_id` (and `sign_in_id` when they have one)
equal the credentials the switch started from, and keep the old token
otherwise.

## The `Kordi-Organization` header

Clients send `Kordi-Organization: <organization id>` on every request made
with a session. The session middleware compares it with the request
organization:

| Header | Result |
| --- | --- |
| equals the request organization | match |
| differs, or names an organization the account left | mismatch |
| missing on an organization-scoped route | mismatch |
| missing on an account route (profile, devices, contacts, organizations) | match |

In the current phase every mismatch is logged and the request continues (see
[Rollout](#rollout)). Once the server refuses mismatches, a mismatch answers:

```json
{
  "errorCode": "organization_mismatch",
  "message": "Your organization changed. Refresh and try again.",
  "organizationId": "org_…"
}
```

with status `409`. `organizationId` is the organization the token currently
acts in (the personal organization when the claimed membership is gone).
Clients already handle this answer: they refresh their organization state,
exchange the token when the selection differs, and retry the request once.

Organization-scoped routes are the chat (`/v2/chat/*`), agent definitions
(`/v1/cloud/agents*`), agent runs, scheduled tasks, and attachment routes. Every
other session route is an account route and will never refuse a mismatch, so a
client can always list its organizations and switch.

## Content checks

Requests that change existing content compare the content's organization
with the request organization:

- a group or AI conversation named in a `/v2/chat/conversations/:id/…` path
  (sending, editing and reacting to messages, titles, members, owner);
- an agent named in a `/v1/cloud/agents/:agent_id/…` path;
- a scheduled task named in a `/v1/cloud/scheduled-tasks/:task_id/…` path.

Personal content belongs to its owner's personal organization. Reads are not
checked, nor is per-member state (read and delivery cursors, personal titles).
Direct chats stay with their two people and are never checked. Content in an
organization the caller is not a member of (a team group the caller takes
part in as an outsider, or someone else's personal content) is left to the
usual participant rules. Attachments follow their conversation and get only
the token and header check.

New group and AI conversations, agents, and scheduled tasks are checked the
same way: the organization they name in their body, or the owner's personal
organization when they name nothing (unchanged default), is compared with the
request organization.

Grounding runs a request starts resolve their resource pool from the request
organization when they work outside a conversation, and from the
conversation's organization inside one. Nearby work the sweep queues later
uses the organization stored when it was created (a request's own, or the one
Nearby was turned on in) while the person still belongs to it; other
background work with no request uses the requester's personal organization.

## Rollout

1. Now: tokens carry the organization, clients switch with the exchange and
   send the header, and the server logs every mismatch (route, account,
   request organization, and the header or content organization) without
   refusing anything.
2. Later, once the logs are clean: a deployment flag makes the server answer
   mismatches with `409 organization_mismatch`. Before that, clients must
   switch organization before acting on team content they are a member of,
   and desktop sessions recorded in another organization must sync in that
   organization.
