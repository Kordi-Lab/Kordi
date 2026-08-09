import { useKordiAppActions } from '@/app/useKordiAppActions';
import { useKordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiAppShellComposition } from '@/app/useKordiAppShellComposition';
import { useKordiWorkspaceState } from '@/app/useKordiWorkspaceState';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';

export function useKordiAppModel({
  cloudSessionOverride,
}: {
  cloudSessionOverride?: UseCloudSessionResult;
} = {}) {
  const foundation = useKordiAppFoundation({ cloudSessionOverride });
  // Transcript mapping runs while composing this same render. Keep the stable
  // adapter seed current synchronously to avoid a one-render fallback-avatar
  // flash before workspace view-model composition.
  foundation.refs.syncLocalAvatarSeeds({
    human: foundation.profile.localProfileAvatarSeed,
    humanDisplayName: foundation.profile.localProfileDisplayName,
    humanProfileImageUrl: foundation.profile.localProfileImageUrl,
    agent: foundation.profile.localAgentAvatarSeed,
    agentDisplayName: foundation.profile.localAgentDisplayName,
    agentProfileImageUrl: foundation.profile.localAgentProfileImageUrl,
  });
  const workspace = useKordiWorkspaceState(foundation);
  const actions = useKordiAppActions({ foundation, workspace });

  return useKordiAppShellComposition({
    foundation,
    workspace,
    actions,
  });
}
