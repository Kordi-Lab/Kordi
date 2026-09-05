export const DESKTOP_AUTH_CHANNEL_NAME = 'kordi-auth';

const DESKTOP_AUTH_UPDATED_MESSAGE_TYPE = 'auth-updated';

export type DesktopAuthUpdateReason =
  | 'active-choice-changed'
  | 'api-key-saved'
  | 'oauth-completed'
  | 'profile-removed'
  | 'provider-logout';

export type DesktopAuthSyncIntent = {
  providerId: string;
  reason: DesktopAuthUpdateReason;
  revision: number;
};

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
  providerId?: string;
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

export function desktopAuthSyncIntentFromAnotherSource(
  value: unknown,
  currentSourceId = desktopAuthSourceId,
): DesktopAuthSyncIntent | null {
  if (
    !isDesktopAuthUpdatedMessage(value)
    || value.sourceId === currentSourceId
    || !value.reason
    || !value.providerId?.trim()
  ) return null;
  return {
    providerId: value.providerId.trim(),
    reason: value.reason,
    revision: value.at,
  };
}

export function broadcastDesktopAuthUpdated(
  reason: DesktopAuthUpdateReason,
  providerId?: string,
) {
  if (typeof BroadcastChannel === 'undefined') return;

  try {
    const channel = new BroadcastChannel(DESKTOP_AUTH_CHANNEL_NAME);
    channel.postMessage({
      type: DESKTOP_AUTH_UPDATED_MESSAGE_TYPE,
      at: Date.now(),
      sourceId: desktopAuthSourceId,
      reason,
      providerId: providerId?.trim() || undefined,
    } satisfies DesktopAuthUpdatedMessage);
    channel.close();
  } catch {
    // Focus-driven refresh remains the fallback when BroadcastChannel is unavailable.
  }
}
