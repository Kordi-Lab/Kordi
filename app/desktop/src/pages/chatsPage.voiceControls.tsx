import { ArrowUp, Mic, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VoiceRecordingRail } from '@/kordi-app/components/voiceMessage';
import { cn } from '@/lib/utils';
import {
  formatVoiceRecordingDuration,
  type VoiceComposerController,
} from './chatsPage.voiceComposer';

export function VoiceComposerControls({
  voice,
  hasSendableDraft,
  validationError,
  activeLiveTurnIsRunning,
  onSend,
}: {
  voice: VoiceComposerController;
  hasSendableDraft: boolean;
  validationError: string | null;
  activeLiveTurnIsRunning: boolean;
  onSend: () => void;
}) {
  const recorder = voice.recorder;
  return (
    <>
      {voice.recording && !recorder.state.locked ? (
        <span
          className={cn(
            'app-voice-swipe-notice',
            voice.cancelArmed && 'app-voice-cancel-armed',
          )}
          role="status"
          aria-live="polite"
        >
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
          {voice.cancelArmed ? 'Release to cancel' : 'Swipe up to cancel'}
        </span>
      ) : null}
      {voice.recording ? (
        <span className={cn(
          'app-voice-button-duration tabular-nums',
          voice.cancelArmed && 'app-voice-cancel-armed',
        )} aria-live="off">
          {formatVoiceRecordingDuration(recorder.state.durationMs)}
        </span>
      ) : null}
      {voice.recording && recorder.state.locked ? (
        <Button className="app-button-quiet h-10 w-10 shrink-0 rounded-full p-0" onClick={recorder.reset}
          aria-label="Cancel voice recording" title="Cancel recording">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : null}
      {!voice.surfaceActive ? (
        <Button
          className={cn(
            'app-composer-send h-10 w-10 shrink-0 rounded-full p-0',
            voice.recording && 'app-composer-voice-recording-button',
            voice.cancelArmed && 'app-voice-cancel-armed',
          )}
          onPointerDown={!hasSendableDraft && recorder.state.phase === 'idle'
            ? voice.beginGesture
            : undefined}
          onContextMenu={!hasSendableDraft ? (event) => event.preventDefault() : undefined}
          onKeyDown={(event) => {
            if (voice.recording && event.key === 'Escape') {
              event.preventDefault();
              recorder.reset();
            }
          }}
          onClick={() => {
            if (!hasSendableDraft) {
              if (voice.suppressClickRef.current) return;
              if (voice.recording && recorder.state.locked) void voice.finishAndSend();
              else if (!voice.recording) void recorder.start();
              return;
            }
            onSend();
          }}
          disabled={Boolean(validationError) || recorder.state.phase === 'sending'}
          data-composer-send={hasSendableDraft ? 'true' : undefined}
          title={!hasSendableDraft
            ? voice.recording ? 'Click to stop and send' : 'Click to record, or hold and release to send'
            : validationError ?? (activeLiveTurnIsRunning
              ? 'Queue message for this session'
              : 'Send message')}
          aria-label={!hasSendableDraft ? voice.recording ? 'Stop and send voice message' : 'Record voice message' : 'Send message'}
        >
          {!hasSendableDraft ? <Mic className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </Button>
      ) : null}
    </>
  );
}

export function VoiceRecordingSurface({ voice }: { voice: VoiceComposerController }) {
  const recorder = voice.recorder;
  return (
    <VoiceRecordingRail
      state={recorder.state}
      onCancel={recorder.reset}
      onSend={() => { void voice.sendPrepared(); }}
      onRetry={() => {
        if (recorder.state.attachment) void recorder.prepareForSend();
        else void recorder.start();
      }}
      onTrimRange={recorder.setTrimRange}
    />
  );
}
