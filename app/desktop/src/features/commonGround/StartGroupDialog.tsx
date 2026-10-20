import { useId, useState } from 'react';
import { Check } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CgAvatar, CgButton } from './parts';
import type { CgPerson } from './types';

export function StartGroupDialog({ name, people, selected, busy, onCancel, onCreate }: {
  name: string;
  people: CgPerson[];
  selected: string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string, memberIds: string[]) => void;
}) {
  const titleId = useId();
  const [groupName, setGroupName] = useState(name);
  const [ids, setIds] = useState<string[]>(selected);
  const toggle = (id: string) => setIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy}>
      <AppDialogTitle id={titleId}>Start group</AppDialogTitle>
      <form
        className="cg-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (groupName.trim() && ids.length) onCreate(groupName.trim(), ids);
        }}
      >
        <input className="cg-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} aria-label="Group name" maxLength={80} />
        <div className="cg-pick-list" role="group" aria-label="Members">
          {people.map((person) => {
            const on = ids.includes(person.accountId);
            return (
              <button key={person.accountId} type="button" role="checkbox" aria-checked={on} className={cn('cg-pick', on && 'is-on')} onClick={() => toggle(person.accountId)}>
                <CgAvatar person={person} size={28} />
                <span className="cg-row-title">{person.name}</span>
                <span className="cg-check" aria-hidden="true">{on ? <Check className="h-3.5 w-3.5" /> : null}</span>
              </button>
            );
          })}
        </div>
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !groupName.trim() || !ids.length}>Create</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
