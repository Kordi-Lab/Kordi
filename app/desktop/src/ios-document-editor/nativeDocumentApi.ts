import type { DocumentShareApi } from '@/features/documents/documentShareApi';
import {
  getCloudDocument,
  initCloudDocumentCollab,
  requestCloudDocumentCollabTicket,
  saveCloudDocumentContent,
  type CloudRequestClient,
  type CloudTextFetch,
} from '@/features/documents/documentShareClient';

import type { NativeBridge } from './nativeBridge';
import { NATIVE_SOCKET_BASE } from './nativeSocket';

/** The app replaces this with the session token; the page never sees it. */
const APP_TOKEN = 'app';

function textBody(init: RequestInit) {
  return typeof init.body === 'string' ? init.body : undefined;
}

export function nativeTextFetch(bridge: NativeBridge): CloudTextFetch {
  return async (url, init) => {
    const response = await bridge.request(init.method ?? 'GET', url, textBody(init));
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : response.body, { status: response.status });
  };
}

export function nativeRequestClient(bridge: NativeBridge): CloudRequestClient {
  return {
    async request<T>(path: string, init: RequestInit, fallbackMessage: string) {
      const response = await bridge.request(init.method ?? 'GET', path, textBody(init));
      let body: unknown = null;
      try { body = response.body ? JSON.parse(response.body) : null; } catch { body = null; }
      if (response.status < 200 || response.status >= 300) {
        const message = (body as { message?: unknown } | null)?.message;
        throw new Error(typeof message === 'string' && message ? message : fallbackMessage);
      }
      return body as T;
    },
  };
}

const unavailable = () => Promise.reject(new Error('Not available in this editor.'));

/** The routes the editor uses (load, save, collaboration), carried by the app. */
export function createNativeDocumentApi(bridge: NativeBridge): DocumentShareApi {
  const client = nativeRequestClient(bridge);
  const fetchText = nativeTextFetch(bridge);
  return {
    getDocument: (attachmentId) => getCloudDocument(client, APP_TOKEN, attachmentId),
    saveDocumentContent: (attachmentId, input) => saveCloudDocumentContent(fetchText, '', APP_TOKEN, attachmentId, input),
    requestCollabTicket: (attachmentId) => requestCloudDocumentCollabTicket(client, APP_TOKEN, attachmentId),
    initCollab: (attachmentId) => initCloudDocumentCollab(client, APP_TOKEN, attachmentId),
    socketBaseUrl: () => NATIVE_SOCKET_BASE,
    rawDocumentUrl: (rawPath) => rawPath,
    getPublicDocument: unavailable,
    getDocumentRaw: unavailable,
    renameDocument: unavailable,
    getPublicDocumentRaw: unavailable,
    listShares: unavailable,
    createShare: unavailable,
    updateShare: unavailable,
    revokeShare: unavailable,
    toggleReaction: unavailable,
    createComment: unavailable,
    updateComment: unavailable,
    deleteComment: unavailable,
    uploadDocument: unavailable,
  };
}
