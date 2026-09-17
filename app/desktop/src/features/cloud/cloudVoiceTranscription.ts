import {
  startVoiceTranscription,
  voiceTranscriptionKeys,
} from '@/features/chat/voiceTranscriptionJobs';
import type { VoiceTranscriptionOutcome } from '@/features/chat/voiceTranscription';

import { downloadCloudAttachmentToLocalPath } from './cloudAttachmentLocalPathCache';
import {
  persistCloudVoiceTranscript,
  type CloudVoiceTranscriptTarget,
} from './cloudVoiceTranscriptPersistence';
import { loadSession } from './session';

type VoiceSource = { mediaId?: string | null; localPath?: string | null };

/** Uses the recording on this device when there is one, otherwise the authenticated original. */
export function voiceTranscriptionSource(voice: VoiceSource): () => Promise<string> {
  return async () => {
    const localPath = voice.localPath?.trim();
    if (localPath) return localPath;
    const mediaId = voice.mediaId?.trim();
    if (!mediaId || mediaId.startsWith('pending:')) throw new Error('Voice message audio is unavailable.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to transcribe this voice message.');
    return downloadCloudAttachmentToLocalPath(session.token, mediaId, 'Voice message.m4a');
  };
}

/**
 * A person asked to transcribe a voice message. The job runs in the
 * background; only the sender stores the result on the server.
 */
export function transcribeVoiceMessageOnDemand({
  voice,
  persistTarget,
  retry = false,
}: {
  voice: VoiceSource & { transcription?: { attempts: number } };
  persistTarget?: Omit<CloudVoiceTranscriptTarget, 'mediaId' | 'attempts'> | null;
  retry?: boolean;
}): Promise<VoiceTranscriptionOutcome> {
  const job = startVoiceTranscription({
    keys: voiceTranscriptionKeys(voice),
    source: voiceTranscriptionSource(voice),
    retry,
    reveal: true,
  });
  const mediaId = voice.mediaId?.trim() ?? '';
  if (persistTarget && mediaId && !mediaId.startsWith('pending:')) {
    void job.then((outcome) => persistCloudVoiceTranscript({
      ...persistTarget,
      mediaId,
      attempts: voice.transcription?.attempts ?? 0,
    }, outcome)).catch(() => undefined);
  }
  return job;
}
