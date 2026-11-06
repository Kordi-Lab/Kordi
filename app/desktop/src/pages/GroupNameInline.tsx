import type { FormEvent } from 'react';
import { Check, LoaderCircle, Pencil } from 'lucide-react';

import { groupNameIsValid } from '@/features/chat/groupCreateCopy';

const TITLE_CLASS = 'block truncate text-[16px] font-semibold leading-5';

/**
 * The group Info title. Admins click it, or its pencil, to rename the group in
 * place: the title becomes a centred input of the same height with a small
 * check button. Enter saves; the owning panel handles Escape.
 */
export function GroupNameInline({
  title,
  canRename,
  isEditing,
  draft,
  saving,
  inputId,
  onStartEditing,
  onDraftChange,
  onSubmit,
}: {
  title: string;
  canRename: boolean;
  isEditing: boolean;
  draft: string;
  saving: boolean;
  inputId: string;
  onStartEditing: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  if (!canRename) {
    return <div className={TITLE_CLASS} title={title}>{title}</div>;
  }
  if (isEditing) {
    const canSave = !saving && groupNameIsValid(draft) && draft.trim() !== title.trim();
    return (
      <form className="app-group-name-form" data-group-name-form onSubmit={onSubmit}>
        <input
          id={inputId}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          aria-label="Group name"
          required
          readOnly={saving}
          autoComplete="off"
          spellCheck={false}
          className="app-group-name-input"
        />
        <button
          type="submit"
          className="app-group-name-save"
          aria-label="Save name"
          aria-busy={saving || undefined}
          disabled={!canSave}
        >
          {saving
            ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <Check className="h-3 w-3" aria-hidden="true" />}
        </button>
      </form>
    );
  }
  return (
    <button
      type="button"
      className="app-group-name-button"
      aria-label={`Rename ${title}`}
      title="Rename"
      onClick={onStartEditing}
    >
      <span className={TITLE_CLASS}>{title}</span>
      <span className="app-group-name-pencil" aria-hidden="true">
        <Pencil className="h-3 w-3" />
      </span>
    </button>
  );
}
