import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { AgentInstructionFile } from './memoryImport';
import {
  appSummary,
  failureOf,
  fileStatusLabel,
  fileSummary,
  projectSummary,
  rollUpLabel,
  selectionOf,
  type ImportSelection,
  type ImportStatuses,
  type ImportTreeApp,
} from './memoryImportTreeModel';

type TreeProps = {
  apps: ImportTreeApp[];
  selected: ReadonlySet<string>;
  statuses: ImportStatuses;
  disabled: boolean;
  onSelect: (files: ReadonlyArray<AgentInstructionFile>, checked: boolean) => void;
};

type RowProps = {
  level: 1 | 2 | 3;
  label: string;
  name: string;
  meta: string;
  status: string;
  selection: ImportSelection;
  disabled: boolean;
  onCheck: (checked: boolean) => void;
  /** Absent on a file row, which has nothing under it. */
  expanded?: boolean;
  onExpand?: () => void;
  children?: ReactNode;
};

const INDENT: Record<RowProps['level'], string> = { 1: 'pl-0', 2: 'pl-6', 3: 'pl-12' };
const nameClass = 'flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-[13px] leading-5 text-white';

function TreeRow({ level, label, name, meta, status, selection, disabled, onCheck, expanded, onExpand, children }: RowProps) {
  const branch = onExpand !== undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!branch || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onExpand();
  };
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-expanded={branch ? expanded : undefined}
      aria-label={label}
      tabIndex={branch ? 0 : -1}
      data-memory-import-row={level === 1 ? 'app' : level === 2 && branch ? 'project' : 'file'}
      onKeyDown={onKeyDown}
      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-quiet-control-focus-ring)]"
    >
      <div className={cn('flex items-center gap-2 rounded-md pr-1 hover:bg-[color:var(--app-quiet-control-hover-bg)]', branch ? 'h-8' : 'h-7', INDENT[level])}>
        {branch ? (
          <button type="button" tabIndex={-1} aria-hidden="true" className="grid h-5 w-4 shrink-0 place-items-center text-slate-500" onClick={onExpand}>
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : <span aria-hidden="true" className="w-4 shrink-0" />}
        <input
          type="checkbox"
          className="h-3.5 w-3.5 shrink-0 accent-[color:var(--app-sidebar-accent)]"
          aria-label={label}
          checked={selection === 'all'}
          ref={(input) => { if (input) input.indeterminate = selection === 'some'; }}
          disabled={disabled}
          onChange={(event) => onCheck(event.target.checked)}
        />
        {branch ? (
          <button type="button" tabIndex={-1} onClick={onExpand} className={cn(nameClass, level === 1 && 'font-medium')}>
            <span className="truncate">{name}</span>
            <span className="shrink-0 text-[12px] font-normal text-slate-400">{meta}</span>
          </button>
        ) : (
          <span className={cn(nameClass, 'text-[12px]')}>
            <span className="truncate">{name}</span>
            <span className="shrink-0 text-slate-400">· {meta}</span>
          </span>
        )}
        {status ? <span className="shrink-0 text-[12px] text-slate-400">{status}</span> : null}
      </div>
      {children}
    </div>
  );
}

function FileRow({ file, level, appName, selected, statuses, disabled, onSelect }: Omit<TreeProps, 'apps'> & { file: AgentInstructionFile; level: 2 | 3; appName: string }) {
  const failure = failureOf(statuses[file.path]);
  return (
    <TreeRow
      level={level}
      label={`${file.projectName} ${file.fileName}`}
      name={file.fileName}
      meta={fileSummary(file)}
      status={fileStatusLabel(statuses[file.path])}
      selection={selected.has(file.path) ? 'all' : 'none'}
      disabled={disabled}
      onCheck={(checked) => onSelect([file], checked)}
    >
      {failure ? <div data-memory-import-failure={appName} className={cn('pb-1 text-[12px] leading-5 text-slate-400', level === 3 ? 'pl-[94px]' : 'pl-[70px]')}>{failure}</div> : null}
    </TreeRow>
  );
}

/** The found files as App → Project → File, collapsed until opened; each checkbox selects its subtree. */
export function MemoryImportTree({ apps, selected, statuses, disabled, onSelect }: TreeProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const shared = { selected, statuses, disabled, onSelect };
  return (
    <div role="tree" aria-label="Agent files" className="py-2">
      {apps.map((app) => (
        <div key={app.key} role="none" data-memory-import-source={app.key}>
          <TreeRow
            level={1}
            label={app.name}
            name={app.name}
            meta={appSummary(app)}
            status={rollUpLabel(app.files, statuses, 'app')}
            selection={selectionOf(app.files, selected)}
            disabled={disabled}
            onCheck={(checked) => onSelect(app.files, checked)}
            expanded={open.has(app.key)}
            onExpand={() => toggle(app.key)}
          />
          {!open.has(app.key) ? null : app.projects.length === 0
            ? app.files.map((file) => <FileRow key={file.path} file={file} level={2} appName={app.key} {...shared} />)
            : app.projects.map((project) => (
              <TreeRow
                key={project.key}
                level={2}
                label={`${app.name} ${project.name}`}
                name={project.name}
                meta={projectSummary(project)}
                status={rollUpLabel(project.files, statuses, 'project')}
                selection={selectionOf(project.files, selected)}
                disabled={disabled}
                onCheck={(checked) => onSelect(project.files, checked)}
                expanded={open.has(project.key)}
                onExpand={() => toggle(project.key)}
              >
                {open.has(project.key)
                  ? project.files.map((file) => <FileRow key={file.path} file={file} level={3} appName={app.key} {...shared} />)
                  : null}
              </TreeRow>
            ))}
        </div>
      ))}
    </div>
  );
}
