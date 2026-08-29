import {
  cancelDesktopCloudAttachmentUpload,
  uploadDesktopCloudAttachment,
  type DesktopCloudAttachmentUploadResult,
} from '@/lib/cloudAttachmentUpload';

const UPLOAD_PROGRESS_EVENT = 'cloud-attachment-upload-progress';

export type CloudAttachmentUploadState = {
  requestId: string;
  phase: 'preparing' | 'uploading' | 'finishing' | 'complete' | 'failed' | 'cancelled';
  uploadedBytes: number;
  totalBytes: number;
  error?: string;
};

type UploadProgressEvent = Omit<CloudAttachmentUploadState, 'error'>;

const states = new Map<string, CloudAttachmentUploadState>();
const listeners = new Map<string, Set<() => void>>();
const pathByRequestId = new Map<string, string>();
const reusableUploads = new Map<string, Promise<DesktopCloudAttachmentUploadResult>>();

function publish(path: string, state: CloudAttachmentUploadState | null) {
  if (state) states.set(path, state);
  else states.delete(path);
  listeners.get(path)?.forEach((listener) => listener());
  if (state && ['complete', 'failed', 'cancelled'].includes(state.phase) && typeof window !== 'undefined') {
    window.setTimeout(() => {
      if (states.get(path)?.requestId === state.requestId) publish(path, null);
    }, 5 * 60_000);
  }
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isNativeAttachmentUploadAvailable() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export function subscribeCloudAttachmentUpload(path: string, listener: () => void) {
  if (!path) return () => {};
  const pathListeners = listeners.get(path) ?? new Set();
  pathListeners.add(listener);
  listeners.set(path, pathListeners);
  return () => {
    pathListeners.delete(listener);
    if (pathListeners.size === 0) listeners.delete(path);
  };
}

export function cloudAttachmentUploadSnapshot(path: string) {
  return path ? states.get(path) ?? null : null;
}

export function resolveCloudAttachmentUploadProgress(
  state: CloudAttachmentUploadState | null,
  fallbackTotalBytes?: number | null,
) {
  const totalBytes = state && state.totalBytes > 0
    ? state.totalBytes
    : typeof fallbackTotalBytes === 'number' && fallbackTotalBytes > 0
      ? fallbackTotalBytes
      : null;
  if (totalBytes === null) return null;
  const uploadedBytes = Math.min(totalBytes, Math.max(0, state?.uploadedBytes ?? 0));
  return {
    uploadedBytes,
    totalBytes,
    percent: (uploadedBytes / totalBytes) * 100,
  };
}

async function runNativeCloudAttachmentUpload({
  path,
  contentType,
}: {
  path: string;
  contentType?: string | null;
}): Promise<DesktopCloudAttachmentUploadResult> {
  const id = requestId();
  pathByRequestId.set(id, path);
  publish(path, {
    requestId: id,
    phase: 'preparing',
    uploadedBytes: 0,
    totalBytes: 0,
  });
  let unlisten: (() => void) | null = null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<UploadProgressEvent>(UPLOAD_PROGRESS_EVENT, ({ payload }) => {
      const eventPath = pathByRequestId.get(payload.requestId);
      if (!eventPath) return;
      publish(eventPath, payload);
    });
    const result = await uploadDesktopCloudAttachment(id, path, contentType);
    const totalBytes = Math.max(
      states.get(path)?.totalBytes ?? 0,
      result.sizeBytes ?? 0,
    );
    publish(path, {
      requestId: id,
      phase: 'complete',
      uploadedBytes: totalBytes,
      totalBytes,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : typeof error === 'string' && error.trim() ? error : 'Unable to upload attachment.';
    const current = states.get(path);
    publish(path, {
      requestId: id,
      phase: current?.phase === 'cancelled' ? 'cancelled' : 'failed',
      uploadedBytes: current?.uploadedBytes ?? 0,
      totalBytes: current?.totalBytes ?? 0,
      error: message,
    });
    throw new Error(message);
  } finally {
    pathByRequestId.delete(id);
    unlisten?.();
  }
}

export function uploadNativeCloudAttachment({
  path,
  contentType,
}: {
  path: string;
  contentType?: string | null;
}): Promise<DesktopCloudAttachmentUploadResult> {
  const key = `${path}\u0000${contentType?.trim() ?? ''}`;
  const existing = reusableUploads.get(key);
  if (existing) return existing;
  const upload = runNativeCloudAttachmentUpload({ path, contentType }).then(
    (result) => {
      window.setTimeout(() => {
        if (reusableUploads.get(key) === upload) reusableUploads.delete(key);
      }, 5 * 60_000);
      return result;
    },
    (error: unknown) => {
      reusableUploads.delete(key);
      throw error;
    },
  );
  reusableUploads.set(key, upload);
  return upload;
}

export async function cancelCloudAttachmentUpload(path: string) {
  const state = states.get(path);
  if (!state || !['preparing', 'uploading', 'finishing'].includes(state.phase)) return;
  publish(path, { ...state, phase: 'cancelled' });
  await cancelDesktopCloudAttachmentUpload(state.requestId);
}
