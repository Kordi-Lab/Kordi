import { requireAiConsent } from '@/features/aiConsent/aiConsentStore';
import { HelpEmptyExample } from '@/features/onboarding/HelpEmptyExample';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CLOUD_AGENT_NO_PROVIDER_NOTICE } from '@/features/cloud/cloudAgentMessages';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';

import { importMemoryBatch, memoryImportSummary, type MemoryImportClient } from './memoryImportBatch';
import {
  withChosenFiles,
  type AgentInstructionFile,
  type MemoryImporter,
} from './memoryImport';
import type { MemoryLesson } from './memoryModel';
import { MEMORY_IMPORT_SECTION_ID, takeMemoryImportFocus } from './memoryImportLink';
import { MemoryImportTree } from './MemoryImportTree';
import { countLabel, memoryImportTree, withSelection, type ImportRowStatus as RowStatus } from './memoryImportTreeModel';

const mutedClass = 'font-normal text-slate-400';

function errorLine(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Settings › Memory › Import: reads the person's agent files into memories, one file at a time. */
export function MemoryImportSection({
  client,
  importer,
  lessons,
  providerReady,
  onImported,
}: {
  client: MemoryImportClient;
  importer: MemoryImporter;
  lessons: ReadonlyArray<Pick<MemoryLesson, 'text'>>;
  providerReady: boolean;
  onImported: () => void;
}) {
  const [files, setFiles] = useState<AgentInstructionFile[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const runningRef = useRef(false);

  const listed = files !== null;
  useEffect(() => {
    // The Memory tab's Import opens settings here.
    if (listed && takeMemoryImportFocus()) document.getElementById(MEMORY_IMPORT_SECTION_ID)?.scrollIntoView?.({ block: 'start' });
  }, [listed]);

  useEffect(() => {
    let active = true;
    importer.discover().then(
      (found) => {
        if (!active) return;
        setFiles(found);
        setSelected(new Set(found.map((file) => file.path)));
      },
      () => { if (active) setFiles([]); },
    );
    return () => { active = false; };
  }, [importer]);

  if (!files) return null;

  const choose = async () => {
    if (!importer.choose) return;
    let chosen: AgentInstructionFile[];
    try {
      const choice = await importer.choose();
      chosen = Array.isArray(choice) ? choice : choice.files;
      setNotice(Array.isArray(choice) ? '' : choice.notice ?? '');
    } catch (error) {
      setNotice(errorLine(error));
      return;
    }
    const known = new Set(files.map((file) => file.path));
    setFiles((current) => withChosenFiles(current ?? [], chosen));
    setSelected((current) => new Set([...current, ...chosen.filter((file) => !known.has(file.path)).map((file) => file.path)]));
  };

  const run = async () => {
    const chosen = files.filter((file) => selected.has(file.path));
    if (runningRef.current || !chosen.length || !client.importLesson) return;
    // Reading in the browser sends the file to no model, so it needs no AI consent.
    if (!importer.readsLocally && !requireAiConsent()) return;
    runningRef.current = true;
    setRunning(true);
    setNotice('');
    setStatuses(Object.fromEntries(chosen.map((file) => [file.path, 'importing' as const])));
    try {
      const result = await importMemoryBatch(chosen, lessons, client, importer, (file, status) => {
        setStatuses((current) => ({ ...current, [file.path]: status }));
      });
      setNotice(`${memoryImportSummary(result)}.`);
      if (result.imported > 0) onImported();
    } catch (error) {
      const failed: RowStatus = { imported: 0, duplicates: 0, failedMemories: 0, failedFiles: 1, error: errorLine(error) };
      setStatuses(Object.fromEntries(chosen.map((file) => [file.path, failed])));
      setNotice(errorLine(error));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const ready = providerReady || Boolean(importer.readsLocally);
  const noticeLine = ready ? notice : CLOUD_AGENT_NO_PROVIDER_NOTICE;
  const status = files.length > 0 ? `${countLabel(selected.size, 'file')} selected` : importer.readsLocally ? 'No files chosen' : null;

  return (
    <SettingsSection title="Import" id={MEMORY_IMPORT_SECTION_ID}>
      {files.length === 0 ? (
        <>
          <HelpEmptyExample kind="files" />
          {importer.readsLocally ? null : <SettingsRow title="No agent files found." description="Finds instructions and memories from your coding agents." />}
        </>
      ) : (
        <MemoryImportTree
          apps={memoryImportTree(files)}
          selected={selected}
          statuses={statuses}
          disabled={running}
          onSelect={(group, checked) => setSelected((current) => withSelection(current, group, checked))}
        />
      )}
      {files.length > 0 || importer.choose ? (
        <SettingsRow
          title={(
            <span className={mutedClass}>
              {status}
              <span aria-live="polite">{noticeLine ? `${status ? ' · ' : ''}${noticeLine}` : ''}</span>
            </span>
          )}
          control={(
            <>
              {importer.choose ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 rounded-lg px-3.5 text-[12px]"
                  disabled={running}
                  data-help-target="memory-import-files"
                  onClick={() => { void choose(); }}
                >
                  Choose files…
                </Button>
              ) : null}
              <Button
                type="button"
                className="h-8 rounded-lg px-3.5 text-[12px]"
                disabled={running || !ready || selected.size === 0}
                data-help-target="memory-import-run"
                onClick={() => { void run(); }}
              >
                {running ? 'Importing…' : 'Import'}
              </Button>
            </>
          )}
        />
      ) : null}
    </SettingsSection>
  );
}
