import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { profileDesign } from './cardDesign';
import { CardLookButton, CardLookPopover } from './CardLookPopover';
import { useLookPopover } from './cardLook';
import { RenameFields } from './CardScreen';
import { renamePatch } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';

/** Your card before its first build: set the colour, icon and name, then Build. */
export function UnbuiltCardRow({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [renaming, setRenaming] = useState(false);
  const look = useLookPopover();
  const profile = currentProfile(state);
  const building = state.owner?.build.status === 'building';
  if (!profile) return null;
  const design = profileDesign(profile);
  return (
    <div className="cg-panel">
      <div className="cg-mrow cg-unbuilt">
        <span className="cg-look-anchor">
          <CardLookButton design={design} icon={profile.icon} kind={profile.kind} className="cg-cardpage-glyph" open={look.open} onToggle={look.toggle} />
          {look.open ? (
            <CardLookPopover
              design={design}
              icon={profile.icon}
              onClose={look.close}
              onDesign={(next) => void store.setLook(profile.profileId, { design: next })}
              onIcon={(next) => void store.setLook(profile.profileId, { icon: next })}
            />
          ) : null}
        </span>
        {renaming ? (
          <span className="cg-mrow-text">
            <RenameFields
              name={profile.name}
              focus={profile.focus ?? ''}
              kind={profile.kind}
              onCancel={() => setRenaming(false)}
              onSave={(nextName, nextFocus) => {
                setRenaming(false);
                const patch = renamePatch(profile, nextName, nextFocus);
                if (Object.keys(patch).length) void store.updateProfile(profile.profileId, patch);
              }}
            />
          </span>
        ) : (
          <>
            <span className="cg-mrow-text">
              <span className="cg-mrow-title">{profile.name}</span>
              <span className="cg-mrow-sub">{building ? 'Building' : 'Not built'}</span>
            </span>
            <button type="button" className="cg-mbtn is-ghost" aria-label={`Rename ${profile.name}`} onClick={() => setRenaming(true)}>
              <Pencil className="h-[13px] w-[13px]" aria-hidden="true" />
            </button>
          </>
        )}
        {building || renaming ? null : <button type="button" className="cg-mbtn is-tint" onClick={() => store.open({ name: 'build' })}>Build</button>}
      </div>
    </div>
  );
}
