import {
  parseGeneratedAvatarMarker,
  type CanonicalAvatarMutation,
} from './canonicalAvatar';

export function defaultCloudAgentId(ownerAccountId: string): string {
  const owner = ownerAccountId.trim();
  return owner ? `cloud-agent:${owner}` : '';
}

export function cloudAgentId(
  agentId: string | null | undefined,
  ownerAccountId: string,
): string {
  return agentId?.trim() || defaultCloudAgentId(ownerAccountId);
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
