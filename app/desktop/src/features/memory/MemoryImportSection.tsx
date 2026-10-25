import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CLOUD_AGENT_NO_PROVIDER_NOTICE } from '@/features/cloud/cloudAgentMessages';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';

import type { MemoryClient } from './memoryClient';
import {
  importedCountLabel,
  memoryImportSaves,
  parseMemoryImportReply,
  withChosenFiles,
  type AgentInstructionFile,
  type MemoryImporter,
} from './memoryImport';
import type { MemoryLesson } from './memoryModel';
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
  client: Pick<MemoryClient, 'importLesson'>;
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
      chosen = await importer.choose();
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
    if (!chosen.length || !client.importLesson) return;
    setRunning(true);
    setNotice('');
    setStatuses(Object.fromEntries(chosen.map((file) => [file.path, 'importing' as const])));
    const existing = lessons.map((lesson) => lesson.text);
    let batch: Awaited<ReturnType<NonNullable<MemoryImporter['start']>>>;
    try {
      batch = importer.start ? await importer.start() : { extract: (file, memories) => importer.extract(file, memories), finish: () => Promise.resolve() };
    } catch (error) {
      const failed: RowStatus = { failed: errorLine(error) };
      setStatuses(Object.fromEntries(chosen.map((file) => [file.path, failed])));
      setRunning(false);
      return;
    }
    let total = 0;
    let read = 0;
    for (const file of chosen) {
      let saved = 0;
      let status: RowStatus;
      try {
        const reply = await batch.extract(file, existing);
        read += 1;
        for (const { save } of memoryImportSaves(parseMemoryImportReply(reply, [file]), [file], existing)) {
          try {
            await client.importLesson(save);
            existing.push(save.text);
            saved += 1;
          } catch {
            // One memory the server refuses does not stop the rest of the file.
          }
        }
        status = saved;
      } catch (error) {
        status = { failed: errorLine(error) };
      }
      total += saved;
      setStatuses((current) => ({ ...current, [file.path]: status }));
    }
    await batch.finish(read > 0);
    setNotice(total === 0 ? 'Nothing new.' : `${importedCountLabel(total)}.`);
    setRunning(false);
    if (total > 0) onImported();
  };

  const noticeLine = providerReady ? notice : CLOUD_AGENT_NO_PROVIDER_NOTICE;

  return (
    <SettingsSection title="Import">
      {files.length === 0 ? (
        <SettingsRow title="No agent files found." description="Finds instructions and memories from your coding agents." />
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
              {files.length > 0 ? `${countLabel(selected.size, 'file')} selected` : null}
              <span aria-live="polite">{noticeLine ? `${files.length > 0 ? ' · ' : ''}${noticeLine}` : ''}</span>
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
                  onClick={() => { void choose(); }}
                >
                  Choose files…
                </Button>
              ) : null}
              <Button
                type="button"
                className="h-8 rounded-lg px-3.5 text-[12px]"
                disabled={running || !providerReady || selected.size === 0}
                onClick={() => { void run(); }}
              >
                Import
              </Button>
            </>
          )}
        />
      ) : null}
    </SettingsSection>
  );
}
