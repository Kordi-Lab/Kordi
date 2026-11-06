import { distributionLinkTarget } from './distribution';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useCallback, useEffect, useState } from 'react';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import type { CloudGroupInvitationAcceptance } from './cloudIdentityTypes';

const GROUP_INVITATION_TOKEN_PATTERN = /^kordi_gi_[A-Za-z0-9_-]{43}$/;
const GROUP_INVITATION_STORAGE_KEY = 'kordi.pendingGroupInvitation.v1';

export const CLOUD_GROUP_INVITATION_ACCEPTED_EVENT = 'kordi-cloud-group-invitation-accepted';

export type CloudGroupInvitationAcceptedDetail = Pick<
  CloudGroupInvitationAcceptance,
  'groupId' | 'groupSpaceId' | 'groupTitle'
>;

function browserInvitationOrigin(): string | null {
  return isBrowserAppRuntime() ? window.location.origin : null;
}

export function groupInvitationTokenFromUrl(value: string | null | undefined, browserAppOrigin = browserInvitationOrigin()): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  if (GROUP_INVITATION_TOKEN_PATTERN.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const target = distributionLinkTarget();
    const trustedWebHost = url.origin === target.origin
      || url.origin === target.origin.replace('https://', 'https://www.');
    const browserInvitation = browserAppOrigin === url.origin
      && (url.pathname === '/app' || url.pathname.startsWith('/app/'))
      && url.searchParams.getAll('groupInvite').length === 1;
    const candidate = url.protocol === `${target.scheme}:` && url.hostname === 'group-invite'
      ? pathParts[0]
      : url.protocol === 'https:' && trustedWebHost && pathParts[0] === 'g'
        ? pathParts[1]
        : browserInvitation ? url.searchParams.get('groupInvite') : null;
    return candidate && GROUP_INVITATION_TOKEN_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Remove only the invitation handled by this dialog, retaining route state. */
export function browserPathAfterGroupInvitation(href: string, handledToken: string | null): string | null {
  const url = new URL(href);
  if (!handledToken || url.searchParams.get('groupInvite') !== handledToken) return null;
  url.searchParams.delete('groupInvite');
  return `${url.pathname}${url.search}${url.hash}`;
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
    const initial = (typeof window === 'undefined' || typeof window.location?.href !== 'string'
        ? null
        : groupInvitationTokenFromUrl(window.location.href))
      ?? readStoredGroupInvitationToken();
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
    if (isBrowserAppRuntime()) {
      const path = browserPathAfterGroupInvitation(window.location.href, token);
      if (path) {
        const state: unknown = window.history.state;
        window.history.replaceState(state, '', path);
      }
    }
    storeGroupInvitationToken(null);
    setToken(null);
  }, [token]);

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
