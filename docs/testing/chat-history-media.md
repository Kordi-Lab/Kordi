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

The reader fetches bytes on demand and does not return signed storage URLs.
Limits are 4 MiB per image and the shared image decoder's dimension/allocation
limits. Animated images, video, and unsupported formats fail explicitly; this
reader does not treat an animation's first frame as complete understanding.
Already-delivered model context is not retroactively erased by a later deletion.
