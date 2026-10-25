import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';

import { useServerMemoryVersion } from './memoryAvailability';
import { destructiveConfirmClass } from './MemoryList';
import type { MemoryClient } from './memoryClient';
import type { MemoryImporter } from './memoryImport';
import { MemoryImportSection } from './MemoryImportSection';
import {
  GLOBAL_MEMORY_TARGET,
  forgetConsequences,
  isOwnMemory,
  memoryErrorMessage as errorMessage,
  syncStatusLabel,
  type MemoryLesson,
  type MemorySettings,
  type MemorySyncState,
} from './memoryModel';
import { NO_ORIGIN_SOURCES, type MemoryOriginSources } from './memoryOrigin';
import { MemoryOrganizer } from './MemoryOrganizer';
import type { MemoryCard } from './memoryOrganizerModel';

const destructiveButtonClass = 'app-transient-danger-button h-8 rounded-lg px-3.5 text-[12px]';

type MemoryDialog = { kind: 'forget'; count: number };

export function MemorySettingsPanel({
  accountId,
  client,
  isNativeShell: _isNativeShell,
  memoryVersion,
  importer = null,
  providerReady = false,
}: {
  accountId: string;
  client: MemoryClient;
  isNativeShell: boolean;
  /** Finds and reads agent files for Import; the section shows only with one. */
  importer?: MemoryImporter | null;
  /** Whether a provider is signed in on this Mac, which the import turn needs. */
  providerReady?: boolean;
  /** The server's `memoryVersion`; defaults to the one the signed-in server reported. */
  memoryVersion?: number | null;
}) {
  const serverMemoryVersion = useServerMemoryVersion();
  const version = memoryVersion === undefined ? serverMemoryVersion : memoryVersion;
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [originSources, setOriginSources] = useState<MemoryOriginSources>(NO_ORIGIN_SOURCES);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [lessons, setLessons] = useState<MemoryLesson[]>([]);
  const [sync, setSync] = useState<MemorySyncState>({ accountLabel: '', lastSyncedAt: null });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [dialog, setDialog] = useState<MemoryDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const idPrefix = useId();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextSettings, nextLessons, nextSync] = await Promise.all([
        client.settings(),
        client.listLessons(),
        // A failed sync lookup hides the sync row instead of blocking the page.
        client.syncState().catch((): MemorySyncState => ({ accountLabel: '', lastSyncedAt: null })),
      ]);
      setSettings(nextSettings);
      setLessons(nextLessons);
      // Card and chat names only label rows, so a failed lookup leaves them out.
      client.listCards?.().then(setCards, () => setCards([]));
      client.originSources?.().then(setOriginSources, () => undefined);
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

  const confirmForget = () => runDialogAction(async () => {
    const { archived } = await client.forgetAll();
    // Group memories other members saved stay; forgetting only removes this account's own.
    setLessons((current) => current.filter((lesson) => !isOwnMemory(lesson, accountId)));
    refreshSync();
    return archived === 1 ? 'Deleted 1 memory.' : `Deleted ${archived} memories.`;
  }, 'Could not delete your memories. Try again.');

  const ownCount = lessons.filter((lesson) => isOwnMemory(lesson, accountId)).length;

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

          {settings.lessonsEnabled && importer && client.importLesson ? (
            <MemoryImportSection
              client={client}
              importer={importer}
              lessons={lessons}
              providerReady={providerReady}
              onImported={() => { void refresh(); }}
            />
          ) : null}

          <MemoryOrganizer
            client={client}
            lessons={lessons}
            onLessonsChange={setLessons}
            viewerAccountId={accountId}
            memoryVersion={version}
            cards={cards}
            originSources={originSources}
            addTarget={settings.lessonsEnabled ? GLOBAL_MEMORY_TARGET : null}
            onChanged={refreshSync}
            notice={!settings.lessonsEnabled ? (
              <SettingsRow title={<span className="font-normal text-slate-400">Memory is off. These are kept but not read.</span>} />
            ) : null}
            footer={ownCount > 0 ? (
              <SettingsSection size="compact">
                <SettingsRow
                  title="Forget everything"
                  description="Deletes every memory from your account and from every signed-in device."
                  control={(
                    <Button type="button" className={destructiveButtonClass} onClick={() => setDialog({ kind: 'forget', count: ownCount })}>
                      Forget everything
                    </Button>
                  )}
                />
              </SettingsSection>
            ) : null}
          />

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
            Forget all memories?
          </AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-dialog-description`}>
            {forgetConsequences(dialog.count)}
          </AppDialogDescription>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={dialogBusy} onClick={closeDialog}>Cancel</Button>
            <Button
              className={destructiveConfirmClass}
              disabled={dialogBusy}
              onClick={() => { void confirmForget(); }}
            >
              Forget everything
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </div>
  );
}
