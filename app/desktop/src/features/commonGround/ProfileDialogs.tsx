import { useId, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle, type AppDialogAnchor } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CgButton, CgNotice } from './parts';
import { PROFILE_FOCUS_MAX, PROFILE_KINDS, PROFILE_NAME_MAX } from './profiles';
import type { CgProfile, CgProfileInput, CgProfileKind } from './types';

/** Work, Health, Daily tasks, Custom; fixed kinds the account has are disabled. */
export function KindPicker({ value, taken = [], onChange, label }: {
  value: CgProfileKind;
  taken?: CgProfileKind[];
  onChange: (kind: CgProfileKind) => void;
  label: string;
}) {
  return (
    <div className="cg-seg cg-kinds" role="radiogroup" aria-label={label}>
      {PROFILE_KINDS.map(([kind, text]) => (
        <button
          key={kind}
          type="button"
          role="radio"
          aria-checked={value === kind}
          className={cn(value === kind && 'is-on')}
          disabled={taken.includes(kind)}
          onClick={() => onChange(kind)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function NewProfileDialog({ taken, busy, notice, onCancel, onCreate }: {
  taken: CgProfileKind[];
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onCreate: (input: CgProfileInput) => void;
}) {
  const titleId = useId();
  const [kind, setKind] = useState<CgProfileKind>(PROFILE_KINDS.find(([key]) => !taken.includes(key))?.[0] ?? 'custom');
  const [name, setName] = useState('');
  const [focus, setFocus] = useState('');
  const ready = kind !== 'custom' || Boolean(name.trim());
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>New profile</AppDialogTitle>
      <form
        className="cg-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onCreate({ kind, name: kind === 'custom' ? name : undefined, focus });
        }}
      >
        <KindPicker value={kind} taken={taken} onChange={setKind} label="Profile kind" />
        {kind === 'custom' ? (
          <input autoFocus className="cg-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, like KAUST" aria-label="Name" maxLength={PROFILE_NAME_MAX} />
        ) : null}
        <input className="cg-input" value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="Focus (optional)" aria-label="Focus" maxLength={PROFILE_FOCUS_MAX} />
        <CgNotice text={notice} />
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !ready}>Create</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}

/** Rename, or edit the focus line; an empty focus clears it. */
export function ProfileFieldDialog({ profile, field, busy, notice, onCancel, onSave }: {
  profile: CgProfile;
  field: 'name' | 'focus';
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const titleId = useId();
  const [value, setValue] = useState(field === 'name' ? profile.name : profile.focus ?? '');
  const needsName = field === 'name' && profile.kind === 'custom' && !value.trim();
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>{field === 'name' ? 'Rename profile' : 'Edit focus'}</AppDialogTitle>
      <form className="cg-form" onSubmit={(event) => { event.preventDefault(); if (!needsName) onSave(value.trim()); }}>
        <input
          autoFocus
          className="cg-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={field === 'name' ? 'Name' : 'Focus'}
          aria-label={field === 'name' ? 'Name' : 'Focus'}
          maxLength={field === 'name' ? PROFILE_NAME_MAX : PROFILE_FOCUS_MAX}
        />
        <CgNotice text={notice} />
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || needsName}>Save</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}

export function DeleteProfileDialog({ profile, busy, onCancel, onDelete }: { profile: CgProfile; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>Delete {profile.name}?</AppDialogTitle>
      <AppDialogDescription id={lineId}>Its card goes, and you leave rooms it was shared in.</AppDialogDescription>
      <AppDialogActions>
        <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
        <button type="button" className="cg-button is-danger" onClick={onDelete} disabled={busy}>Delete</button>
      </AppDialogActions>
    </AppDialog>
  );
}

export type CgProfileMenuAction = 'name' | 'focus' | 'delete';

/** Rename, Edit focus and Delete for one profile, beside the chip or button that opened it. */
export function ProfileMenu({ anchor, onPick, onDismiss }: { anchor: AppDialogAnchor | null; onPick: (action: CgProfileMenuAction) => void; onDismiss: () => void }) {
  const titleId = useId();
  const items: Array<[CgProfileMenuAction, string]> = [['name', 'Rename'], ['focus', 'Edit focus'], ['delete', 'Delete']];
  return (
    <AppDialog titleId={titleId} onDismiss={onDismiss} presentation="popover" anchorRect={anchor} className="cg-dialog">
      <span id={titleId} className="sr-only">Profile</span>
      <div className="cg-menu" role="menu">
        {items.map(([action, text]) => (
          <button key={action} type="button" role="menuitem" className={cn('cg-menu-item', action === 'delete' && 'is-danger')} onClick={() => onPick(action)}>
            {text}
          </button>
        ))}
      </div>
    </AppDialog>
  );
}
