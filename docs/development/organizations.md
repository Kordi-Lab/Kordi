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
personal organization. A writer that names an organization keeps it, which is
how a later organization selection will write. Migration 0164 indexes the
columns.

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
| `POST /v1/cloud/organizations/:id/members` | owner, admin | body `{accountId, role}`; `201 {member}` |
| `PATCH /v1/cloud/organizations/:id/members/:accountId` | owner, admin | body `{role}`; `200 {member}` |
| `DELETE /v1/cloud/organizations/:id/members/:accountId` | owner, admin | `204` |

Membership rules, checked under a lock on the organization row:

- Members cannot change members (`403 organization_forbidden`).
- A personal organization never changes (`409 personal_organization`).
- Only an owner adds an owner, changes an owner's role, or removes an owner
  (`403 organization_owner_required`).
- The last owner cannot be demoted or removed (`409 last_owner`).
- Other errors: `400 invalid_role`, `404 account_not_found`,
  `404 member_not_found`, `409 already_member`.
