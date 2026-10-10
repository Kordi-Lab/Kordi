import type { FormEvent } from 'react';
import { Pencil } from 'lucide-react';

/** The group dialog's "Group settings" section: the group name row and its rename form. */
export function GroupNameSettings({
  title,
  canManageGroup,
  pendingAction,
  isEditingName,
  nameDraft,
  nameInputId,
  onToggleEditing,
  onNameDraftChange,
  onCancel,
  onSubmit,
}: {
  title: string;
  canManageGroup: boolean;
  pendingAction: string | null;
  isEditingName: boolean;
  nameDraft: string;
  nameInputId: string;
  onToggleEditing: () => void;
  onNameDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section aria-label="Group settings" className="app-group-management-settings mt-3 border-t pt-1">
      <button
        type="button"
        className="app-transient-flat-action app-group-management-setting-row flex w-full items-center gap-3 rounded-[10px] px-1.5 py-2.5 text-left"
        disabled={!canManageGroup || Boolean(pendingAction)}
        aria-expanded={isEditingName}
        onClick={onToggleEditing}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium">Group name</span>
          <span className="mt-0.5 block truncate text-[10px] text-[color:var(--utility-muted-text)]">{title}</span>
        </span>
        {canManageGroup ? <Pencil className="h-3.5 w-3.5 text-[color:var(--utility-muted-text)]" /> : null}
      </button>

      {isEditingName ? (
        <form className="app-group-management-name-form px-1.5 pb-2" onSubmit={onSubmit}>
          <label htmlFor={nameInputId} className="sr-only">Group name</label>
          <input
            id={nameInputId}
            value={nameDraft}
            onChange={(event) => onNameDraftChange(event.target.value)}
            className="app-input-shell h-9 w-full rounded-[11px] px-3 text-[12px] outline-none"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              className="app-transient-flat-action rounded-[9px] px-2.5 py-1.5 text-[10px]"
              disabled={pendingAction === 'rename'}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="app-button-primary rounded-[9px] px-2.5 py-1.5 text-[10px]"
              disabled={!nameDraft.trim() || nameDraft.trim() === title.trim() || Boolean(pendingAction)}
            >
              {pendingAction === 'rename' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
