import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { MessageVoiceDraft } from '@/kordi-app/types/message';

export { cloudVoiceAttachmentReference } from './cloudVoiceMessage';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function runtimeRoute(value: unknown): DesktopChatMessageRoute | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const model = cleanText(record.defaultModel) || cleanText(record.model);
  const authProvider = cleanText(record.defaultAuthProvider) || cleanText(record.authProvider);
  const authChoice = cleanText(record.defaultAuthChoice) || cleanText(record.authChoice);
  const thinking = cleanText(record.thinking);
  return model || thinking ? {
    ...(model ? { model } : {}),
    ...(authProvider ? { authProvider } : {}),
    ...(authChoice ? { authChoice } : {}),
    ...(thinking ? { thinking } : {}),
  } : null;
}

export function cloudGroupMessageRuntimeFields(candidate: Record<string, unknown>): {
  agentRuntimeRoute?: DesktopChatMessageRoute | null;
  messageKind?: string | null;
  voiceMessage?: (MessageVoiceDraft & { mediaId?: string | null }) | null;
  structuredContent?: Record<string, unknown> | null;
} {
  const structuredContent = candidate.structuredContent;
  const voice = candidate.voiceMessage && typeof candidate.voiceMessage === 'object' && !Array.isArray(candidate.voiceMessage)
    ? candidate.voiceMessage as Record<string, unknown>
    : null;
  const durationMs = voice && typeof voice.durationMs === 'number' && Number.isFinite(voice.durationMs)
    ? Math.max(0, Math.round(voice.durationMs))
    : 0;
  const waveformSamples = voice && Array.isArray(voice.waveformSamples)
    ? voice.waveformSamples.flatMap((sample) => (
        typeof sample === 'number' && Number.isFinite(sample)
          ? [Math.max(0, Math.min(1, sample))]
          : []
      )).slice(0, 96)
    : [];
  const mimeType = cleanText(voice?.mimeType);
  const voiceMessage = voice && mimeType && durationMs > 0 ? {
    mediaId: cleanText(voice.mediaId) || null,
    mimeType,
    durationMs,
    waveformSamples,
    transcript: cleanText(voice.transcript),
    localPath: cleanText(voice.localPath) || null,
  } : null;
  return {
    agentRuntimeRoute: runtimeRoute(candidate.agentRuntimeRoute),
    messageKind: cleanText(candidate.messageKind) || null,
    voiceMessage,
    structuredContent: structuredContent && typeof structuredContent === 'object' && !Array.isArray(structuredContent)
      ? structuredContent as Record<string, unknown>
      : null,
  };
}

export function integerMilliseconds(
  value: unknown,
  fallback: number | null = null,
): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}
