import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiAppMutationActions } from '@/app/useKordiAppMutationActions';
import { useKordiAppRuntimeActions } from '@/app/useKordiAppRuntimeActions';
import type { KordiWorkspaceState } from '@/app/useKordiWorkspaceState';

export function useKordiAppActions({
  foundation,
  workspace,
}: {
  foundation: KordiAppFoundation;
  workspace: KordiWorkspaceState;
}) {
  const runtime = useKordiAppRuntimeActions({ foundation, workspace });
  const mutations = useKordiAppMutationActions({
    foundation,
    workspace,
    runtime,
  });

  return {
    ...runtime,
    ...mutations,
    composer: {
      ...runtime.composer,
      ...mutations.composer,
    },
  };
}

export type KordiAppActions = ReturnType<typeof useKordiAppActions>;
