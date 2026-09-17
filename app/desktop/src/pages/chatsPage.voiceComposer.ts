import { useCallback, useEffect, useRef } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import { useVoiceMessageRecorder } from '@/features/chat/useVoiceMessageRecorder';
import { VOICE_MESSAGE_BODY_TEXT } from '@/features/chat/voiceTranscription';
import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { uploadNativeCloudAttachment } from '@/features/cloud/cloudAttachmentUpload';
import type { Conversation } from '@/kordi-app/types';

export function useVoiceComposer({
  conversation,
  cloudAccountId,
  onSend,
  focusComposer,
}: {
  conversation: Conversation;
  cloudAccountId: string | null;
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  focusComposer: () => void;
}) {
  const recorder = useVoiceMessageRecorder();
  const resetRecorder = recorder.reset;
  const sendingRef = useRef<symbol | null>(null);
  const cancelRecording = useCallback(() => {
    sendingRef.current = null;
    resetRecorder();
  }, [resetRecorder]);
  const prefetchesUpload = Boolean(
    cloudAccountId
      && (isCloudCollaborationConversationId(conversation.id) || conversation.directness === 'group'),
  );

  const handOff = useCallback((attachment: AttachmentItem, operation: symbol) => {
    if (!attachment.voiceMessage || sendingRef.current !== operation) return;
    let delivery: Promise<void> | void;
    try {
      // Voice sends immediately. Previews, notifications and search read the body until a transcript exists.
      delivery = onSend(VOICE_MESSAGE_BODY_TEXT, [attachment]);
    } catch {
      // No handoff occurred. Keep the recording if the caller rejects synchronously.
      recorder.recoverSend(attachment.id);
      return;
    }
    // The message sender owns its optimistic bubble, delivery status, and retry.
    // Release this draft immediately; a late result must never reset a new recording.
    recorder.reset();
    sendingRef.current = null;
    window.requestAnimationFrame(focusComposer);
    void Promise.resolve(delivery).catch(() => {});
  }, [focusComposer, onSend, recorder]);

  const sendPrepared = useCallback(async () => {
    if (sendingRef.current) return;
    const operation = Symbol();
    sendingRef.current = operation;
    try {
      const attachment = await recorder.prepareForSend();
      if (attachment) handOff(attachment, operation);
    } finally { if (sendingRef.current === operation) sendingRef.current = null; }
  }, [handOff, recorder]);

  const finishAndSend = useCallback(async () => {
    if (sendingRef.current) return;
    const operation = Symbol();
    sendingRef.current = operation;
    try {
      const attachment = await recorder.stop({
        onAttachmentReady: prefetchesUpload
          ? (ready) => {
              void uploadNativeCloudAttachment({
                path: ready.path,
                contentType: ready.mimeType,
              }).catch(() => undefined);
            }
          : undefined,
      });
      if (attachment) handOff(attachment, operation);
    } finally { if (sendingRef.current === operation) sendingRef.current = null; }
  }, [handOff, prefetchesUpload, recorder]);

  useEffect(() => () => cancelRecording(), [conversation.id, cancelRecording]);

  return {
    recorder: { ...recorder, reset: cancelRecording },
    surfaceActive: ['recording', 'review', 'error'].includes(recorder.state.phase),
    recording: recorder.state.phase === 'recording',
    sendPrepared,
    finishAndSend,
  };
}

export type VoiceComposerController = ReturnType<typeof useVoiceComposer>;
