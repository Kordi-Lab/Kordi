import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import { useVoiceMessageRecorder } from '@/features/chat/useVoiceMessageRecorder';
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
  const gestureRef = useRef<{
    pointerId: number;
    recorderStarted: boolean;
    released: boolean;
    startedAt: number;
    tap: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const sendingRef = useRef<symbol | null>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const cancelRecording = useCallback(() => {
    sendingRef.current = null;
    cleanupRef.current();
    gestureRef.current = null;
    suppressClickRef.current = false;
    resetRecorder();
  }, [resetRecorder]);
  const prefetchesUpload = Boolean(
    cloudAccountId
      && (isCloudCollaborationConversationId(conversation.id) || conversation.directness === 'group'),
  );

  const handOff = useCallback((attachment: AttachmentItem, operation: symbol) => {
    const transcript = attachment.voiceMessage?.transcript.trim();
    if (!transcript || sendingRef.current !== operation) return;
    let delivery: Promise<void> | void;
    try {
      delivery = onSend(transcript, [attachment]);
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

  const finishGesture = useCallback(async () => {
    const gesture = gestureRef.current;
    if (!gesture?.released || !gesture.recorderStarted) return;
    gestureRef.current = null;
    if (gesture.tap) recorder.lock();
    else await finishAndSend();
  }, [finishAndSend, recorder]);

  function beginGesture(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    suppressClickRef.current = true;
    const gesture = {
      pointerId: event.pointerId,
      recorderStarted: false,
      released: false,
      startedAt: performance.now(),
      tap: false,
    };
    gestureRef.current = gesture;
    const cleanup = () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      cleanupRef.current = () => {};
    };
    const end = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== gesture.pointerId) return;
      gesture.tap = performance.now() - gesture.startedAt < 300;
      gesture.released = true;
      cleanup();
      void finishGesture();
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    const cancel = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== gesture.pointerId) return;
      cleanup();
      gestureRef.current = null;
      recorder.reset();
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    void recorder.start({ locked: false }).then((started) => {
      gesture.recorderStarted = started;
      if (!started) {
        cleanup();
        gestureRef.current = null;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      } else if (gesture.released) {
        void finishGesture();
      }
    });
  }

  useEffect(() => () => cleanupRef.current(), []);
  useEffect(() => () => cancelRecording(), [conversation.id, cancelRecording]);

  return {
    recorder: { ...recorder, reset: cancelRecording },
    surfaceActive: ['recording', 'review', 'error'].includes(recorder.state.phase),
    recording: recorder.state.phase === 'recording',
    suppressClickRef,
    sendPrepared,
    finishAndSend,
    beginGesture,
  };
}

export type VoiceComposerController = ReturnType<typeof useVoiceComposer>;
