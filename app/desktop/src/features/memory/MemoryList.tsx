import { Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { SettingsRow } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import { MemoryCategoryChip } from './MemoryCategoryChip';
import type { MemoryClient } from './memoryClient';
import {
  LESSON_MAX_CHARS,
  lessonDateLabel,
  lessonSourceLabel,
  memoryErrorMessage,
  memoryAddedBy,
  memoryOwnerCaption,
  validateLessonText,
  type MemoryAddTarget,
  type MemoryLesson,
} from './memoryModel';

// AppDialog portals to document.body, outside `.kordi-app`, so dialog content
// uses the body-scoped transient tokens instead of the slate classes.
const dialogMuted = 'text-[color:var(--app-transient-muted-text)]';

export const quietButtonClass = 'h-8 rounded-lg px-3 text-[12px]';
export const destructiveConfirmClass = 'app-transient-danger-button rounded-full px-4 font-semibold';

/** The memory being edited; `lessonId` is null while a new memory is typed. */
type LessonEdit = { lessonId: string | null; draft: string; error: string | null; busy: boolean };

export type MemoryListProps = {
  client: MemoryClient;
  lessons: MemoryLesson[];
  /** Receives an updater so callers can keep memories this list does not show. */
  onLessonsChange: (update: (current: MemoryLesson[]) => MemoryLesson[]) => void;
  emptyLabel: string;
  /** Called after an edit or delete reaches the client. */
  onChanged?: () => void;
  /** The signed-in account; group memories other members saved show who saved them. */
  viewerAccountId?: string | null;
  /** Where a memory added from this list is saved. Without it the list has no Add memory row. */
  addTarget?: MemoryAddTarget | null;
};

function lessonPrefix(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32).trimEnd()}…` : text;
}

/** Memory rows with inline editing and a confirmed delete, shared by settings and each conversation's Memory tab. */
export function MemoryList({
  client,
  lessons,
  onLessonsChange,
  emptyLabel,
  onChanged,
  viewerAccountId,
  addTarget,
}: MemoryListProps) {
  const [edit, setEdit] = useState<LessonEdit | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryLesson | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const idPrefix = useId();

  const saveEdit = async () => {
    if (!edit || edit.busy) return;
    const validation = validateLessonText(edit.draft);
    if (!validation.ok) {
      setEdit({ ...edit, error: validation.reason });
      return;
    }
    const lessonId = edit.lessonId;
    const target = lessonId === null ? addTarget : null;
    if (lessonId === null && !target) return;
    setEdit({ ...edit, busy: true, error: null });
    try {
      if (target) {
        const created = await client.createLesson(target, validation.text);
        // Saving text the scope already has returns that memory, so replace it instead of listing it twice.
        onLessonsChange((current) => [created, ...current.filter((entry) => entry.lessonId !== created.lessonId)]);
        setStatusMessage('Memory added.');
      } else if (lessonId !== null) {
        const updated = await client.updateLesson(lessonId, validation.text);
        onLessonsChange((current) => current.map((entry) => (entry.lessonId === lessonId ? updated : entry)));
        setStatusMessage('Memory saved.');
      }
      setEdit(null);
      onChanged?.();
    } catch (caught) {
      setEdit((current) => (current?.lessonId === lessonId
        ? { ...current, busy: false, error: memoryErrorMessage(caught, 'Could not save this memory. Try again.') }
        : current));
    }
  };

  const closeDelete = () => {
    if (!deleteBusy) setPendingDelete(null);
  };

  const confirmDelete = async (lesson: MemoryLesson) => {
    setDeleteBusy(true);
    setError(null);
    try {
      await client.archiveLesson(lesson.lessonId);
      onLessonsChange((current) => current.filter((entry) => entry.lessonId !== lesson.lessonId));
      setEdit((current) => (current?.lessonId === lesson.lessonId ? null : current));
      setStatusMessage('Memory deleted.');
      onChanged?.();
    } catch (caught) {
      setError(memoryErrorMessage(caught, 'Could not delete this memory. Try again.'));
    } finally {
      setPendingDelete(null);
      setDeleteBusy(false);
    }
  };

  const renderEditor = (lesson: MemoryLesson | null, current: LessonEdit, meta: string) => {
    const editorId = `${idPrefix}-edit-${lesson?.lessonId ?? 'new'}`;
    const errorId = `${editorId}-error`;
    const editor = (
      <>
        <textarea
          id={editorId}
          aria-label={lesson ? `Edit memory: ${lessonPrefix(lesson.text)}` : 'New memory'}
          aria-invalid={current.error ? true : undefined}
          aria-describedby={current.error ? errorId : undefined}
          value={current.draft}
          disabled={current.busy}
          rows={3}
          autoFocus
          onChange={(event) => setEdit({ ...current, draft: event.target.value, error: null })}
          className="app-input-shell app-flat-input block w-full resize-y rounded-lg px-3 py-2 text-[13px] leading-5 text-white outline-none placeholder:text-slate-500"
        />
        {current.error ? (
          <p id={errorId} className="app-error-text m-0 mt-2 text-[12px] leading-5 text-rose-300" role="alert">{current.error}</p>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={cn('text-[12px] tabular-nums', current.draft.length > LESSON_MAX_CHARS ? 'text-rose-300' : 'text-slate-400')}>
            {current.draft.length} / {LESSON_MAX_CHARS}
          </span>
          <span className="flex gap-2">
            <Button type="button" variant="quiet" className={quietButtonClass} disabled={current.busy} onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={current.busy} onClick={() => { void saveEdit(); }}>
              {current.busy ? 'Saving…' : 'Save'}
            </Button>
          </span>
        </div>
      </>
    );
    const row = <SettingsRow title={<span className="font-normal text-slate-400">{meta}</span>}>{editor}</SettingsRow>;
    return lesson
      ? <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId}>{row}</div>
      : <div data-memory-new="">{row}</div>;
  };

  const startAdd = () => setEdit({ lessonId: null, draft: '', error: null, busy: false });
  const addRow: ReactNode = !addTarget ? null : edit?.lessonId === null
    ? renderEditor(null, edit, 'New memory')
    : (
      <div data-memory-add="" className="my-1">
        <Button type="button" variant="quiet" className={cn(quietButtonClass, 'gap-1.5 px-2')} onClick={startAdd}>
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add memory
        </Button>
      </div>
    );

  const renderLesson = (lesson: MemoryLesson) => {
    // Settings list only global memories and each conversation lists its own, so rows leave out the scope label.
    const meta = `${lessonSourceLabel(lesson.source, memoryAddedBy(lesson, viewerAccountId))} · ${lessonDateLabel(lesson.updatedAt)}`;
    if (edit?.lessonId === lesson.lessonId) return renderEditor(lesson, edit, meta);
    const prefix = lessonPrefix(lesson.text);
    const owner = memoryOwnerCaption(lesson, viewerAccountId);
    const startEdit = () => setEdit({ lessonId: lesson.lessonId, draft: lesson.text, error: null, busy: false });
    return (
      <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId}>
        <SettingsRow
          title={<span className="block whitespace-normal break-words text-[13px] font-normal leading-5">{lesson.text}</span>}
          description={<>{meta}<MemoryCategoryChip category={lesson.category} />{owner ? <span data-memory-owner="" className="block">{owner}</span> : null}</>}
          control={(
            <>
              <Button type="button" variant="quiet" className={quietButtonClass} aria-label={`Edit memory: ${prefix}`} onClick={startEdit}>
                Edit
              </Button>
              <Button type="button" variant="quiet" className={quietButtonClass} aria-label={`Delete memory: ${prefix}`} onClick={() => setPendingDelete(lesson)}>
                Delete
              </Button>
            </>
          )}
        />
      </div>
    );
  };

  const rows: ReactNode = lessons.length === 0
    ? <SettingsRow title={<span className="font-normal text-slate-400">{emptyLabel}</span>} />
    : [...lessons].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(renderLesson);

  return (
    <>
      <p className="sr-only" aria-live="polite">{statusMessage}</p>
      {error ? (
        <p className="app-error-text my-2 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          {error}
        </p>
      ) : null}
      {addRow}
      {rows}
      {pendingDelete ? (
        <AppDialog
          titleId={`${idPrefix}-delete-title`}
          descriptionId={`${idPrefix}-delete-description`}
          onDismiss={closeDelete}
          dismissDisabled={deleteBusy}
          busy={deleteBusy}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id={`${idPrefix}-delete-title`}>Delete this memory?</AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-delete-description`}>
            Kordi will not read it again on any device. This cannot be undone.
          </AppDialogDescription>
          <p className={cn('m-0 mt-3 line-clamp-3 text-[13px] leading-5', dialogMuted)}>{pendingDelete.text}</p>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={deleteBusy} onClick={closeDelete}>Cancel</Button>
            <Button className={destructiveConfirmClass} disabled={deleteBusy} onClick={() => { void confirmDelete(pendingDelete); }}>
              Delete
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </>
  );
}
