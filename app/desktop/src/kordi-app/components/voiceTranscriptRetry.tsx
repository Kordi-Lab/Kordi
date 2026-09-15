import { useRef, useState } from 'react';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { downloadCloudAttachmentToLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import { MAX_TRANSCRIPTION_ATTEMPTS, VOICE_TRANSCRIPT_LIMIT, voiceTranscriptionFailureStatus, type VoiceTranscription } from '@/features/chat/voiceTranscription';
import type { MessageVoice } from '@/kordi-app/types/message';
import { transcribeDesktopVoiceMessageResult } from '@/lib/desktopVoice';

export type VoiceTranscriptRetryTarget = { conversationId: string; messageId: string; version: number };

export function VoiceTranscriptRetry({ voice, target }: { voice: MessageVoice; target: VoiceTranscriptRetryTarget }) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const cached = useRef<{ transcript: string; transcription: VoiceTranscription } | null>(null);

  async function retry() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to retry transcription.');
      if (!cached.current) {
        // Always use the authenticated original; the server rechecks source and visibility on write.
        const path = await downloadCloudAttachmentToLocalPath(session.token, voice.mediaId, 'Voice message.m4a');
        const transcription: VoiceTranscription = {
          status: 'failed', sourceVersion: voice.mediaId, engine: 'apple-speech-v1',
          attempts: (voice.transcription?.attempts ?? 0) + 1,
        };
        try {
          const result = await transcribeDesktopVoiceMessageResult(path);
          if (result.transcript.length > VOICE_TRANSCRIPT_LIMIT) throw new Error('Transcript exceeds the message limit.');
          cached.current = { transcript: result.transcript,
            transcription: { ...transcription, status: 'ready', language: result.language } };
        } catch (error) {
          cached.current = { transcript: '', transcription: { ...transcription, status: voiceTranscriptionFailureStatus(error) } };
        }
      }
      const currentSession = await loadSession();
      if (currentSession?.token !== session.token) throw new Error('Account changed. Open the message again.');
      await defaultCloudAuthClient().chat.updateVoiceTranscript(session.token, target.conversationId,
        target.messageId, target.version, voice.mediaId, cached.current.transcript, cached.current.transcription);
      setCompleted(true);
      setNotice(cached.current.transcription.status === 'ready'
        ? 'Transcript updated.' : 'Transcription failed. Audio is preserved.');
    } catch {
      setNotice('Could not update transcription. Refresh the message before retrying.');
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return <div role="status">
    <button type="button" className="app-button-quiet" onClick={() => { void retry(); }}
      disabled={busy || completed || (voice.transcription?.attempts ?? 0) >= MAX_TRANSCRIPTION_ATTEMPTS}>
      {busy ? 'Transcribing…' : 'Retry transcription'}
    </button>
    {notice ? <div>{notice}</div> : null}
  </div>;
}
