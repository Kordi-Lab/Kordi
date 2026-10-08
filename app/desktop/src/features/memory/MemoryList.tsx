import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import type { MemoryClient } from './memoryClient';
import {
  LESSON_MAX_CHARS,
  groupLessonsByScope,
  lessonDateLabel,
  lessonSourceLabel,
  memoryErrorMessage,
  validateLessonText,
  type MemoryLesson,
} from './memoryModel';

// AppDialog portals to document.body, outside `.kordi-app`, so dialog content
// uses the body-scoped transient tokens instead of the slate classes.
const dialogMuted = 'text-[color:var(--app-transient-muted-text)]';
const popoverMuted = 'text-[color:var(--app-transient-muted-text)]';

export const quietButtonClass = 'h-8 rounded-lg px-3 text-[12px]';
export const destructiveConfirmClass = 'app-transient-flat-action-danger rounded-full px-4 font-semibold';
const compactActionClass = 'app-transient-flat-action rounded-[9px] px-2 py-1 text-[10px]';

type LessonEdit = { lessonId: string; draft: string; error: string | null; busy: boolean };

export type MemoryListProps = {
  client: MemoryClient;
  lessons: MemoryLesson[];
  /** Receives an updater so callers can keep memories this list does not show. */
  onLessonsChange: (update: (current: MemoryLesson[]) => MemoryLesson[]) => void;
  emptyLabel: string;
  /** Settings rows grouped under scope headings. The group info page lists one scope flat. */
  groupByScope?: boolean;
  /** Small rows sized for the group info popover. */
  compact?: boolean;
  /** Called after an edit or delete reaches the client. */
  onChanged?: () => void;
};

function lessonPrefix(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32).trimEnd()}…` : text;
}

/** Memory rows with inline editing and a confirmed delete, shared by settings and group info. */
export function MemoryList({
  client,
  lessons,
  onLessonsChange,
  emptyLabel,
  groupByScope = false,
  compact = false,
  onChanged,
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
    setEdit({ ...edit, busy: true, error: null });
    try {
      const updated = await client.updateLesson(lessonId, validation.text);
      onLessonsChange((current) => current.map((entry) => (entry.lessonId === lessonId ? updated : entry)));
      setEdit(null);
      setStatusMessage('Memory saved.');
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

  const renderEditor = (lesson: MemoryLesson, current: LessonEdit, meta: string) => {
    const editorId = `${idPrefix}-edit-${lesson.lessonId}`;
    const errorId = `${editorId}-error`;
    const editor = (
      <>
        <textarea
          id={editorId}
          aria-label={`Edit memory: ${lessonPrefix(lesson.text)}`}
          aria-invalid={current.error ? true : undefined}
          aria-describedby={current.error ? errorId : undefined}
          value={current.draft}
          disabled={current.busy}
          rows={compact ? 4 : 3}
          autoFocus
          onChange={(event) => setEdit({ ...current, draft: event.target.value, error: null })}
          className={cn(
            'app-input-shell app-flat-input block w-full resize-y outline-none',
            compact ? 'rounded-[11px] px-2.5 py-2 text-[11px] leading-4' : 'rounded-lg px-3 py-2 text-[13px] leading-5 text-white placeholder:text-slate-500',
          )}
        />
        {current.error ? (
          <p id={errorId} className={cn('app-error-text m-0 mt-2 leading-5 text-rose-300', compact ? 'text-[10px]' : 'text-[12px]')} role="alert">{current.error}</p>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={cn(
            'tabular-nums',
            compact ? 'text-[10px]' : 'text-[12px]',
            current.draft.length > LESSON_MAX_CHARS ? 'text-rose-300' : compact ? popoverMuted : 'text-slate-400',
          )}
          >
            {current.draft.length} / {LESSON_MAX_CHARS}
          </span>
          {compact ? (
            <span className="flex gap-1.5">
              <button type="button" className="app-transient-flat-action rounded-[9px] px-2.5 py-1.5 text-[10px]" disabled={current.busy} onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button type="button" className="app-button-primary rounded-[9px] px-2.5 py-1.5 text-[10px]" disabled={current.busy} onClick={() => { void saveEdit(); }}>
                {current.busy ? 'Saving…' : 'Save'}
              </button>
            </span>
          ) : (
            <span className="flex gap-2">
              <Button type="button" variant="quiet" className={quietButtonClass} disabled={current.busy} onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={current.busy} onClick={() => { void saveEdit(); }}>
                {current.busy ? 'Saving…' : 'Save'}
              </Button>
            </span>
          )}
        </div>
      </>
    );
    if (compact) {
      return (
        <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId} className="py-2">
          <p className={cn('m-0 mb-1.5 text-[10px]', popoverMuted)}>{meta}</p>
          {editor}
        </div>
      );
    }
    return (
      <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId}>
        <SettingsRow title={<span className="font-normal text-slate-400">{meta}</span>}>{editor}</SettingsRow>
      </div>
    );
  };

  const renderLesson = (lesson: MemoryLesson) => {
    // The group page already names the group, so its rows leave out the scope label.
    const meta = compact
      ? `${lessonSourceLabel(lesson.source)} · ${lessonDateLabel(lesson.updatedAt)}`
      : `${lessonSourceLabel(lesson.source)} · ${lesson.scopeLabel} · ${lessonDateLabel(lesson.updatedAt)}`;
    if (edit?.lessonId === lesson.lessonId) return renderEditor(lesson, edit, meta);
    const prefix = lessonPrefix(lesson.text);
    const startEdit = () => setEdit({ lessonId: lesson.lessonId, draft: lesson.text, error: null, busy: false });
    if (compact) {
      return (
        <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId} className="py-2">
          <p className="m-0 whitespace-normal break-words text-[11px] leading-4">{lesson.text}</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className={cn('min-w-0 text-[10px] leading-4', popoverMuted)}>{meta}</span>
            <span className="flex shrink-0 gap-1">
              <button type="button" className={compactActionClass} aria-label={`Edit memory: ${prefix}`} onClick={startEdit}>Edit</button>
              <button type="button" className={compactActionClass} aria-label={`Delete memory: ${prefix}`} onClick={() => setPendingDelete(lesson)}>Delete</button>
            </span>
          </div>
        </div>
      );
    }
    return (
      <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId}>
        <SettingsRow
          title={<span className="block whitespace-normal break-words text-[13px] font-normal leading-5">{lesson.text}</span>}
          description={meta}
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

  const sorted = [...lessons].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let rows: ReactNode;
  if (lessons.length === 0) {
    rows = compact ? (
      <div className="app-group-management-empty rounded-[11px] px-2.5 py-3 text-center text-[11px]">{emptyLabel}</div>
    ) : (
      <SettingsRow title={<span className="font-normal text-slate-400">{emptyLabel}</span>} />
    );
  } else if (groupByScope) {
    rows = groupLessonsByScope(lessons).map((group) => (
      <SettingsSection key={group.scope} title={group.label} size="compact">
        {group.lessons.map(renderLesson)}
      </SettingsSection>
    ));
  } else {
    rows = compact
      ? <div className="divide-y divide-[color:var(--app-transient-divider)]">{sorted.map(renderLesson)}</div>
      : sorted.map(renderLesson);
  }

  return (
    <>
      <p className="sr-only" aria-live="polite">{statusMessage}</p>
      {error ? (
        <p
          className={cn(
            compact
              ? 'app-group-management-error mb-2 rounded-[11px] px-2.5 py-2 text-[11px] leading-4'
              : 'app-error-text my-2 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100',
          )}
          role="alert"
        >
          {error}
        </p>
      ) : null}
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
