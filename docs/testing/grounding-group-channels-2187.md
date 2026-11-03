# Grounding group channels and source dates

Refs #2187, #2190 and #2202 observations O08 and O14.

Investigation starts at main `ab90e69d32e99f20e7ea4ddf8219df7b15c409bb`.
The existing channel-creation flow from #1451 opens a new group conversation.
That endpoint requires every participant to be the creator's contact. Grounding
invitations can establish group membership without a contact relationship, so
an otherwise valid group owner receives a denial.

The group-scoped channel endpoint uses the established group's membership,
not client claims or contact relationships. It preserves the group title and
member roles, admits active members, rejects outsiders and removed members,
and scopes idempotency to the source group. A regular member remains a regular
member in the new channel.

This preserves the current active-member policy in
`authorize_group_space_attachment`; it does not infer an owner-only creation
policy from the separate owner/admin-only rename operation. The member's
Create channel entry remains appropriate. No new contact is created and no
additional person can be admitted by creating a channel.

Synthetic database regressions cover owner, admin and member creation without
contacts, role inheritance, outsider/removed-member denial, replay, and attempts
to reuse a channel identity across groups. The original general-conversation
path is explicitly checked to reject the same non-contact roster.

The date observation has a separate cause: build gathering truncated source
instants to UTC dates, while the Mac rendered card build instants in local time.
New builds retain RFC 3339 source instants for Notes, links, memories, connectors,
and owned documents. Date-only source values remain dates. No migration attempts
to infer timestamps lost in previously built cards. Desktop regressions compare
source, topic and build labels across a UTC day boundary in Los Angeles.

These checks are isolated synthetic regressions. They do not establish the exact
cause of every historical native symptom, exercise the existing three-client
setup, or claim production validation. No shared backend deploy/restart or
account/history/connection changes are part of this work.
