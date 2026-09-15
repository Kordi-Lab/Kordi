import { readDesktopChatAttachment } from '@/lib/desktop';
const MIN_PLAYABLE_VOICE_BYTES = 1_024;

export function formatVoiceDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export async function localVoiceSource(path: string | null | undefined) {
  if (!path) return null;
  const bytes = await readDesktopChatAttachment(path);
  if (bytes.length < MIN_PLAYABLE_VOICE_BYTES) {
    throw new Error('Voice message audio is unavailable.');
  }
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }));
}
