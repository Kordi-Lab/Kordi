export const DESKTOP_AUTH_CHANNEL_NAME = 'kordi-auth';
export const DESKTOP_AUTH_REFRESH_EVENT = 'kordi-desktop-auth-refresh';

const DESKTOP_AUTH_UPDATED_MESSAGE_TYPE = 'auth-updated';

export type DesktopAuthUpdateReason =
  | 'active-choice-changed'
  | 'api-key-saved'
  | 'oauth-completed'
  | 'cloud-restored'
  | 'profile-removed'
  | 'provider-logout';

export type DesktopAuthRefreshToken = Readonly<{
  requestId: number;
  mutationRevision: number;
}>;

export type DesktopAuthSyncGuard = {
  beginRefresh: () => DesktopAuthRefreshToken;
  canApplyRefresh: (token: DesktopAuthRefreshToken) => boolean;
  beginMutation: () => void;
  finishMutation: () => void;
};

type DesktopAuthUpdatedMessage = {
  type: typeof DESKTOP_AUTH_UPDATED_MESSAGE_TYPE;
  at: number;
  sourceId?: string;
  reason?: DesktopAuthUpdateReason;
};

function createDesktopAuthSourceId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const desktopAuthSourceId = createDesktopAuthSourceId();

export function createDesktopAuthSyncGuard(): DesktopAuthSyncGuard {
  let latestRefreshRequestId = 0;
  let mutationRevision = 0;
  let pendingMutationCount = 0;

  return {
    beginRefresh() {
      latestRefreshRequestId += 1;
      return {
        requestId: latestRefreshRequestId,
        mutationRevision,
      };
    },
    canApplyRefresh(token) {
      return token.requestId === latestRefreshRequestId
        && token.mutationRevision === mutationRevision
        && pendingMutationCount === 0;
    },
    beginMutation() {
      pendingMutationCount += 1;
      mutationRevision += 1;
    },
    finishMutation() {
      pendingMutationCount = Math.max(0, pendingMutationCount - 1);
      mutationRevision += 1;
    },
  };
}

function isDesktopAuthUpdatedMessage(value: unknown): value is DesktopAuthUpdatedMessage {
  if (!value || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === DESKTOP_AUTH_UPDATED_MESSAGE_TYPE;
}

export function isDesktopAuthUpdateFromAnotherSource(
  value: unknown,
  currentSourceId = desktopAuthSourceId,
) {
  return isDesktopAuthUpdatedMessage(value) && value.sourceId !== currentSourceId;
}

export function broadcastDesktopAuthUpdated(reason: DesktopAuthUpdateReason) {
  if (typeof BroadcastChannel === 'undefined') return;

  try {
    const channel = new BroadcastChannel(DESKTOP_AUTH_CHANNEL_NAME);
    channel.postMessage({
      type: DESKTOP_AUTH_UPDATED_MESSAGE_TYPE,
      at: Date.now(),
      sourceId: desktopAuthSourceId,
      reason,
    } satisfies DesktopAuthUpdatedMessage);
    channel.close();
  } catch {
    // Focus-driven refresh remains the fallback when BroadcastChannel is unavailable.
  }
}

export function requestDesktopAuthRefresh(reason: DesktopAuthUpdateReason) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DESKTOP_AUTH_REFRESH_EVENT, { detail: { reason } }));
  }
  broadcastDesktopAuthUpdated(reason);
}
