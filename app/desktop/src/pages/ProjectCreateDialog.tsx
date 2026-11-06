import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';

type ProjectCreateDialogProps = {
  onCancel: () => void;
  onCreateFromFolder: (folderPath: string, name?: string) => Promise<void> | void;
  onCreateNew: (name: string, parentDir?: string) => Promise<void> | void;
};

export function ProjectCreateDialog({
  onCancel,
  onCreateFromFolder,
  onCreateNew,
}: ProjectCreateDialogProps) {
  const [mode, setMode] = useState<'folder' | 'new'>('folder');
  const [folderPath, setFolderPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [newName, setNewName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    try {
      setError(null);
      setIsSubmitting(true);
      await (mode === 'folder'
        ? onCreateFromFolder(folderPath.trim(), folderName.trim() || undefined)
        : onCreateNew(newName.trim(), parentDir.trim() || undefined));
      onCancel();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to create project');
      setIsSubmitting(false);
    }
  };

  const canSubmit = mode === 'folder' ? folderPath.trim().length > 0 : newName.trim().length > 0;

  return (
    <AppDialog
      titleId="create-project-dialog-title"
      onDismiss={onCancel}
      dismissDisabled={isSubmitting}
      busy={isSubmitting}
      className="max-w-xl"
    >
      <AppDialogTitle id="create-project-dialog-title">Create project</AppDialogTitle>

      <div className="mt-4 grid grid-cols-2 gap-2 rounded-[18px] bg-[color:var(--app-control-bg)] p-1">
        <button
          type="button"
          onClick={() => setMode('folder')}
          className={`rounded-[14px] px-3 py-2 text-[12px] font-medium transition ${mode === 'folder' ? 'bg-[color:var(--app-control-active-bg)] text-[color:var(--utility-foreground)] shadow-sm' : 'text-[color:var(--utility-muted-text)] hover:text-[color:var(--utility-foreground)]'}`}
        >
          From local folder
        </button>
        <button
          type="button"
          onClick={() => setMode('new')}
          className={`rounded-[14px] px-3 py-2 text-[12px] font-medium transition ${mode === 'new' ? 'bg-[color:var(--app-control-active-bg)] text-[color:var(--utility-foreground)] shadow-sm' : 'text-[color:var(--utility-muted-text)] hover:text-[color:var(--utility-foreground)]'}`}
        >
          New folder
        </button>
      </div>

      {mode === 'folder' ? (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Folder path</span>
            <input
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              placeholder="/Users/you/work/project"
              className="app-input-shell mt-2 w-full rounded-[16px] px-3 py-2.5 text-[13px] outline-none"
            />
            <span className="mt-1 block text-[11px] text-[color:var(--utility-muted-text)]">Use a folder path without spaces.</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Display name optional</span>
            <input
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="Use folder name"
              className="app-input-shell mt-2 w-full rounded-[16px] px-3 py-2.5 text-[13px] outline-none"
            />
          </label>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Project name</span>
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Website refresh"
              className="app-input-shell mt-2 w-full rounded-[16px] px-3 py-2.5 text-[13px] outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Parent folder optional</span>
            <input
              value={parentDir}
              onChange={(event) => setParentDir(event.target.value)}
              placeholder="Defaults to ~/KordiProjects"
              className="app-input-shell mt-2 w-full rounded-[16px] px-3 py-2.5 text-[13px] outline-none"
            />
            <span className="mt-1 block text-[11px] text-[color:var(--utility-muted-text)]">Kordi-created project paths cannot contain spaces.</span>
          </label>
        </div>
      )}

      {error ? <div className="app-error-text mt-4 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">{error}</div> : null}

      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" disabled={isSubmitting} onClick={onCancel}>Cancel</Button>
        <Button
          className="rounded-full px-4"
          disabled={!canSubmit || isSubmitting}
          onClick={() => {
            void submit();
          }}
        >
          {isSubmitting ? 'Creating…' : 'Create project'}
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}
