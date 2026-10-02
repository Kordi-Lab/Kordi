# Contacts, blocking, and leaving groups

Kordi treats a contact as a two-way agreement. This page describes what each
person can do, what changes when a relationship ends, and the limits of the
current design. The server enforces every rule here; clients only present it.

## Becoming contacts

- You become someone's contact only when one of you sends a contact request
  and the other accepts it. Looking someone up by Kordi ID and sending a
  request do not need an existing relationship; requests share the per-account
  contact budget.
- If the other person already sent you a request, sending one back accepts
  theirs. Sending a second request while yours is pending returns the same
  request.
- The sender can withdraw a pending request. Only the sender can; anyone else
  is told the request does not exist. A request is decided exactly once:
  accepting a request that was just withdrawn (or withdrawing one that was just
  accepted) is refused with "This request was already answered or withdrawn."
- The older one-sided "add contact" action now sends a contact request instead
  of adding anyone. It accepts the other person's pending request when there is
  one.

Accepting a request lets the other person message you, add you to groups, see
when you are online, and ask your Kordi agent for help.

## What contacts allow

These need both people to be contacts (and neither to have blocked the other):

- appearing in each other's contact list and seeing each other's online status;
- starting a direct chat, a group, or an AI chat with the other person
  (chats with Kordi Support are exempt);
- adding the other person to a group, except that an admin may add someone who
  is already an active member of the same group space to one of its channels
  (never while either of them blocked the other);
- sending, editing, reacting, updating voice transcripts, changing the shared
  title, and calling in an existing direct chat, including a direct chat with
  another person's agent. An AI chat shared with another person follows the
  same rule, because nobody can leave it;
- asking the other person's default Kordi agent for help, anywhere: mentions,
  handoffs, follow-ups, and the agent reading chat context.

These do not need a contact relationship:

- messaging in a group you are an active member of;
- joining a group through an invite link you accept;
- using a custom agent its owner shared with conversation participants, inside
  a group you both belong to, unless either of you blocked the other.

Change from earlier releases: in groups joined through invite links, members
who are not contacts can no longer mention each other's default agents, and
default-agent handoffs between people who are not contacts are refused, both
for cloud agents and for agents running on the owner's desktop. Shared custom
agents still work in groups.

## Removing a contact

Either person can remove the other. Both directions of the relationship end at
once; the other person's contact list refreshes but they get no other notice.

- Your direct chat history stays readable for both of you.
- New messages, edits, reactions, voice transcript updates, shared title
  changes, and calls in that direct chat (or an AI chat you share) are
  refused. Removing your own reaction and deleting your own message still
  work. A ringing or active direct call between you ends.
- Online status stops in both directions, and neither can use the other's
  default agent.
- Groups you share are not affected.

To talk again, one of you sends a new contact request and the other accepts.

## Blocking

Your block list is private to you. You can block anyone except yourself and
Kordi service accounts (such as Kordi Support and PiP).

When you block someone:

- they are removed from your contacts, and any call between you ends;
- a pending request from them is declined and your pending request to them is
  withdrawn, without telling them;
- they cannot send you contact requests ("You can't send a contact request to
  this account"), and you must unblock them before sending one yourself;
- direct messages, direct calls, and writing in an AI chat you share are
  refused, neither of you can add the other to a group or a channel (or add
  them back after they leave one), online status is hidden both ways, and
  neither can use the other's default or shared agents;
- they cannot join a group through an invite link you created. Links created by
  other admins of that group still work for them;
- in groups you share, nobody is removed. You still see their messages
  (including their agents' messages), but you get no push notifications or
  desktop alerts for them, and their calls do not ring your devices. You can
  leave those groups.

Blocking does not send anything to Kordi. To tell us about a problem, use
Report.

Unblocking lets them send you a contact request again. It does not add them
back to your contacts.

The blocked person is never notified, but they may notice that their messages
and requests do not go through.

## Leaving a group

Any member, including the owner, can leave a group. Leaving the group's main
conversation leaves all of its channels. You stop getting its messages, it is
removed from your devices, and you can no longer read its history. Your open
invite links for the group are revoked.

If the owner leaves, another member becomes the owner: the one the owner's app
suggests, otherwise an existing admin, otherwise the earliest member who
joined. PiP stays in the group and never becomes its owner.

To come back you need an invite link from someone in the group. A member who
left can use any valid link, including the one they joined with. A member an
admin removed cannot reuse a link they already accepted.

## Reports

You can report a person, a contact request, or specific messages. Only the
messages you choose are included, copied by the server with details about any
attached files (never the files themselves). You must still be a member of the
conversation. Each account can send a limited number of reports per day. The
receipt shows a reference you can quote; reports are kept for up to 90 days
after they are closed. Only named Kordi operators can read report contents,
and every read is logged.

## Invite link previews

Anyone with a group or app invite link can see a preview without signing in.
Group previews show the inviter's display name and avatar, the group name, and
the number of people in it (PiP is not counted). They never include account
ids or Kordi IDs. Older accounts whose generated avatar is derived from their
account id show initials instead of that avatar. App invite previews still show
the inviter's Kordi ID so the recipient can find them.

## Existing contacts after the upgrade

Before this release, one person could add another without consent. On upgrade,
each one-way entry is converted once:

- if the other person had already shown consent (an accepted request between
  you, a pending request from them, or a message they wrote to you in your
  direct chat), the relationship becomes mutual;
- otherwise it becomes a pending contact request from the person who added
  the other, shown in the recipient's requests without a notification;
- entries involving Kordi service accounts, entries to yourself, and entries
  where the recipient had declined (or the sender had withdrawn) a request are
  removed.

Affected direct chats stay readable but become read-only until a request is
accepted. Every change is archived so it can be reverted (see the
[migration notes](../../bridges/cloud-server/migrations/README.md)).

## Known limitations

- A blocked person can infer the block from refused requests and messages.
- Invite links created by other admins still let someone you blocked join a
  group you are in; you can leave that group.
- After an owner leaves, apps show the original creator from the group's
  creation record, and admin controls for the new owner depend on the app
  applying the role from the leave update. Messaging keeps working either way.
- A member of two group spaces can still attach a conversation to the other
  space; leaving that space's main conversation then also leaves that
  conversation.
- Kordi service accounts cannot be blocked; contact requests to them have no
  effect.
