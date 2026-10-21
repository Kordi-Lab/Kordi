import type { MouseEvent } from 'react';
import { Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { MAX_PROFILES } from './profiles';
import type { CgState, CommonGroundStore } from './store';
import { useProfileMenu } from './useProfileMenu';

/** Home's row of profile chips with "+"; right-click a chip for Rename, Edit focus and Delete. */
export function ProfileSwitcher({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const menu = useProfileMenu(state, store);
  return (
    <div className="cg-profiles" role="group" aria-label="Profiles">
      {state.profiles.map((profile) => (
        <button
          key={profile.profileId}
          type="button"
          className={cn('cg-chip', profile.profileId === state.profileId && 'is-on')}
          aria-pressed={profile.profileId === state.profileId}
          onClick={() => { if (profile.profileId !== state.profileId) void store.selectProfile(profile.profileId); }}
          onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            menu.openMenu(profile, event.currentTarget);
          }}
        >
          {profile.name}
        </button>
      ))}
      {state.profiles.length < MAX_PROFILES ? (
        <button type="button" className="cg-chip is-add" aria-label="New profile" onClick={menu.openNew}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {menu.element}
    </div>
  );
}
