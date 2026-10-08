import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import type { MemoryClient } from './memoryClient';
import {
  LESSON_MAX_CHARS,
  forgetConsequences,
  groupLessonsByScope,
  lessonDateLabel,
  lessonSourceLabel,
  syncStatusLabel,
  validateLessonText,
  type MemoryLesson,
  type MemoryReplayState,
  type MemorySettings,
  type MemorySyncState,
} from './memoryModel';

// AppDialog portals to document.body, outside `.kordi-app`, so dialog content
// uses the body-scoped transient tokens instead of the slate classes.
const dialogMuted = 'text-[color:var(--app-transient-muted-text)]';

const quietButtonClass = 'h-8 rounded-lg px-3 text-[12px]';
const destructiveButtonClass = 'h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100';
const destructiveConfirmClass = 'app-transient-flat-action-danger rounded-full px-4 font-semibold';

type MemoryDialog =
  | { kind: 'delete'; lesson: MemoryLesson }
  | { kind: 'forget'; count: number }
  | { kind: 'replay' };

type LessonEdit = { lessonId: string; draft: string; error: string | null; busy: boolean };

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function lessonPrefix(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32).trimEnd()}…` : text;
}

function runsLabel(count: number): string {
  if (count === 0) return 'Nothing stored';
  return count === 1 ? '1 run' : `${count} runs`;
}

export function MemorySettingsPanel({
  accountId,
  client,
  isNativeShell: _isNativeShell,
}: {
  accountId: string;
  client: MemoryClient;
  isNativeShell: boolean;
}) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [lessons, setLessons] = useState<MemoryLesson[]>([]);
  const [replay, setReplay] = useState<MemoryReplayState>({ available: false, runCount: 0 });
  const [sync, setSync] = useState<MemorySyncState>({ accountLabel: '', lastSyncedAt: null });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [edit, setEdit] = useState<LessonEdit | null>(null);
  const [dialog, setDialog] = useState<MemoryDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const idPrefix = useId();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextSettings, nextLessons, nextReplay, nextSync] = await Promise.all([
        client.settings(),
        client.listLessons(),
        // A failed replay lookup hides the section instead of blocking the page.
        client.replayState().catch((): MemoryReplayState => ({ available: false, runCount: 0 })),
        // A failed sync lookup hides the sync row instead of blocking the page.
        client.syncState().catch((): MemorySyncState => ({ accountLabel: '', lastSyncedAt: null })),
      ]);
      setSettings(nextSettings);
      setLessons(nextLessons);
      setReplay(nextReplay);
      setSync(nextSync);
      setHasLoaded(true);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load memory settings.'));
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => { active = false; };
  }, [accountId, refresh]);

  // Refreshes the sync row after a write without blocking the page on it.
  const refreshSync = () => {
    client.syncState().then(setSync).catch(() => undefined);
  };

  const updateSettings = async (patch: Partial<MemorySettings>, success: string) => {
    setSettingsBusy(true);
    setError(null);
    try {
      setSettings(await client.updateSettings(patch));
      setStatusMessage(success);
      refreshSync();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not update memory settings. Try again.'));
    } finally {
      setSettingsBusy(false);
    }
  };

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
      setLessons((current) => current.map((entry) => (entry.lessonId === lessonId ? updated : entry)));
      setEdit(null);
      setStatusMessage('Memory saved.');
      refreshSync();
    } catch (caught) {
      setEdit((current) => (current?.lessonId === lessonId
        ? { ...current, busy: false, error: errorMessage(caught, 'Could not save this memory. Try again.') }
        : current));
    }
  };

  const closeDialog = () => {
    if (!dialogBusy) setDialog(null);
  };

  const runDialogAction = async (action: () => Promise<string>, fallback: string) => {
    setDialogBusy(true);
    setError(null);
    try {
      setStatusMessage(await action());
    } catch (caught) {
      setError(errorMessage(caught, fallback));
    } finally {
      setDialog(null);
      setDialogBusy(false);
    }
  };

  const confirmDelete = (lesson: MemoryLesson) => runDialogAction(async () => {
    await client.archiveLesson(lesson.lessonId);
    setLessons((current) => current.filter((entry) => entry.lessonId !== lesson.lessonId));
    setEdit((current) => (current?.lessonId === lesson.lessonId ? null : current));
    refreshSync();
    return 'Memory deleted.';
  }, 'Could not delete this memory. Try again.');

  const confirmForget = () => runDialogAction(async () => {
    const { archived } = await client.forgetAll();
    setLessons([]);
    setEdit(null);
    refreshSync();
    return archived === 1 ? 'Deleted 1 memory.' : `Deleted ${archived} memories.`;
  }, 'Could not delete your memories. Try again.');

  const confirmClearReplay = () => runDialogAction(async () => {
    const { deleted } = await client.clearReplayState();
    setReplay((current) => ({ ...current, runCount: 0 }));
    return deleted === 1 ? 'Cleared 1 replay.' : `Cleared ${deleted} replays.`;
  }, 'Could not clear replay state. Try again.');

  const renderLesson = (lesson: MemoryLesson) => {
    const meta = `${lessonSourceLabel(lesson.source)} · ${lesson.scopeLabel} · ${lessonDateLabel(lesson.updatedAt)}`;
    const prefix = lessonPrefix(lesson.text);
    if (edit?.lessonId === lesson.lessonId) {
      const editorId = `${idPrefix}-edit-${lesson.lessonId}`;
      const errorId = `${editorId}-error`;
      return (
        <div key={lesson.lessonId} data-memory-lesson={lesson.lessonId}>
          <SettingsRow title={<span className="font-normal text-slate-400">{meta}</span>}>
            <textarea
              id={editorId}
              aria-label={`Edit memory: ${prefix}`}
              aria-invalid={edit.error ? true : undefined}
              aria-describedby={edit.error ? errorId : undefined}
              value={edit.draft}
              disabled={edit.busy}
              rows={3}
              autoFocus
              onChange={(event) => setEdit({ ...edit, draft: event.target.value, error: null })}
              className="app-input-shell app-flat-input block w-full resize-y rounded-lg px-3 py-2 text-[13px] leading-5 text-white outline-none placeholder:text-slate-500"
            />
            {edit.error ? (
              <p id={errorId} className="app-error-text m-0 mt-2 text-[12px] leading-5 text-rose-300" role="alert">{edit.error}</p>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className={cn('text-[12px] tabular-nums', edit.draft.length > LESSON_MAX_CHARS ? 'text-rose-300' : 'text-slate-400')}>
                {edit.draft.length} / {LESSON_MAX_CHARS}
              </span>
              <span className="flex gap-2">
                <Button type="button" variant="quiet" className={quietButtonClass} disabled={edit.busy} onClick={() => setEdit(null)}>
                  Cancel
                </Button>
                <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={edit.busy} onClick={() => { void saveEdit(); }}>
                  {edit.busy ? 'Saving…' : 'Save'}
                </Button>
              </span>
            </div>
          </SettingsRow>
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
              <Button
                type="button"
                variant="quiet"
                className={quietButtonClass}
                aria-label={`Edit memory: ${prefix}`}
                onClick={() => setEdit({ lessonId: lesson.lessonId, draft: lesson.text, error: null, busy: false })}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="quiet"
                className={quietButtonClass}
                aria-label={`Delete memory: ${prefix}`}
                onClick={() => setDialog({ kind: 'delete', lesson })}
              >
                Delete
              </Button>
            </>
          )}
        />
      </div>
    );
  };

  const groups = groupLessonsByScope(lessons);

  return (
    <div>
      <p className="sr-only" aria-live="polite">{statusMessage}</p>

      {error ? (
        <div className="app-error-text mb-4 flex items-center justify-between gap-3 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          <span>{error}</span>
          {!hasLoaded ? (
            <Button type="button" variant="quiet" className="h-7 shrink-0 rounded-lg px-3 text-[12px]" disabled={isLoading} onClick={() => { void refresh(); }}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {!hasLoaded || !settings ? (
        isLoading ? (
          <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
            Loading memory…
          </div>
        ) : null
      ) : (
        <>
          <SettingsSection title="Memory">
            {sync.accountLabel ? (
              <SettingsRow title={<span className="font-normal text-slate-400">{syncStatusLabel(sync)}</span>} />
            ) : null}
            <SettingsRow
              title="Let Kordi save memories"
              description="When off, new turns cannot save memories and existing memories are not read on any device."
              control={(
                <SettingsSwitch
                  enabled={settings.lessonsEnabled}
                  label="Let Kordi save memories"
                  disabled={settingsBusy}
                  onChange={(lessonsEnabled) => {
                    void updateSettings({ lessonsEnabled }, lessonsEnabled ? 'Memory is on.' : 'Memory is off.');
                  }}
                />
              )}
            />
            <SettingsRow
              title="Keep sensitive details out of memories"
              description="Memories never record health, finances, relationships, identity, credentials, or other people's private details."
              control={(
                <SettingsSwitch
                  enabled={settings.excludeSensitive}
                  label="Keep sensitive details out of memories"
                  disabled={settingsBusy}
                  onChange={(excludeSensitive) => {
                    void updateSettings(
                      { excludeSensitive },
                      excludeSensitive ? 'Sensitive details stay out of memories.' : 'Sensitive details may be saved in memories.',
                    );
                  }}
                />
              )}
            />
          </SettingsSection>

          <SettingsSection
            title={`Saved memories · ${lessons.length}`}
            description="Edit or delete any memory. The next turn on any device uses only what is listed here."
          >
            <div>
              {!settings.lessonsEnabled ? (
                <SettingsRow title={<span className="font-normal text-slate-400">Memory is off. These are kept but not read.</span>} />
              ) : null}
              {groups.length === 0 ? (
                <SettingsRow title={<span className="font-normal text-slate-400">No memories saved yet.</span>} />
              ) : (
                <>
                  {groups.map((group) => (
                    <SettingsSection key={group.scope} title={group.label} size="compact">
                      {group.lessons.map(renderLesson)}
                    </SettingsSection>
                  ))}
                  <SettingsSection size="compact">
                    <SettingsRow
                      title="Forget everything"
                      description="Deletes every memory from your account and from every signed-in device."
                      control={(
                        <Button type="button" className={destructiveButtonClass} onClick={() => setDialog({ kind: 'forget', count: lessons.length })}>
                          Forget everything
                        </Button>
                      )}
                    />
                  </SettingsSection>
                </>
              )}
            </div>
          </SettingsSection>

          {replay.available ? (
            <SettingsSection
              title="Replay state"
              description="Kordi keeps a private replay of each run so follow-ups can continue where they stopped. It is discarded when a message in it is deleted or when a member turns off AI use."
            >
              <SettingsRow
                title="Replay state for this account"
                control={(
                  <>
                    <span className="text-[13px] font-normal text-slate-400">{runsLabel(replay.runCount)}</span>
                    <Button
                      type="button"
                      variant="quiet"
                      className={quietButtonClass}
                      disabled={replay.runCount === 0}
                      onClick={() => setDialog({ kind: 'replay' })}
                    >
                      Clear replay state
                    </Button>
                  </>
                )}
              />
            </SettingsSection>
          ) : null}

          <SettingsSection title="On this Mac only">
            <SettingsRow
              title="Bridge conversation memory"
              description="Exchange logs for bridge sessions live in the project directory and are managed from the command line."
            />
          </SettingsSection>
        </>
      )}

      {dialog ? (
        <AppDialog
          titleId={`${idPrefix}-dialog-title`}
          descriptionId={`${idPrefix}-dialog-description`}
          onDismiss={closeDialog}
          dismissDisabled={dialogBusy}
          busy={dialogBusy}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id={`${idPrefix}-dialog-title`}>
            {dialog.kind === 'delete' ? 'Delete this memory?' : dialog.kind === 'forget' ? 'Forget all memories?' : 'Clear replay state?'}
          </AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-dialog-description`}>
            {dialog.kind === 'delete'
              ? 'Kordi will not read it again on any device. This cannot be undone.'
              : dialog.kind === 'forget'
                ? forgetConsequences(dialog.count)
                : 'Follow-ups start from the saved conversation instead of the private replay. Nothing else is deleted.'}
          </AppDialogDescription>
          {dialog.kind === 'delete' ? (
            <p className={cn('m-0 mt-3 line-clamp-3 text-[13px] leading-5', dialogMuted)}>{dialog.lesson.text}</p>
          ) : null}
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={dialogBusy} onClick={closeDialog}>Cancel</Button>
            <Button
              className={destructiveConfirmClass}
              disabled={dialogBusy}
              onClick={() => {
                if (dialog.kind === 'delete') void confirmDelete(dialog.lesson);
                else if (dialog.kind === 'forget') void confirmForget();
                else void confirmClearReplay();
              }}
            >
              {dialog.kind === 'delete' ? 'Delete' : dialog.kind === 'forget' ? 'Forget everything' : 'Clear replay state'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </div>
  );
}
