# Agent chat history and images

Shared conversation agents read synchronized history from the Cloud API. A
desktop execution lease carries the server-resolved conversation scope as
application metadata; it is never included in the model prompt. History reads
require the active executor, an unexpired lease, and current access for both the
agent owner and the requesting participant.

Recent context contains bounded text and stable attachment references. The
`read_session` tool supports:

- `index`: message IDs, timestamps, attachment IDs, MIME types, sizes, and message versions.
- `messages`: selected message text, with character offsets for long messages.
- `attachment`: one message ID, an attachment ID, and `expectedVersion` matching
  the reference's `messageVersion`; returns the actual static image as tool content.
- `participants`: the authorized participant directory.

Use `beforeSequence` to continue an older index or search page. Read available
history and inspect relevant attachments before requesting a repeat or re-upload.
Images already attached to an active runtime message remain in that message on
text follow-ups, until the existing compaction or shared-request boundary removes
them. A new live desktop screenshot must never replace an uploaded attachment.

## Manual regression

Use an isolated development account and synthetic images with different colors
and labels. Do not capture or publish real conversation content.

1. Send image A with an agent mention and ask the agent to describe it.
2. Send image B with "Compare this image with the previous one."
3. In a separate message, mention the agent without re-uploading either image.
4. Verify that history retrieval exposes both references and that attachment
   reads deliver both images before the comparison. Re-upload must not be required.
5. Repeat with cloud execution, and with the desktop's canonical session
   projection absent while synchronized chat data is available.
6. Edit a message, hide a message or attachment, delete it for everyone, and
   revoke membership. Stale versions must be refreshed; inaccessible content
   must not be returned, including when access changes during download.
7. In a contact chat, mention your own agent and then ask the contact to mention
   it. Both replies must remain in that contact chat without creating an Agent
   sidebar entry or a second unread badge. Repeat after reopening the client;
   previously cached shared replies must not become private agent chats.
8. In a private agent chat, upload an image without a question, then ask what it
   contains in a separate text message. The model request must retain the exact
   uploaded image in the original user message. It must not capture the current
   desktop as a substitute. Repeat with two distinct images and a comparison.

The reader fetches bytes on demand and does not return signed storage URLs.
Limits are 4 MiB per image and the shared image decoder's dimension/allocation
limits. Animated images, video, and unsupported formats fail explicitly; this
reader does not treat an animation's first frame as complete understanding.
Already-delivered model context is not retroactively erased by a later deletion.

## Cross-device attachment synchronization

Local private-agent history exports upload attachments before publishing the
message and persist the uploaded references for retries. Image-only messages
remain eligible for export and restore. Cloud publication contains attachment
IDs and display metadata, never a local filesystem path.

For affected old exports, the authenticated
`POST /v2/chat/conversations/:conversation_id/messages/:message_id/missing-images`
endpoint accepts an array of `{attachmentId, name}` records for finalized images
owned by the sender. It only accepts an untouched, attachment-free
`canonical-history-user` message in that owner's private AI conversation. It
increments the message version and emits `message.updated`, preserving its ID,
text, timestamp, and conversation sequence. Edited, deleted, already-attached,
and non-owned messages cannot be overwritten by this repair.

Verify a desktop text-plus-image message and an image-only message on iOS. Repeat
after a failed upload, a failed send, and a client restart. The same attachment
IDs must survive retries and images must remain associated with the original
message rather than appearing as a new message.

## Session coverage and lifecycle

| Session or execution path | Historical image source |
| --- | --- |
| Local private Agent, owned custom Agent, project, relationship | Canonical attachment references with bounded local-file reads |
| Synchronized private Agent and private Ask Agent | Account-authenticated server history; current membership and visibility |
| Direct contact, group, channel mention | Existing admitted execution lease and server history |
| Local child task and resumed shared task | Persisted admitted request identity; independently revalidated history permission |
| Cloud child or cloud fallback | Run-authorized server history |
| Archived local session | Read-only canonical history by exact session ID |

Local file reads resolve only stored attachment references inside managed
attachment storage. Pagination exposes a continuation sequence. Source versions
must match; missing, changed, or removed images are not replaced with guessed
filesystem paths or new screen captures.

At each new desktop turn, previously synchronized image inputs are checked
against current authorized history. Unavailable or changed image bytes are
excluded from the next model request; changed attachments can be retrieved again.
Previously returned tool images are also re-read on a later turn, rather than
replaying bytes after visibility changes. This can reduce prefix-cache reuse
across such mutations. Previously delivered text or model interpretations cannot
be retroactively erased from an external provider.

Background attachment uploads carry the expected account identity and preserve
cloud attachment IDs, media subtype, dimensions, and Live Photo resources. A
failure in one operation does not block unrelated messages. Explicit empty
attachment lists remove local mirrors; older versions cannot resurrect them.

Loaded, untouched private-history exports with provable original local images
are eligible for automatic backfill. The repair preserves message identity and
ordering. It never guesses missing originals, replaces edited/deleted messages,
or migrates unrelated sessions. New attachments in subsession chat messages,
voice understanding, and video/animation sampling remain separate feature work;
the existing text-only subsession composer does not claim to accept attachments.
