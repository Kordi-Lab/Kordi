import { useEffect, useRef, type FocusEvent } from 'react';
import { Check, LoaderCircle, Pencil } from 'lucide-react';

import { groupNameIsValid } from '@/features/chat/groupCreateCopy';

const TITLE_CLASS = 'block truncate text-[16px] font-semibold leading-5';

/**
 * The group Info title. Admins click it (or press Enter or Space on it) to
 * rename the group in place: the title becomes a centred input of the same
 * height with a small check button. Enter or leaving the field saves; the
 * owning panel handles Escape, which cancels.
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
  onCommit,
}: {
  title: string;
  canRename: boolean;
  isEditing: boolean;
  draft: string;
  saving: boolean;
  inputId: string;
  onStartEditing: () => void;
  onDraftChange: (value: string) => void;
  /** Saves the draft: Enter, the check button, or focus leaving the field. */
  onCommit: () => void;
}) {
  if (!canRename) {
    return <div className={TITLE_CLASS} title={title}>{title}</div>;
  }
  if (isEditing) {
    return (
      <GroupNameField title={title} draft={draft} saving={saving} inputId={inputId}
        onDraftChange={onDraftChange} onCommit={onCommit} />
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

function GroupNameField({
  title,
  draft,
  saving,
  inputId,
  onDraftChange,
  onCommit,
}: {
  title: string;
  draft: string;
  saving: boolean;
  inputId: string;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const canSave = !saving && groupNameIsValid(draft) && draft.trim() !== title.trim();
  const commitOnBlur = (event: FocusEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    // The window lost focus (another app); the field is still the active element.
    if (input.ownerDocument.activeElement === input) return;
    // Escape unmounts the field, and some engines blur it on the way out: skip that blur.
    queueMicrotask(() => {
      if (input.isConnected) onCommit();
    });
  };
  return (
    <form
      className="app-group-name-form"
      data-group-name-form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onCommit();
      }}
    >
      <input
        ref={inputRef}
        id={inputId}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={commitOnBlur}
        onKeyDown={(event) => {
          // Browsers skip Enter submission while Save is disabled, and an empty name still needs its error.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onCommit();
        }}
        aria-label="Group name"
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
        // Keep focus in the field so the click saves once, not blur and then submit.
        onMouseDown={(event) => event.preventDefault()}
      >
        {saving
          ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Check className="h-3 w-3" aria-hidden="true" />}
      </button>
    </form>
  );
}
