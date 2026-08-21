import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useCallback, useEffect, useState } from 'react';

import type { CloudGroupInvitationAcceptance } from './cloudIdentityTypes';

const GROUP_INVITATION_TOKEN_PATTERN = /^kordi_gi_[A-Za-z0-9_-]{43}$/;
const GROUP_INVITATION_STORAGE_KEY = 'kordi.pendingGroupInvitation.v1';

export const CLOUD_GROUP_INVITATION_ACCEPTED_EVENT = 'kordi-cloud-group-invitation-accepted';

export type CloudGroupInvitationAcceptedDetail = Pick<
  CloudGroupInvitationAcceptance,
  'groupId' | 'groupSpaceId' | 'groupTitle'
>;

export function groupInvitationTokenFromUrl(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  if (GROUP_INVITATION_TOKEN_PATTERN.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const trustedWebHost = ['kordi.ai', 'www.kordi.ai']
      .includes(url.hostname.toLowerCase());
    const candidate = url.protocol === 'kordi:' && url.hostname === 'group-invite'
      ? pathParts[0]
      : url.protocol === 'https:' && trustedWebHost && pathParts[0] === 'g'
        ? pathParts[1]
        : null;
    return candidate && GROUP_INVITATION_TOKEN_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function readStoredGroupInvitationToken(): string | null {
  if (typeof window === 'undefined') return null;
  return groupInvitationTokenFromUrl(window.localStorage.getItem(GROUP_INVITATION_STORAGE_KEY));
}

function storeGroupInvitationToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(GROUP_INVITATION_STORAGE_KEY, token);
  else window.localStorage.removeItem(GROUP_INVITATION_STORAGE_KEY);
}

export function dispatchCloudGroupInvitationAccepted(detail: CloudGroupInvitationAcceptedDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CloudGroupInvitationAcceptedDetail>(
    CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
    { detail },
  ));
}

export function usePendingGroupInvitation() {
  const [token, setToken] = useState<string | null>(() => {
    const initial = readStoredGroupInvitationToken()
      ?? (typeof window === 'undefined' || typeof window.location?.href !== 'string'
        ? null
        : groupInvitationTokenFromUrl(window.location.href));
    if (initial) storeGroupInvitationToken(initial);
    return initial;
  });

  const remember = useCallback((candidate: string | null | undefined) => {
    const next = groupInvitationTokenFromUrl(candidate);
    if (!next) return;
    storeGroupInvitationToken(next);
    setToken(next);
  }, []);

  const dismiss = useCallback(() => {
    storeGroupInvitationToken(null);
    setToken(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;

    void getCurrent()
      .then((urls) => {
        if (disposed) return;
        urls?.forEach(remember);
      })
      .catch(() => undefined);
    void onOpenUrl((urls) => {
      urls.forEach(remember);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [remember]);

  return { token, dismiss };
}
