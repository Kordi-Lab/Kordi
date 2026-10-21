import { useState } from 'react';

import type { AppDialogAnchor } from '@/components/ui/dialog';
import { DeleteProfileDialog, NewProfileDialog, ProfileFieldDialog, ProfileMenu, type CgProfileMenuAction } from './ProfileDialogs';
import { takenKinds } from './profiles';
import type { CgState, CommonGroundStore } from './store';
import type { CgProfile } from './types';

type Open =
  | { name: 'menu'; profile: CgProfile; anchor: AppDialogAnchor | null }
  | { name: 'field'; profile: CgProfile; field: 'name' | 'focus' }
  | { name: 'delete'; profile: CgProfile }
  | { name: 'new' };

function anchorOf(element: Element): AppDialogAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** The profile menu and the dialogs it opens; `element` renders whichever is open. */
export function useProfileMenu(state: CgState, store: CommonGroundStore) {
  const [open, setOpen] = useState<Open | null>(null);
  const close = () => setOpen(null);
  const busy = state.busy === 'profile';
  const pick = (profile: CgProfile, action: CgProfileMenuAction) => {
    setOpen(action === 'delete' ? { name: 'delete', profile } : { name: 'field', profile, field: action });
  };
  let element = null;
  if (open?.name === 'menu') {
    element = <ProfileMenu anchor={open.anchor} onDismiss={close} onPick={(action) => pick(open.profile, action)} />;
  } else if (open?.name === 'field') {
    element = (
      <ProfileFieldDialog
        profile={open.profile}
        field={open.field}
        busy={busy}
        notice={state.notice}
        onCancel={close}
        onSave={(value) => void store.updateProfile(open.profile.profileId, { [open.field]: value }).then((ok) => { if (ok) close(); })}
      />
    );
  } else if (open?.name === 'delete') {
    element = (
      <DeleteProfileDialog
        profile={open.profile}
        busy={busy}
        onCancel={close}
        onDelete={() => void store.deleteProfile(open.profile.profileId).then(close)}
      />
    );
  } else if (open?.name === 'new') {
    element = (
      <NewProfileDialog
        taken={takenKinds(state.profiles)}
        busy={busy}
        notice={state.notice}
        onCancel={close}
        onCreate={(input) => void store.createProfile(input).then((ok) => { if (ok) close(); })}
      />
    );
  }
  return {
    element,
    openMenu: (profile: CgProfile, target: Element | null) => setOpen({ name: 'menu', profile, anchor: target ? anchorOf(target) : null }),
    openNew: () => setOpen({ name: 'new' }),
  };
}
