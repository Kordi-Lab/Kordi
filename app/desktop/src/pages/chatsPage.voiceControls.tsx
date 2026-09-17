import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VoiceRecordingRail } from '@/kordi-app/components/voiceMessage';
import type { VoiceComposerController } from './chatsPage.voiceComposer';

function VoiceMessageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" />
      <circle cx="9.25" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M11.34 9.51a3.25 3.25 0 0 1 0 4.98" />
      <path d="M13.11 7.4a6 6 0 0 1 0 9.2" />
    </svg>
  );
}

/** Idle: voice icon beside the send button. Active: the voice draft pill takes their place. */
export function VoiceComposerControls({
  voice,
  hasSendableDraft,
  activeLiveTurnIsRunning,
  onSend,
}: {
  voice: VoiceComposerController;
  hasSendableDraft: boolean;
  activeLiveTurnIsRunning: boolean;
  onSend: () => void;
}) {
  const recorder = voice.recorder;
  if (voice.surfaceActive) {
    return (
      <VoiceRecordingRail
        state={recorder.state}
        onCancel={recorder.reset}
        onSend={() => { void (voice.recording ? voice.finishAndSend() : voice.sendPrepared()); }}
        onRetry={() => {
          if (recorder.state.attachment) void recorder.prepareForSend();
          else void recorder.start();
        }}
        onTrimRange={recorder.setTrimRange}
      />
    );
  }
  return (
    <div className="app-voice-composer-actions flex h-10 shrink-0 items-center gap-2 pr-1">
      <button
        type="button"
        className="app-button-quiet app-icon-button grid h-9 w-9 shrink-0 place-items-center rounded-full border-0 p-0"
        onPointerDown={recorder.state.phase === 'idle' ? voice.beginGesture : undefined}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (voice.suppressClickRef.current) return;
          void recorder.start();
        }}
        title="Click to record, or hold and release to send"
        aria-label="Record voice message"
      >
        <VoiceMessageIcon className="h-5 w-5" />
      </button>
      <Button
        className="app-composer-send app-composer-send-compact h-8 w-8 shrink-0 rounded-full p-0"
        onClick={onSend}
        disabled={!hasSendableDraft}
        data-composer-send={hasSendableDraft ? 'true' : undefined}
        title={activeLiveTurnIsRunning ? 'Queue message for this session' : 'Send message'}
        aria-label="Send message"
      >
        <Send className="h-[15px] w-[15px]" />
      </Button>
    </div>
  );
}
