import type { MessageAttachment, ResolvedThemeMode } from '@/kordi-app/types';

export const ATTACHMENT_MEDIA_WINDOW_LABEL = 'media-preview';
export const ATTACHMENT_MEDIA_READY_EVENT = 'kordi://attachment-media-ready';
export const ATTACHMENT_MEDIA_STATE_EVENT = 'kordi://attachment-media-state';

const BROWSER_MEDIA_PAYLOAD_PREFIX = 'kordi:attachment-media:';

export type AttachmentMediaWindowPayload = {
  requestId: string;
  attachments: MessageAttachment[];
  selectedIndex: number;
  initialPreviewUrl?: string | null;
  theme?: ResolvedThemeMode;
};

export type AttachmentMediaWindowReadyPayload = {
  requestId: string;
};

declare global {
  interface Window {
    __KORDI_ATTACHMENT_MEDIA_PAYLOAD__?: AttachmentMediaWindowPayload;
  }
}

export const attachmentMediaWindowOptions = {
  title: 'Kordi Media',
  width: 1080,
  height: 760,
  minWidth: 520,
  minHeight: 360,
  center: true,
  resizable: true,
  minimizable: true,
  maximizable: true,
  closable: true,
  focus: true,
  decorations: true,
  shadow: true,
  titleBarStyle: 'overlay' as const,
  hiddenTitle: true,
  backgroundColor: 'transparent',
};

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function currentAttachmentMediaTheme(): ResolvedThemeMode {
  if (typeof document !== 'undefined') {
    const appShell = document.querySelector('.kordi-app');
    if (appShell?.classList.contains('theme-light') || document.body.classList.contains('theme-light')) {
      return 'light';
    }
    if (appShell?.classList.contains('theme-dark') || document.body.classList.contains('theme-dark')) {
      return 'dark';
    }
  }
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function attachmentMediaWindowUrl(requestId: string) {
  const params = new URLSearchParams({
    mediaPreview: '1',
    mediaPreviewRequest: requestId,
  });
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function browserPayloadKey(requestId: string) {
  return `${BROWSER_MEDIA_PAYLOAD_PREFIX}${requestId}`;
}

export function readAttachmentMediaPayload(requestId: string) {
  const initializedPayload = window.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__;
  if (initializedPayload?.requestId === requestId) return initializedPayload;
  try {
    const stored = window.localStorage.getItem(browserPayloadKey(requestId));
    const payload = stored ? JSON.parse(stored) as AttachmentMediaWindowPayload : null;
    return payload?.requestId === requestId ? payload : null;
  } catch {
    return null;
  }
}

function writeAttachmentMediaPayload(payload: AttachmentMediaWindowPayload) {
  try {
    window.localStorage.setItem(browserPayloadKey(payload.requestId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function removeAttachmentMediaPayload(requestId: string) {
  if (window.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__?.requestId === requestId) {
    delete window.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__;
  }
  try {
    window.localStorage.removeItem(browserPayloadKey(requestId));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export async function openAttachmentMediaWindow(
  input: Omit<AttachmentMediaWindowPayload, 'requestId'>,
  options: { onClosed?: () => void } = {},
) {
  const requestId = createRequestId();
  const payload: AttachmentMediaWindowPayload = {
    ...input,
    requestId,
    selectedIndex: Math.min(Math.max(0, input.selectedIndex), Math.max(0, input.attachments.length - 1)),
    theme: input.theme ?? currentAttachmentMediaTheme(),
  };
  const url = attachmentMediaWindowUrl(requestId);

  if (isNativeDesktopShell()) {
    const [{ emitTo, listen }, { invoke }, { WebviewWindow }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/webviewWindow'),
    ]);
    const unlistenReady = await listen<AttachmentMediaWindowReadyPayload>(
      ATTACHMENT_MEDIA_READY_EVENT,
      (event) => {
        if (event.payload?.requestId !== requestId) return;
        void emitTo(ATTACHMENT_MEDIA_WINDOW_LABEL, ATTACHMENT_MEDIA_STATE_EVENT, payload);
      },
    );
    try {
      await invoke('desktop_open_media_preview_window', {
        requestId,
        title: input.attachments[payload.selectedIndex]?.name?.trim() || attachmentMediaWindowOptions.title,
        payload,
      });
      const mediaWindow = await WebviewWindow.getByLabel(ATTACHMENT_MEDIA_WINDOW_LABEL);
      if (!mediaWindow) throw new Error('Media preview window was not created');
      void mediaWindow.once('tauri://destroyed', () => {
        unlistenReady();
        removeAttachmentMediaPayload(requestId);
        options.onClosed?.();
      });
      return mediaWindow;
    } catch (error) {
      unlistenReady();
      removeAttachmentMediaPayload(requestId);
      throw error;
    }
  }

  const payloadPrepared = writeAttachmentMediaPayload(payload);
  if (!payloadPrepared) {
    throw new Error('Unable to prepare the media preview');
  }
  const popup = window.open(
    url,
    `kordi-${ATTACHMENT_MEDIA_WINDOW_LABEL}`,
    `popup=yes,width=${attachmentMediaWindowOptions.width},height=${attachmentMediaWindowOptions.height},resizable=yes,scrollbars=no`,
  );
  if (!popup) {
    removeAttachmentMediaPayload(requestId);
    throw new Error('The media preview window was blocked');
  }
  popup.focus();
  return popup;
}

export async function subscribeToAttachmentMediaWindowPayload(
  requestId: string,
  onPayload: (payload: AttachmentMediaWindowPayload) => void,
) {
  const preparedPayload = readAttachmentMediaPayload(requestId);
  if (preparedPayload) onPayload(preparedPayload);

  if (!isNativeDesktopShell()) {
    return () => removeAttachmentMediaPayload(requestId);
  }

  const { emit, listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<AttachmentMediaWindowPayload>(ATTACHMENT_MEDIA_STATE_EVENT, (event) => {
    if (event.payload?.requestId === requestId) onPayload(event.payload);
  });
  await emit(ATTACHMENT_MEDIA_READY_EVENT, { requestId } satisfies AttachmentMediaWindowReadyPayload);
  return () => {
    unlisten();
    removeAttachmentMediaPayload(requestId);
  };
}
