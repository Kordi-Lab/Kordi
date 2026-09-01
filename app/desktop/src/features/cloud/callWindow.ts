import type { CloudAccount } from './authClient';
import type { CloudCall, CloudCallsChangedDetail } from './cloudCalls';
import type { Conversation } from '@/kordi-app/types';

export const CALL_WINDOW_LABEL = 'call';
export const CALL_WINDOW_READY_EVENT = 'kordi://call-window-ready';
export const CALL_WINDOW_STATE_EVENT = 'kordi://call-window-state';
export const CALL_WINDOW_THUMBNAIL_EVENT = 'kordi://call-window-thumbnail';
export const CALL_WINDOW_VISIBILITY_EVENT = 'kordi://call-window-visibility';
export const CALL_WINDOW_RESULT_EVENT = 'kordi://call-window-result';

const BROWSER_CALL_PAYLOAD_PREFIX = 'kordi:call-window:';

export type CallWindowPayload = {
  requestId: string;
  account: CloudAccount;
  call: CloudCall;
  sessionId: string | null;
  requiresAnswer: boolean;
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'name'>;
};

export function callWindowSizeForVideo(width: number, height: number) {
  const aspectRatio = width > 0 && height > 0 ? width / height : 16 / 9;
  return {
    width: aspectRatio < 1 ? 620 : 960,
    height: 720,
    aspectRatio,
  };
}

declare global {
  interface Window {
    __KORDI_CALL_WINDOW_PAYLOAD__?: CallWindowPayload;
  }
}

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function createRequestId() {
  return crypto.randomUUID();
}

function payloadKey(requestId: string) {
  return `${BROWSER_CALL_PAYLOAD_PREFIX}${requestId}`;
}

export function callWindowRequestId() {
  return new URLSearchParams(window.location.search).get('callWindowRequest')?.trim() ?? '';
}

export function readCallWindowPayload(requestId: string): CallWindowPayload | null {
  const initial = window.__KORDI_CALL_WINDOW_PAYLOAD__;
  if (initial?.requestId === requestId) return initial;
  try {
    const stored = window.localStorage.getItem(payloadKey(requestId));
    const payload = stored ? JSON.parse(stored) as CallWindowPayload : null;
    return payload?.requestId === requestId ? payload : null;
  } catch {
    return null;
  }
}

export async function openCallWindow(
  input: Omit<CallWindowPayload, 'requestId'>,
  options: { onReady: () => Promise<void>; onDestroyed: () => void },
) {
  const requestId = createRequestId();
  const payload = { ...input, requestId };
  const url = `${window.location.origin}${window.location.pathname}?callWindow=1&callWindowRequest=${requestId}`;
  const initialWidth = input.call.kind === 'video' ? 620 : 960;

  if (!isNativeDesktopShell()) {
    window.localStorage.setItem(payloadKey(requestId), JSON.stringify(payload));
    return window.open(url, `kordi-${CALL_WINDOW_LABEL}`, `popup=yes,width=${initialWidth},height=720,resizable=yes`);
  }

  const [{ emitTo, listen }, { WebviewWindow }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/webviewWindow'),
  ]);
  const existing = await WebviewWindow.getByLabel(CALL_WINDOW_LABEL);
  if (existing) await existing.destroy();
  const unlistenReady = await listen<{ requestId?: string }>(CALL_WINDOW_READY_EVENT, (event) => {
    if (event.payload?.requestId !== requestId) return;
    void options.onReady().then(async () => {
      await emitTo(CALL_WINDOW_LABEL, CALL_WINDOW_STATE_EVENT, payload);
    });
  });
  const callWindow = new WebviewWindow(CALL_WINDOW_LABEL, {
    url,
    title: input.conversation.name || 'Kordi Call',
    width: initialWidth,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    center: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreen: false,
    closable: true,
    focus: true,
    decorations: true,
    shadow: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    transparent: true,
    backgroundColor: '#1b1f23',
    visible: true,
  });
  void callWindow.once('tauri://destroyed', () => {
    unlistenReady();
    options.onDestroyed();
  });
  return callWindow;
}

export async function subscribeToCallWindow(
  requestId: string,
  onPayload: (payload: CallWindowPayload | CloudCallsChangedDetail) => void,
) {
  const prepared = readCallWindowPayload(requestId);
  if (prepared) onPayload(prepared);
  if (!isNativeDesktopShell()) return () => undefined;
  const { emit, listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<CallWindowPayload | CloudCallsChangedDetail>(
    CALL_WINDOW_STATE_EVENT,
    (event) => onPayload(event.payload),
  );
  await emit(CALL_WINDOW_READY_EVENT, { requestId });
  return unlisten;
}

export async function relayCallWindowState(detail: CloudCallsChangedDetail) {
  if (!isNativeDesktopShell()) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CALL_WINDOW_LABEL, CALL_WINDOW_STATE_EVENT, detail);
}

export async function showCallWindow() {
  if (!isNativeDesktopShell()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const callWindow = await WebviewWindow.getByLabel(CALL_WINDOW_LABEL);
  await callWindow?.show();
  await callWindow?.unminimize();
  await callWindow?.setFocus();
}
