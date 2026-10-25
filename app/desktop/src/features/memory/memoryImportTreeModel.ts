import { agentFileSizeLabel, agentFilesBySource, importedCountLabel, type AgentInstructionFile } from './memoryImport';

// Settings › Memory › Import lists the found files as App → Project → File. An app whose files
// are all in one project skips the project level.

/** One file's import state: reading, refused with a reason, or the number of memories saved. */
export type ImportRowStatus = 'importing' | { failed: string } | number;
export type ImportStatuses = Readonly<Record<string, ImportRowStatus>>;

export type ImportTreeProject = { key: string; name: string; files: AgentInstructionFile[] };
export type ImportTreeApp = {
  key: string;
  name: string;
  files: AgentInstructionFile[];
  /** Empty when the app's files are all in one project. */
  projects: ImportTreeProject[];
};

export type ImportSelection = 'all' | 'some' | 'none';

const APP_NAMES: Record<string, string> = { 'Project file': 'Project files' };

export function memoryImportTree(files: ReadonlyArray<AgentInstructionFile>): ImportTreeApp[] {
  return agentFilesBySource(files).map((group) => {
    const projects = new Map<string, ImportTreeProject>();
    for (const file of group.files) {
      const key = `${group.source}\u0000${file.root ?? `~${file.projectName}`}`;
      const project = projects.get(key) ?? { key, name: file.projectName, files: [] };
      project.files.push(file);
      projects.set(key, project);
    }
    const list = Array.from(projects.values());
    return {
      key: group.source,
      name: APP_NAMES[group.source] ?? group.source,
      files: group.files,
      projects: list.length > 1 ? list : [],
    };
  });
}

export function selectionOf(files: ReadonlyArray<AgentInstructionFile>, selected: ReadonlySet<string>): ImportSelection {
  const count = files.filter((file) => selected.has(file.path)).length;
  if (count === 0) return 'none';
  return count === files.length ? 'all' : 'some';
}

/** `selected` with every file of `files` added or removed. */
export function withSelection(selected: ReadonlySet<string>, files: ReadonlyArray<AgentInstructionFile>, checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const file of files) {
    if (checked) next.add(file.path);
    else next.delete(file.path);
  }
  return next;
}

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function appSummary(app: ImportTreeApp): string {
  const files = countLabel(app.files.length, 'file');
  return app.projects.length ? `${countLabel(app.projects.length, 'project')} · ${files}` : files;
}

export function projectSummary(project: ImportTreeProject): string {
  const size = project.files.reduce((total, file) => total + file.size, 0);
  return `${countLabel(project.files.length, 'file')} · ${agentFileSizeLabel(size)}`;
}

const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "1 KB · Sep 16"; the year shows only for another year. */
export function fileSummary(file: AgentInstructionFile, now: number = Date.now()): string {
  const date = new Date(file.modifiedAt);
  const day = date.getFullYear() === new Date(now).getFullYear() ? dayFormatter.format(date) : dayYearFormatter.format(date);
  return `${agentFileSizeLabel(file.size)} · ${day}`;
}

export function fileStatusLabel(status: ImportRowStatus | undefined): string {
  if (status === undefined) return '';
  if (status === 'importing') return 'Importing…';
  if (typeof status === 'object') return 'Could not import';
  return importedCountLabel(status);
}

export function failureOf(status: ImportRowStatus | undefined): string | null {
  return typeof status === 'object' && status.failed ? status.failed : null;
}

/**
 * The import state of a group of files: "Importing 3/12…" on a project (nothing on an app)
 * while any is reading, then the memories saved by all of them, or "Could not import" when every
 * file was refused. Empty before an import.
 */
export function rollUpLabel(files: ReadonlyArray<AgentInstructionFile>, statuses: ImportStatuses, level: 'app' | 'project'): string {
  const states = files.map((file) => statuses[file.path]).filter((status) => status !== undefined);
  if (!states.length) return '';
  const reading = states.filter((status) => status === 'importing').length;
  if (reading) return level === 'app' ? '' : `Importing ${states.length - reading}/${states.length}…`;
  if (states.every((status) => typeof status === 'object')) return 'Could not import';
  return importedCountLabel(states.reduce<number>((total, status) => total + (typeof status === 'number' ? status : 0), 0));
}
