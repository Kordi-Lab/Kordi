import {
  canonicalAvatarImageSource,
  parseGeneratedAvatarMarker,
  type CanonicalAvatarMutation,
} from './canonicalAvatar';
import type { CanonicalIdentity, CanonicalSessionMessage } from '@/kordi-app/types';
import type { CloudAccount } from './authClient';
import { cloudAvatarImageUrl } from './avatar';

const LEGACY_DEFAULT_AGENT_PROFILE_MIGRATION_KEY = 'kordi.defaultAgentProfile.migratedAccount.v1';

type DefaultAgentProfileMigrationStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function legacyDefaultAgentProfileMigrationOwner(
  storage: DefaultAgentProfileMigrationStorage | null,
) {
  try {
    return storage?.getItem(LEGACY_DEFAULT_AGENT_PROFILE_MIGRATION_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function shouldMigrateLegacyDefaultAgentProfile(
  storage: DefaultAgentProfileMigrationStorage | null,
) {
  if (!storage) return false;
  try {
    return !storage.getItem(LEGACY_DEFAULT_AGENT_PROFILE_MIGRATION_KEY)?.trim();
  } catch {
    return false;
  }
}

export function markLegacyDefaultAgentProfileMigrated(
  storage: DefaultAgentProfileMigrationStorage | null,
  accountId: string,
) {
  const owner = accountId.trim();
  try {
    if (storage && owner) storage.setItem(LEGACY_DEFAULT_AGENT_PROFILE_MIGRATION_KEY, owner);
  } catch {
    // Server identity remains authoritative when browser storage is unavailable.
  }
}

export function defaultCloudAgentId(ownerAccountId: string): string {
  const owner = ownerAccountId.trim();
  return owner ? `cloud-agent:${owner}` : '';
}

export function cloudAgentId(
  agentId: string | null | undefined,
  ownerAccountId: string,
): string {
  const id = agentId?.trim();
  // Old local mirrors described execution location, not a separate agent.
  return !id || id === 'cloud-local-agent' || id === `cloud-self:${ownerAccountId.trim()}`
    ? defaultCloudAgentId(ownerAccountId)
    : id;
}

export function cloudAgentCanonicalIdentityId(
  agentId: string | null | undefined,
  ownerAccountId: string,
): string {
  return `agent:cloud-agent:${cloudAgentId(agentId, ownerAccountId)}`;
}

export function cloudAgentDisplayName(value?: string | null): string {
  return value?.trim() || 'Kordi';
}

export function cloudAgentOwnerAccountId(message: CanonicalSessionMessage): string {
  const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
    ? message.content as Record<string, unknown>
    : {};
  const recorded = typeof content.senderOwnerAccountId === 'string'
    ? content.senderOwnerAccountId.trim()
    : '';
  if (recorded) return recorded;
  const legacyPrefix = 'agent:cloud:';
  return message.senderIdentityId.startsWith(legacyPrefix)
    && !message.senderIdentityId.startsWith('agent:cloud-agent:')
    ? message.senderIdentityId.slice(legacyPrefix.length).trim()
    : '';
}

export function cloudAgentMessageOwnedBy(message: CanonicalSessionMessage, accountId: string) {
  const owner = accountId.trim();
  return Boolean(owner && cloudAgentOwnerAccountId(message) === owner);
}

export function cloudDefaultAgentPresentation(account: CloudAccount, label?: string | null) {
  const profile = account.defaultAgent;
  return {
    id: profile?.agentId?.trim() || defaultCloudAgentId(account.accountId),
    name: label?.trim() || profile?.displayName?.trim() || 'Kordi',
    avatarUrl: profile ? cloudAvatarImageUrl(canonicalAvatarImageSource(profile.avatar)) : null,
  };
}

export function cloudCanonicalDefaultAgentContactFields(identity: CanonicalIdentity, accountId: string) {
  const metadata = identity.metadata && typeof identity.metadata === 'object' && !Array.isArray(identity.metadata)
    ? identity.metadata as Record<string, unknown>
    : {};
  const text = (key: string) => typeof metadata[key] === 'string' && metadata[key].trim()
    ? metadata[key].trim()
    : null;
  return {
    targetCloudAgentId: text('defaultAgentId') ?? defaultCloudAgentId(accountId),
    targetCloudAgentName: text('defaultAgentDisplayName') ?? 'Kordi',
    targetCloudAgentOwnerAccountId: accountId,
    targetCloudAgentOwnerName: identity.displayName || accountId,
    targetCloudAgentAvatarUrl: text('defaultAgentAvatarUrl'),
    targetCloudAgentAvatarSeed: text('defaultAgentAvatarSeed') ?? defaultCloudAgentId(accountId),
  };
}

export function legacyDefaultAgentProfileUpdate({
  localName,
  localAvatar,
  remoteDisplayName,
  remoteAvatarVersion,
}: {
  localName: string;
  localAvatar: string | null;
  remoteDisplayName: string;
  remoteAvatarVersion: number;
}): {
  agentDisplayName?: string;
  agentAvatarMutation?: CanonicalAvatarMutation;
} | null {
  const name = localName.trim();
  const agentDisplayName = remoteDisplayName === 'Kordi' && name !== 'Kordi'
    ? name
    : undefined;
  let agentAvatarMutation: CanonicalAvatarMutation | undefined;
  if (localAvatar && remoteAvatarVersion === 1) {
    if (localAvatar.startsWith('data:image/')) {
      agentAvatarMutation = {
        action: 'upload',
        uploadedAsset: localAvatar,
        expectedVersion: remoteAvatarVersion,
      };
    } else {
      const markerSeed = parseGeneratedAvatarMarker(localAvatar)?.seed;
      const previewSeed = /\/v1\/avatars\/preview\/thumbs\/([^/.?]+)\.png/u.exec(localAvatar)?.[1];
      let seed = markerSeed;
      try {
        seed ||= previewSeed ? decodeURIComponent(previewSeed) : undefined;
      } catch {
        seed = undefined;
      }
      if (seed && /^[A-Za-z0-9_-]{1,128}$/u.test(seed)) {
        agentAvatarMutation = {
          action: 'regenerate',
          seed,
          expectedVersion: remoteAvatarVersion,
        };
      }
    }
  }
  return agentDisplayName || agentAvatarMutation
    ? { agentDisplayName, agentAvatarMutation }
    : null;
}
