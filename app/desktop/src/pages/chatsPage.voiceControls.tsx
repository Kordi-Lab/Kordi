import { useState } from 'react';
import { LoaderCircle, Send, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentRequestStopHandler } from '@/features/chat/agentRequestStop';
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

/** The running request's stop, in the send button's place. */
export type ComposerStopControl = {
  /** Identifies the request, so a new one starts with a fresh button. */
  requestKey: string;
  onStop: AgentRequestStopHandler;
};

/**
 * Square stop in the send button's size and position; spins while stopping.
 * It spins until the request ends once the handler reports a stop, and offers
 * Stop again when the handler stopped nothing or failed.
 */
export function ComposerStopButton({ onStop, className, requestKey }: { onStop: AgentRequestStopHandler; className: string; requestKey?: string }) {
  // The request being stopped; a new request key starts with a fresh button.
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const stopping = stoppingKey !== null && stoppingKey === (requestKey ?? '');
  return (
    <Button
      type="button"
      className={className}
      onClick={() => {
        if (stopping) return;
        const key = requestKey ?? '';
        const retry = () => setStoppingKey((current) => (current === key ? null : current));
        setStoppingKey(key);
        void Promise.resolve()
          .then(onStop)
          .then((stopped) => { if (stopped !== true) retry(); }, retry);
      }}
      aria-busy={stopping || undefined}
      data-composer-stop="true"
      title="Stop"
      aria-label="Stop"
    >
      {stopping
        ? <LoaderCircle className="h-[15px] w-[15px] animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <Square className="h-3 w-3 fill-current" aria-hidden="true" />}
    </Button>
  );
}

/** Idle: voice icon beside the send button. Active: the voice draft pill takes their place. */
export function VoiceComposerControls({
  voice,
  hasSendableDraft,
  activeLiveTurnIsRunning,
  onSend,
  stop = null,
}: {
  voice: VoiceComposerController;
  hasSendableDraft: boolean;
  activeLiveTurnIsRunning: boolean;
  onSend: () => void;
  /** While the viewer's request runs, Stop replaces Send; the draft stays. */
  stop?: ComposerStopControl | null;
}) {
  const recorder = voice.recorder;
  if (voice.surfaceActive) {
    return (
      <VoiceRecordingRail
        state={recorder.state}
        onCancel={recorder.reset}
        onSend={() => { void (voice.recording ? voice.finishAndSend() : voice.sendPrepared()); }}
        onRetry={() => { void recorder.start(); }}
        onTrimRange={recorder.setTrimRange}
      />
    );
  }
  return (
    <div className="app-voice-composer-actions flex h-10 shrink-0 items-center gap-2 pr-1">
      <button
        type="button"
        className="app-button-quiet app-icon-button grid h-9 w-9 shrink-0 place-items-center rounded-full border-0 p-0"
        onClick={() => { void recorder.start(); }}
        title="Record a voice message"
        aria-label="Record voice message"
      >
        <VoiceMessageIcon className="h-5 w-5" />
      </button>
      {stop ? (
        <ComposerStopButton
          key={stop.requestKey}
          requestKey={stop.requestKey}
          className="app-composer-send app-composer-send-compact h-8 w-8 shrink-0 rounded-full p-0"
          onStop={stop.onStop}
        />
      ) : <Button
        className="app-composer-send app-composer-send-compact h-8 w-8 shrink-0 rounded-full p-0"
        onClick={onSend}
        disabled={!hasSendableDraft}
        data-composer-send={hasSendableDraft ? 'true' : undefined}
        title={activeLiveTurnIsRunning ? 'Queue message for this session' : 'Send message'}
        aria-label="Send message"
      >
        <Send className="h-[15px] w-[15px]" />
      </Button>}
    </div>
  );
}
