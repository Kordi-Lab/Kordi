import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  voiceGestureIntent,
  type VoiceGestureIntent,
  useVoiceMessageRecorder,
} from '@/features/chat/useVoiceMessageRecorder';
import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { uploadNativeCloudAttachment } from '@/features/cloud/cloudAttachmentUpload';
import type { Conversation } from '@/kordi-app/types';

export function formatVoiceRecordingDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

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
  const [cancelArmed, setCancelArmed] = useState(false);
  const gestureRef = useRef<{
    pointerId: number;
    startY: number;
    intent: VoiceGestureIntent;
    recorderStarted: boolean;
    released: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<() => void>(() => {});
  const prefetchesUpload = Boolean(
    cloudAccountId
      && (isCloudCollaborationConversationId(conversation.id) || conversation.directness === 'group'),
  );

  const sendPrepared = useCallback(async () => {
    const attachment = await recorder.prepareForSend();
    const transcript = attachment?.voiceMessage?.transcript.trim();
    if (!attachment || !transcript) return;
    await onSend(transcript, [attachment]);
    recorder.reset();
    window.requestAnimationFrame(focusComposer);
  }, [focusComposer, onSend, recorder]);

  const finishAndSend = useCallback(async () => {
    const attachment = await recorder.stop({
      directSend: true,
      onAttachmentReady: prefetchesUpload
        ? (ready) => {
            void uploadNativeCloudAttachment({
              path: ready.path,
              contentType: ready.mimeType,
            }).catch(() => undefined);
          }
        : undefined,
    });
    const transcript = attachment?.voiceMessage?.transcript.trim();
    if (!attachment || !transcript) {
      recorder.discardReview();
      return;
    }
    await onSend(transcript, [attachment]);
    recorder.reset();
  }, [onSend, prefetchesUpload, recorder]);

  const finishGesture = useCallback(async () => {
    const gesture = gestureRef.current;
    if (!gesture?.released || !gesture.recorderStarted) return;
    gestureRef.current = null;
    setCancelArmed(false);
    if (gesture.intent === 'cancel') recorder.reset();
    else await finishAndSend();
  }, [finishAndSend, recorder]);

  function beginGesture(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    suppressClickRef.current = true;
    const gesture = {
      pointerId: event.pointerId,
      startY: event.clientY,
      intent: 'hold' as VoiceGestureIntent,
      recorderStarted: false,
      released: false,
    };
    gestureRef.current = gesture;
    setCancelArmed(false);
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      cleanupRef.current = () => {};
    };
    const move = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== gesture.pointerId || gesture.released) return;
      gesture.intent = voiceGestureIntent(nextEvent.clientY - gesture.startY);
      setCancelArmed(gesture.intent === 'cancel');
    };
    const end = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== gesture.pointerId) return;
      if (voiceGestureIntent(nextEvent.clientY - gesture.startY) === 'cancel') {
        gesture.intent = 'cancel';
      }
      gesture.released = true;
      cleanup();
      void finishGesture();
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    const cancel = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== gesture.pointerId) return;
      cleanup();
      gestureRef.current = null;
      setCancelArmed(false);
      recorder.reset();
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    void recorder.start({ locked: false }).then((started) => {
      gesture.recorderStarted = started;
      if (!started) {
        cleanup();
        gestureRef.current = null;
        setCancelArmed(false);
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      } else if (gesture.released) {
        void finishGesture();
      }
    });
  }

  useEffect(() => () => cleanupRef.current(), []);

  return {
    recorder,
    surfaceActive: recorder.state.phase === 'review' || recorder.state.phase === 'error',
    recording: recorder.state.phase === 'recording',
    cancelArmed,
    suppressClickRef,
    sendPrepared,
    finishAndSend,
    beginGesture,
  };
}

export type VoiceComposerController = ReturnType<typeof useVoiceComposer>;
