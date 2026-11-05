# Organizations

Organizations are the foundation for team workspaces. Records belong to an
organization rather than directly to an account, so later team features can
change what an organization holds without touching each member.

- Every account has exactly one **personal** organization. The account is
  its only member and its owner. It cannot gain members or lose its owner.
- A **team** organization can have many members. There is no route that
  creates one; a deployment defines team organizations, domain claims and
  join requests in its [admission file](organization-admission.md).

Nothing else changes: with every account in its personal organization, each
existing feature behaves as before.

## Schema

Migration 0162 adds:

- `cloud_organizations`: `organization_id` (`org_…`), `name`, `kind`
  (`personal` or `team`), `personal_account_id` (set only for a personal
  organization, unique, deleted with the account), `created_by_account_id`,
  and `created_at`.
- `cloud_organization_members`: `organization_id`, `account_id`, `role`
  (`owner`, `admin`, or `member`), and `joined_at`, one row per pair.

An `AFTER INSERT` trigger on `cloud_accounts` creates the personal
organization and its owner membership, so every account creation path is
covered, including built-in service accounts and older server replicas during
a rolling update. The migration backfills existing accounts. A trigger on the
members table refuses any member of a personal organization other than its
owner.

## Ownership

Migration 0163 adds a nullable `organization_id` to these tables and
backfills it from the owner column:

| Table | Owner column |
| --- | --- |
| `cloud_chat_conversations` | `created_by_account_id` |
| `cloud_agent_definitions` | `owner_account_id` |
| `cloud_agent_fallback_runs` | `owner_account_id` (the agent owner) |
| `scheduled_tool_tasks` | `owner_account_id` |
| `scheduled_tool_task_runs` | `owner_account_id` |
| `cloud_attachments` | `owner_account_id` |

A `BEFORE INSERT` trigger fills an empty `organization_id` with the owner's
personal organization. A writer that names an organization keeps it.
Migration 0164 indexes the columns.

## Choosing an organization for new content

Migration 0166 lets a client choose the organization that owns new content,
but only one the owner belongs to:

| Writer | Field | Owner checked |
| --- | --- | --- |
| `POST /v2/chat/conversations` | `organization_id` (group and AI chats; ignored for direct chats) | creator |
| `POST /v1/cloud/agents` | `organizationId` | owner |
| `POST /v1/cloud/scheduled-tasks` | `organizationId` | owner |

Leaving the field out keeps the personal organization. Naming an organization
the owner does not belong to, or one that does not exist, answers `403`. The
shared helper `organizations::selection::for_new_content` gives that answer;
a `BEFORE INSERT OR UPDATE OF organization_id` trigger on conversations,
agent definitions, scheduled tasks, and attachments refuses any writer that
skips it (constraint name `organization_member_owner`). A new channel joins
its group's organization. A retry that finds the conversation already created
keeps its first organization.

A conversation's owner is its active member with the owner role, or else its
creator. Conversation snapshots carry `organization: {organization_id, name}`
when a team owns the conversation and nothing for a personal one, so clients
can label team groups. Clients keep the selected organization per account on
the device; switching never changes the account, its sign-in, or local data.

Runs are charged to an organization when they are queued and checked again
when they are leased or start. A run in a team conversation goes to that team
while the conversation qualifies (see the rule below); otherwise a run keeps a
personal organization its writer named, or goes to the agent owner's personal
organization. A scheduled task run follows its task.

## Owner-eligibility rule

A team setting, `memberOwnedContent` (default off), says content in the team
must be owned by a member. When it is on:

- Handing a group to someone outside the team, or a member leaving, being
  removed, or reaching the end of a timed membership, moves the content they
  own to their personal organization. Everyone stays in the group: outsiders
  may still take part, and while the group qualifies its runs stay with the
  team.
- Turning the setting on moves content already owned by non-members.

With the setting off, content stays in the team when its owner leaves or is
outside it. Timed memberships end through the scheduled-task sweep; until the
sweep runs, an expired member already counts as outside the team.

Records that follow a parent are left without the column for now: messages,
members and other conversation children, run events, artifacts and documents,
subsessions, upload sessions, document shares, and session activity rows.
Per-account settings and data (memories, connectors, digests, devices,
contacts, Common ground) stay with the account. Desktop project discovery is
per device and has no server-side workspace record.

## API

All routes need a cloud session. An organization the caller does not belong
to answers `404 organization_not_found`, as if it did not exist.

| Route | Who | Result |
| --- | --- | --- |
| `GET /v1/cloud/organizations` | any account | `organizations`: each with `organizationId`, `name`, `kind`, `role` (the caller's), `memberCount`, `createdAt`; personal first |
| `GET /v1/cloud/organizations/:id` | member | `organization` |
| `GET /v1/cloud/organizations/:id/members?after=` | member | `members` (`accountId`, `displayName`, `role`, `joinedAt`), 200 per page by account id, and `nextAfter` |
| `PATCH /v1/cloud/organizations/:id` | owner, admin of a team | body `{name?, memberOwnedContent?}`; `200 {organization}` |
| `PATCH /v1/cloud/organizations/:id/members/:accountId` | owner, admin | body `{role}`; `200 {member}` |
| `DELETE /v1/cloud/organizations/:id/members/:accountId` | owner, admin | `204` |
| `POST /v1/cloud/organizations/:id/leave` | member of a team | `204` |
| `GET /v1/cloud/organizations/:id/invitations` | owner, admin | pending `invitations` |
| `POST /v1/cloud/organizations/:id/invitations` | owner, admin | body `{accountId, role, membershipExpiresAt?}`; `201 {invitation}` |
| `DELETE /v1/cloud/organizations/:id/invitations/:invitationId` | owner, admin | `204` |
| `POST /v1/cloud/organizations/:id/transfers` | owner, admin of both | body `{kind, id, targetOrganizationId}`, `kind` is `conversation`, `agent`, or `scheduledTask`; `200` |
| `GET /v1/cloud/organization-invitations` | any account | the caller's pending `invitations` |
| `POST /v1/cloud/organization-invitations/:id/accept` | the invitee | `200 {organization}` |
| `POST /v1/cloud/organization-invitations/:id/decline` | the invitee | `204` |
| `PUT /v2/chat/conversations/:id/owner` | the group owner | body `{client_operation_id, account_id}`: hands the group to another member, who becomes owner; the old owner becomes an admin |

Organization summaries also carry `memberOwnedContent` and the caller's
`membershipExpiresAt`; members carry `membershipExpiresAt`. An expired
membership no longer counts anywhere.

An account joins a team only by accepting an invitation. Inviting an account
that does not exist, a server-managed account, or a current member answers
the same `404 invitee_unavailable`. Invitations lapse after 14 days. An owner's
membership never expires.

Membership rules, checked under a lock on the organization row:

- Members cannot change members (`403 organization_forbidden`).
- A personal organization never changes (`409 personal_organization`).
- Only an owner adds an owner, changes an owner's role, or removes an owner
  (`403 organization_owner_required`).
- The last owner cannot be demoted, removed, or leave (`409 last_owner`).
  If the last owner's account is deleted, the longest-standing admin, or else
  member, becomes the owner.
- Moving content: the caller manages both organizations
  (`403 organization_forbidden`) and the content owner belongs to the target
  (`409 owner_not_member`).
- Other errors: `400 invalid_role`, `400 invalid_expiry`,
  `404 invitation_not_found`, `404 member_not_found`,
  `404 content_not_found`.
