import { invokeDesktop, isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';

import type { CloudCallKind } from './cloudCalls';

export type CallMediaSource = 'microphone' | 'camera';

/** A call that cannot start until the person allows device access. */
export type CallPermissionIssue = {
  /** Devices the call still needs, microphone first. */
  sources: CallMediaSource[];
  /** True in the Mac app, which can open the matching System Settings pane. */
  canOpenSettings: boolean;
};

export type CallPermissionResult =
  | { status: 'granted' }
  | { status: 'blocked'; issue: CallPermissionIssue };

export type CallPermissionDeps = {
  /**
   * Reads (request=false) or requests (request=true) macOS device access and
   * returns `granted`, `denied`, `restricted`, `not_determined`, `unavailable`
   * or `unknown`. Absent outside the native desktop shell.
   */
  native?: (source: CallMediaSource, request: boolean) => Promise<string>;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

const KNOWN_NATIVE_STATUSES = new Set(['granted', 'denied', 'restricted', 'not_determined']);

export function callMediaSources(kind: CloudCallKind): CallMediaSource[] {
  return kind === 'voice' ? ['microphone'] : ['microphone', 'camera'];
}

export function isMediaPermissionError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

async function nativeStatus(
  native: NonNullable<CallPermissionDeps['native']>,
  source: CallMediaSource,
  request: boolean,
): Promise<string> {
  try {
    return await native(source, request);
  } catch {
    // A timed-out or failed native check falls through to the web request,
    // which still reports a refusal through the same dialog.
    return 'unknown';
  }
}

/**
 * Makes sure the call can use the microphone (and the camera for video).
 * In the Mac app it asks macOS first, so the system prompt appears when
 * access was never decided, then opens the devices once through the web view.
 */
export async function ensureCallMediaPermission(
  kind: CloudCallKind,
  deps: CallPermissionDeps,
): Promise<CallPermissionResult> {
  const sources = callMediaSources(kind);
  let canOpenSettings = false;
  if (deps.native) {
    const blocked: CallMediaSource[] = [];
    for (const source of sources) {
      let status = await nativeStatus(deps.native, source, false);
      if (status === 'not_determined') status = await nativeStatus(deps.native, source, true);
      if (KNOWN_NATIVE_STATUSES.has(status)) canOpenSettings = true;
      if (status === 'denied' || status === 'restricted') blocked.push(source);
    }
    if (blocked.length > 0) return { status: 'blocked', issue: { sources: blocked, canOpenSettings } };
  }
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: true, video: kind !== 'voice' });
  } catch (error) {
    if (isMediaPermissionError(error)) return { status: 'blocked', issue: { sources, canOpenSettings } };
    throw error;
  }
  for (const track of stream.getTracks()) track.stop();
  return { status: 'granted' };
}

export function defaultCallPermissionDeps(): CallPermissionDeps {
  return {
    native: isNativeDesktopShell()
      ? (source, request) => invokeDesktop<string>('desktop_media_permission', { source, request })
      : undefined,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  };
}

export function callPermissionSettingsUrl(source: CallMediaSource): string {
  return `x-apple.systempreferences:com.apple.preference.security?${source === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone'}`;
}

export async function openCallPermissionSettings(issue: CallPermissionIssue): Promise<void> {
  await openDesktopExternalUrl(callPermissionSettingsUrl(issue.sources[0] ?? 'microphone'));
}

function deviceNames(sources: CallMediaSource[]): string {
  const hasMicrophone = sources.includes('microphone');
  const hasCamera = sources.includes('camera');
  if (hasMicrophone && hasCamera) return 'microphone and camera';
  return hasCamera ? 'camera' : 'microphone';
}

/** Copy for a microphone or camera permission dialog; `retry` ends the line. */
export function mediaPermissionCopy(
  issue: CallPermissionIssue,
  retry = 'call again',
): { title: string; description: string } {
  const names = deviceNames(issue.sources);
  const title = `Allow ${names} access`;
  if (!issue.canOpenSettings) {
    return { title, description: `Allow ${names} in your browser's site settings, then ${retry}.` };
  }
  const panes = names === 'microphone and camera' ? 'Microphone and Camera' : names === 'camera' ? 'Camera' : 'Microphone';
  return { title, description: `Turn on Kordi in Privacy & Security › ${panes}, then ${retry}.` };
}

export function callPermissionCopy(issue: CallPermissionIssue): { title: string; description: string } {
  return mediaPermissionCopy(issue, 'call again');
}
