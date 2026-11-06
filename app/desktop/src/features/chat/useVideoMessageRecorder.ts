import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appendDesktopChatAttachmentStream,
  cancelDesktopChatAttachmentStream,
  discardDesktopChatAttachment,
  finishDesktopChatAttachmentStream,
  startDesktopChatAttachmentStream,
} from '@/lib/desktopAttachmentStream';
import {
  callMediaSources,
  defaultCallPermissionDeps,
  openCallPermissionSettings,
  openMediaStreamWithPermission,
  type CallPermissionDeps,
  type CallPermissionIssue,
  type MediaStreamPermissionResult,
} from '@/features/cloud/callMediaPermission';
import { composerAttachmentItemFromStoredPath } from './composerAttachments';
import type { AttachmentItem } from './composerController.types';

const MAX_VIDEO_RECORDING_MS = 60_000;
const VIDEO_BITS_PER_SECOND = 1_600_000;
const AUDIO_BITS_PER_SECOND = 64_000;
const MP4_RECORDING_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];
const VIDEO_RECORDING_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
  audio: true,
};

export type VideoComposerState = {
  /** `permission` waits on the access dialog after macOS or the browser refused. */
  phase: 'idle' | 'requesting' | 'recording' | 'processing' | 'review' | 'error' | 'permission';
  durationMs: number;
  stream: MediaStream | null;
  attachment: AttachmentItem | null;
  error: string | null;
  permissionIssue: CallPermissionIssue | null;
};

const IDLE_STATE: VideoComposerState = {
  phase: 'idle',
  durationMs: 0,
  stream: null,
  attachment: null,
  error: null,
  permissionIssue: null,
};

export function preferredMp4RecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean,
) {
  return MP4_RECORDING_TYPES.find(isTypeSupported) ?? null;
}

/**
 * Opens the camera and microphone for a video message. In the Mac app macOS
 * is asked first, so its prompt appears when access was never decided.
 */
export function openVideoRecordingStream(
  deps: CallPermissionDeps,
): Promise<MediaStreamPermissionResult> {
  return openMediaStreamWithPermission(callMediaSources('video'), VIDEO_RECORDING_CONSTRAINTS, deps);
}

/** One short line for a recording failure; refused access uses the dialog. */
export function videoRecordingErrorMessage(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera and microphone access is off.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return "Couldn't find a camera and microphone.";
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera or microphone is already in use.';
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Couldn't record this video.";
}

function videoFileName(now = new Date()) {
  return `Video ${now.toISOString().replace('T', ' ').replace(/:/g, '.').slice(0, 19)}.mp4`;
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function formatVideoRecordingDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function useVideoMessageRecorder({
  conversationId,
  onSend,
  focusComposer,
  permissionDeps,
}: {
  conversationId: string;
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  focusComposer: () => void;
  /** Injected in tests; defaults to the Mac app or browser device access. */
  permissionDeps?: CallPermissionDeps;
}) {
  const [state, setState] = useState<VideoComposerState>(IDLE_STATE);
  const stateRef = useRef(state);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const attachmentStreamRef = useRef<string | null>(null);
  const posterRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const commit = useCallback((next: VideoComposerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const clear = useCallback((discardAttachment: boolean) => {
    generationRef.current += 1;
    stopTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      recorder.stop();
    }
    const attachmentStreamId = attachmentStreamRef.current;
    attachmentStreamRef.current = null;
    if (attachmentStreamId) {
      void cancelDesktopChatAttachmentStream(attachmentStreamId).catch(() => undefined);
    }
    stopStream(captureStreamRef.current ?? stateRef.current.stream);
    captureStreamRef.current = null;
    if (discardAttachment && stateRef.current.attachment?.path) {
      void discardDesktopChatAttachment(stateRef.current.attachment.path).catch(() => undefined);
    }
    posterRef.current = null;
    commit(IDLE_STATE);
  }, [commit, stopTimer]);

  const reset = useCallback(() => clear(true), [clear]);

  const start = useCallback(async () => {
    if (!['idle', 'error', 'review', 'permission'].includes(stateRef.current.phase)) return;
    reset();
    const generation = generationRef.current;
    commit({ ...IDLE_STATE, phase: 'requesting' });
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Video recording is not available on this Mac. Attach an MP4 file instead.');
      }
      const mimeType = preferredMp4RecordingMimeType(MediaRecorder.isTypeSupported.bind(MediaRecorder));
      if (!mimeType) {
        throw new Error('This Mac cannot record MP4 video in Kordi. Attach an MP4 file instead.');
      }
      const opened = await openVideoRecordingStream(permissionDeps ?? defaultCallPermissionDeps());
      if (generation !== generationRef.current) {
        if (opened.status === 'granted') stopStream(opened.stream);
        return;
      }
      if (opened.status === 'blocked') {
        commit({ ...IDLE_STATE, phase: 'permission', permissionIssue: opened.issue });
        return;
      }
      const { stream } = opened;
      captureStreamRef.current = stream;
      const fileName = videoFileName();
      const attachmentStreamId = await startDesktopChatAttachmentStream(fileName);
      attachmentStreamRef.current = attachmentStreamId;
      let appendPromise = Promise.resolve();
      let appendError: unknown = null;
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      recorderRef.current = recorder;
      const startedAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          appendPromise = appendPromise.then(() => (
            appendDesktopChatAttachmentStream(attachmentStreamId, event.data)
          )).catch((error: unknown) => {
            appendError = error;
          });
        }
      };
      recorder.onerror = () => {
        if (generation !== generationRef.current) return;
        attachmentStreamRef.current = null;
        void cancelDesktopChatAttachmentStream(attachmentStreamId).catch(() => undefined);
        stopTimer();
        stopStream(stream);
        captureStreamRef.current = null;
        recorderRef.current = null;
        commit({
          ...IDLE_STATE,
          phase: 'error',
          error: 'The camera stopped before the video could be saved.',
        });
      };
      recorder.onstop = () => {
        if (generation !== generationRef.current) return;
        stopTimer();
        stopStream(stream);
        captureStreamRef.current = null;
        recorderRef.current = null;
        const durationMs = Math.min(MAX_VIDEO_RECORDING_MS, Date.now() - startedAt);
        commit({ ...IDLE_STATE, phase: 'processing', durationMs });
        void (async () => {
          try {
            await appendPromise;
            if (appendError) throw new Error(videoRecordingErrorMessage(appendError));
            const stored = await finishDesktopChatAttachmentStream(attachmentStreamId);
            attachmentStreamRef.current = null;
            if (!stored.sizeBytes) throw new Error('The camera stopped before the video could be saved.');
            const attachment = await composerAttachmentItemFromStoredPath({
              sourcePath: stored.path,
              stored,
              displayName: fileName,
            });
            if (generation !== generationRef.current) {
              void discardDesktopChatAttachment(attachment.path).catch(() => undefined);
              return;
            }
            commit({
              phase: 'review',
              durationMs,
              stream: null,
              attachment: {
                ...attachment,
                localPath: attachment.path,
                previewUrl: attachment.previewUrl ?? posterRef.current,
              },
              error: null,
              permissionIssue: null,
            });
          } catch (error) {
            attachmentStreamRef.current = null;
            void cancelDesktopChatAttachmentStream(attachmentStreamId).catch(() => undefined);
            if (generation === generationRef.current) {
              commit({ ...IDLE_STATE, phase: 'error', error: videoRecordingErrorMessage(error) });
            }
          }
        })();
      };
      recorder.start(1_000);
      commit({
        phase: 'recording',
        durationMs: 0,
        stream,
        attachment: null,
        error: null,
        permissionIssue: null,
      });
      timerRef.current = window.setInterval(() => {
        if (generation !== generationRef.current || recorder.state !== 'recording') return;
        const durationMs = Date.now() - startedAt;
        commit({ ...stateRef.current, durationMs });
        if (durationMs >= MAX_VIDEO_RECORDING_MS) recorder.stop();
      }, 1_000);
    } catch (error) {
      if (generation === generationRef.current) {
        const attachmentStreamId = attachmentStreamRef.current;
        attachmentStreamRef.current = null;
        if (attachmentStreamId) {
          void cancelDesktopChatAttachmentStream(attachmentStreamId).catch(() => undefined);
        }
        stopStream(captureStreamRef.current);
        captureStreamRef.current = null;
        commit({ ...IDLE_STATE, phase: 'error', error: videoRecordingErrorMessage(error) });
      }
    }
  }, [commit, permissionDeps, reset, stopTimer]);

  const stop = useCallback((posterUrl?: string | null) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    posterRef.current = posterUrl ?? null;
    commit({ ...stateRef.current, phase: 'processing' });
    recorder.stop();
  }, [commit]);

  const send = useCallback(() => {
    const attachment = stateRef.current.attachment;
    if (!attachment || stateRef.current.phase !== 'review') return;
    try {
      const result = onSend('', [attachment]);
      clear(false);
      window.requestAnimationFrame(focusComposer);
      void Promise.resolve(result).catch(() => undefined);
    } catch (error) {
      commit({
        ...stateRef.current,
        phase: 'review',
        error: videoRecordingErrorMessage(error),
      });
    }
  }, [clear, commit, focusComposer, onSend]);

  const openPermissionSettings = useCallback(() => {
    const issue = stateRef.current.permissionIssue;
    reset();
    if (issue) void openCallPermissionSettings(issue).catch(() => undefined);
  }, [reset]);

  useEffect(() => reset, [conversationId, reset]);

  return {
    state,
    surfaceActive: state.phase !== 'idle',
    start,
    stop,
    reset,
    retake: start,
    send,
    openPermissionSettings,
  };
}

export type VideoMessageRecorderController = ReturnType<typeof useVideoMessageRecorder>;
