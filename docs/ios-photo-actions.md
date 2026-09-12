# Per-photo message actions

An image group remains one message, but each image has its own long-press target,
reaction state, and delete action. Captions are independent preview targets and
remain present when a photo is deleted. Expanded groups move only the held photo.

The client uses these additive chat v2 endpoints:

- PUT or DELETE /v2/chat/conversations/:conversation_id/messages/:message_id/attachments/:attachment_id/reactions
  with { "reaction": "…" }.
- DELETE /v2/chat/conversations/:conversation_id/messages/:message_id/attachments/:attachment_id?for_everyone=false.

Deleting for everyone requires the message sender. Deleting for oneself hides
only that photo for that account, including in history, bootstrap, thread pages,
and replayed sync events. Deleting the last photo removes a photo-only message;
a caption or other content keeps the message present. Live Photo companion
resources are removed with their photo, unless another attachment still uses them.

Message snapshots may include attachment_reactions, an array of
{ "attachment_id": "…", "reaction": "…", "account_ids": ["…"] }.
Message-level reactions retain their existing meaning. Older clients may ignore
the additional field; the new client never falls back to a whole-message delete
or reaction if the attachment endpoint is unavailable.

The server update requires migration 0091_chat_attachment_actions.sql.
Client rollout for real conversations depends on that server update. Offline Beta
preview data exercises the same client interactions without a network service.

For manual checking, launch Beta with
--preview-data --preview-contact-chat --preview-menu-test-chat. The sample chat
contains long messages, formatted text and blob emoji, voice, single photos,
and grouped photos with captions.

The menu uses separate motion phases: press feedback starts after 120 ms, a
stationary hold activates after 320 ms, the preview enters with a 300 ms spring,
and dismissal returns it over 200 ms. Releasing early or scrolling cancels the
press feedback without opening a menu. Reduced Motion uses gentle fades.

Photo deletion uses the same particle renderer as whole-message deletion. The
client retains the original row while the request completes, waits for the menu
to return and the source to be displayed, then captures and hides only the chosen
photo. Remaining photos and the caption reflow when the particle animation starts.
A failed deletion leaves the message visible. Reduced Motion keeps the fade fallback.

The window host keeps reaction and action controls above the text-selection
passthrough region. Tall previews can extend behind the reaction shelf, but taps
on quick reactions and the expanded picker must stay in the menu host. The hit
regions update directly with overlay layout and preview scrolling. Tapping one's
existing reaction removes it directly; opening the picker is optional.
