import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CLOUD_AGENT_NO_PROVIDER_NOTICE } from '@/features/cloud/cloudAgentMessages';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';

import type { MemoryClient } from './memoryClient';
import {
  agentFileSizeLabel,
  importedCountLabel,
  memoryImportSaves,
  parseMemoryImportReply,
  type AgentInstructionFile,
  type MemoryImporter,
} from './memoryImport';
import { lessonDateLabel, type MemoryLesson } from './memoryModel';

type RowStatus = 'importing' | 'failed' | number;

const mutedClass = 'font-normal text-slate-400';

function statusLabel(status: RowStatus | undefined): string {
  if (status === undefined) return '';
  if (status === 'importing') return 'Importing…';
  if (status === 'failed') return 'Could not import';
  return importedCountLabel(status);
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

  const toggle = (path: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const run = async () => {
    const chosen = files.filter((file) => selected.has(file.path));
    if (!chosen.length || !client.importLesson) return;
    setRunning(true);
    setNotice('');
    setStatuses(Object.fromEntries(chosen.map((file) => [file.path, 'importing' as const])));
    const existing = lessons.map((lesson) => lesson.text);
    let total = 0;
    for (const file of chosen) {
      let saved = 0;
      let status: RowStatus;
      try {
        const reply = await importer.extract(file, existing);
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
      } catch {
        status = 'failed';
      }
      total += saved;
      setStatuses((current) => ({ ...current, [file.path]: status }));
    }
    setNotice(total === 0 ? 'Nothing new.' : `${importedCountLabel(total)}.`);
    setRunning(false);
    if (total > 0) onImported();
  };

  return (
    <SettingsSection title="Import">
      {files.length === 0 ? (
        <SettingsRow title="No agent files found." description="Finds AGENTS.md and CLAUDE.md files for your projects." />
      ) : files.map((file) => (
        <SettingsRow
          key={file.path}
          icon={(
            <input
              type="checkbox"
              className="h-4 w-4 accent-[color:var(--app-sidebar-accent)]"
              aria-label={`${file.projectName} ${file.fileName}`}
              checked={selected.has(file.path)}
              disabled={running}
              onChange={(event) => toggle(file.path, event.target.checked)}
            />
          )}
          title={file.projectName}
          description={[file.fileName, agentFileSizeLabel(file.size), lessonDateLabel(new Date(file.modifiedAt).toISOString())].join(' · ')}
          control={statuses[file.path] !== undefined ? <span className="text-[12px] text-slate-400">{statusLabel(statuses[file.path])}</span> : null}
        />
      ))}
      {files.length > 0 ? (
        <SettingsRow
          title={<span className={mutedClass} aria-live="polite">{providerReady ? notice : CLOUD_AGENT_NO_PROVIDER_NOTICE}</span>}
          control={(
            <Button
              type="button"
              className="h-8 rounded-lg px-3.5 text-[12px]"
              disabled={running || !providerReady || selected.size === 0}
              onClick={() => { void run(); }}
            >
              Import
            </Button>
          )}
        />
      ) : null}
    </SettingsSection>
  );
}
