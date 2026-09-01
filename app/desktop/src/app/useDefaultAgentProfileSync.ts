import { useEffect, useRef } from 'react';

import {
  legacyDefaultAgentProfileMigrationOwner,
  legacyDefaultAgentProfileUpdate,
  markLegacyDefaultAgentProfileMigrated,
  shouldMigrateLegacyDefaultAgentProfile,
} from '@/features/cloud/cloudAgentIdentity';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { getAvatarOverride } from '@/kordi-app/components/avatarOverrides';
import { renameDesktopAgent } from '@/lib/desktop';

export function useDefaultAgentProfileSync(
  cloudSession: UseCloudSessionResult,
  localAgentLabel: string | null | undefined,
  refreshDesktopChat: () => Promise<unknown>,
) {
  const syncRef = useRef<string | null>(null);
  useEffect(() => {
    const account = cloudSession.account;
    const remote = account?.defaultAgent;
    const localName = localAgentLabel?.trim();
    if (!account || !remote || !localName) return;
    let storage: Storage | null = null;
    try {
      storage = typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      storage = null;
    }
    const migrationOwner = legacyDefaultAgentProfileMigrationOwner(storage);
    const migration = shouldMigrateLegacyDefaultAgentProfile(storage) ? legacyDefaultAgentProfileUpdate({
      localName,
      localAvatar: getAvatarOverride('agent:cloud-local-agent'),
      remoteDisplayName: remote.displayName,
      remoteAvatarVersion: remote.avatar.version,
    }) : null;
    const syncKey = [account.accountId, localName, remote.displayName, remote.avatar.version, migrationOwner ?? 'unclaimed', Boolean(migration)].join(':');
    if (syncRef.current === syncKey) return;
    syncRef.current = syncKey;
    if (migration) {
      void cloudSession.updateProfile(migration)
        .then(() => markLegacyDefaultAgentProfileMigrated(storage, account.accountId))
        .catch(() => {
          if (syncRef.current === syncKey) syncRef.current = null;
        });
      return;
    }
    if (remote.displayName !== localName) {
      void renameDesktopAgent(remote.displayName)
        .then(() => refreshDesktopChat())
        .then(() => markLegacyDefaultAgentProfileMigrated(storage, account.accountId))
        .catch(() => {
          if (syncRef.current === syncKey) syncRef.current = null;
        });
      return;
    }
    markLegacyDefaultAgentProfileMigrated(storage, account.accountId);
  }, [cloudSession, localAgentLabel, refreshDesktopChat]);
}
