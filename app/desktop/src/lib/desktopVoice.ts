import { invokeDesktop } from './desktop';

export function desktopVoiceTranscriptionLocales(
  languages = typeof navigator === 'undefined' ? ['en-US'] : navigator.languages,
) {
  return [...new Set([
    ...languages.map((language) => language.trim()).filter(Boolean),
    'zh-CN',
    'zh-TW',
    'zh-HK',
    'en-US',
  ])];
}

export async function transcribeDesktopVoiceMessage(path: string, locale?: string) {
  const locales = desktopVoiceTranscriptionLocales(locale ? [locale] : undefined);
  let lastError: Error | null = null;
  for (const candidate of locales) {
    try {
      return await invokeDesktop<string>('desktop_voice_transcribe', { path, locale: candidate });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.includes('Allow Kordi')) throw lastError;
    }
  }
  throw lastError ?? new Error('No speech detected.');
}

export function trimDesktopVoiceMessage(path: string, startMs: number, endMs: number) {
  return invokeDesktop<string>('desktop_voice_trim', { path, startMs, endMs });
}

export type DesktopVoiceRecordingSample = { durationMs: number; level: number };
export type DesktopVoiceRecordingStop = { path: string; durationMs: number; sizeBytes: number };
export type DesktopVoicePlaybackSample = { currentMs: number; durationMs: number; playing: boolean };

export function startDesktopVoiceRecording() {
  return invokeDesktop<string>('desktop_voice_record_start');
}

export function sampleDesktopVoiceRecording() {
  return invokeDesktop<DesktopVoiceRecordingSample>('desktop_voice_record_sample');
}

export function stopDesktopVoiceRecording() {
  return invokeDesktop<DesktopVoiceRecordingStop>('desktop_voice_record_stop');
}

export function cancelDesktopVoiceRecording() {
  return invokeDesktop<void>('desktop_voice_record_cancel');
}

export function playDesktopVoiceMessage(path: string) {
  return invokeDesktop<DesktopVoicePlaybackSample>('desktop_voice_play', { path });
}

export function pauseDesktopVoiceMessage(path: string) {
  return invokeDesktop<DesktopVoicePlaybackSample>('desktop_voice_pause', { path });
}

export function seekDesktopVoiceMessage(path: string, positionMs: number) {
  return invokeDesktop<DesktopVoicePlaybackSample>('desktop_voice_seek', { path, positionMs });
}

export function stopDesktopVoiceMessage(path: string) {
  return invokeDesktop<void>('desktop_voice_stop', { path });
}
