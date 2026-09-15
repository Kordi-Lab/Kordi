# Voice transcription reliability

Stage 4 of #1512, tracked by #1516. Recorded voice is transcript-only agent input.
Kordi does not infer tone, speaker identity, or background sounds from a transcript.

## Contract

A voice block retains its original audio ID, duration, waveform, and transcript.
Optional `transcription` metadata contains `status` (`pending`, `ready`, `failed`,
`unavailable`), `sourceVersion`, `engine`, `language` when known, and `attempts`.
The current engine/settings revision is `apple-speech-v1`. Draft source versions
are opaque IDs; uploading binds the source version to the immutable audio ID.
Trimming creates a new source version. No local paths belong in this metadata.

Only a nonempty ready transcript from the matching source is speech. Failed,
pending, stale, and empty results cannot become spoken content. Older voice
messages with nonempty transcripts remain readable; the old literal failure
placeholder is treated as unavailable. Existing messages are not rewritten in a
bulk migration. Agent history reads interpret their current voice metadata.

## Recording and retry

On iOS, releasing Hold to Talk immediately hands the recording to the outgoing
message bubble. The composer clears without a review, trim, or second Send step.
Audio upload and the existing recognition task run concurrently; the bubble stays
pending until they resolve. Recognition failure or denied speech permission still
sends the saved audio with explicit failed/unavailable metadata. A fresh recorder
handles the next draft, so its cancellation cannot cancel the outgoing transcript.
Slide to cancel and slide to convert to text retain their separate behavior;
conversion waits for recognized text before inserting it into the text composer.

On macOS, click the microphone to start and click again to stop/send; holding and
releasing remains supported. Transcription has visible progress in the composer,
and failed recordings remain available for retry, playback, or discard. Sending
waits for a successful transcript. Once handed to the sender, the composer clears.
On both platforms, sending, sent, and delivery failure belong to the message
bubble and its retry controls. A late delivery result cannot reset the next draft.
There are at most three transcription attempts per source/range. A successful
result is reused for send retries; repeated Send presses cannot duplicate the
recording. Cancelling or replacing a recording discards pending results. iOS
recognition has a 30-second timeout per locale, and cancellation finishes the
recognition continuation. Locale fallback is bounded to the configured list;
it does not guarantee complete recognition of mixed-language recordings.

A sender can retry an older synchronized voice message without sending a new
message. The authenticated transcription update requires the message version
and original audio ID. It checks active membership, sender ownership, deletion,
personal hiding, visible attachments, source version, and attempt count. It
increments the existing message version and emits `message.updated`; duplicate
successful update requests are idempotent. A cached successful transcript is
not recomputed after an update-network failure. A different successful transcript
cannot overwrite an already-ready result through this retry endpoint.

The server accepts explicit failed/unavailable metadata for compatible clients.
Imported generic audio files are not automatically transcribed by this stage.
Only typed voice messages within the existing 60-second audio contract expose
retry. Browser-only clients show status and playback; native macOS/iOS perform
transcription. There is no background server transcription service.

## Native Mac encoding

The Mac recorder lets the AAC encoder select a bitrate compatible with the input
sample rate and channel count. A fixed 64 kbit/s setting rejects 16 kHz mono
headset input before recording starts. Native tests write and decode two seconds
of synthetic audio for that format and common 8/24/44.1/48 kHz mono/stereo inputs.
They use the production file-creation path without microphone capture.

## Validation

Use synthetic recordings and an isolated development backend. Do not use private
conversations or production data as fixtures.

- Record a short instruction, release, and verify the same words reach an agent
  with a transcript-only notice on macOS and iOS.
- On iOS, release while speech permission or recognition is pending. Verify an
  outgoing bubble appears immediately, no review panel appears, and a second
  recording can start. Deny speech permission and verify the audio is still sent.
- Deny microphone permission, then speech-recognition permission. Neither error
  may be sent as speech. A saved recording must remain available after a
  transcription failure.
- Try silence, mixed language, and an unavailable language. Status must be
  explicit; do not equate transport success with recognition accuracy.
- Retry twice, then verify the attempt limit. Repeated Send or retry clicks must
  share work. A successful result must not be transcribed again on send retry.
- Cancel during recognition and trim before retry. Late results must not update
  a new recording; a new range must get a new version.
- Retry an older voice message on both clients. Verify unchanged message ID,
  sequence, and audio ID, with a versioned update on the other device.
- Hide/delete the message, revoke membership, or change its version while the
  retry is pending. The server must reject the stale update.

Automated coverage is in the desktop voice tests, iOS VoiceTranscriptionTests,
Cloud voice metadata unit tests, and the database-backed chat-sync voice test.
Deterministic tests verify state, identity, authorization, and model-visible text.
They do not establish live recognition accuracy or a provider semantic benchmark.

## Group transport regression

The group envelope parser uses the shared portable voice parser for both drafts
and uploaded messages. Transcription status, source version, engine/settings
revision, locale, and attempt count survive outbox persistence and restoration,
upload completion, eager sends, wire serialization, and incoming history reads.
Local filesystem paths are excluded. Legacy messages without metadata retain
their transcript; malformed or stale metadata cannot become spoken content.

`voiceGroupTransport.test.tsx` covers all four states across the complete client
round trip, upload reuse, eager binding, stale metadata, and legacy compatibility.
A synthetic check against the isolated development API also verified persisted
metadata and peer history for all four states, versioned/idempotent retry, sender
authorization, and stale-version rejection. Its accounts, group, and audio object
were removed after verification. The check used synthetic accounts and generated audio.
