import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogTitle,
  type AppDialogAnchor,
} from '@/components/ui/dialog';

export type SessionContextMenuTarget = {
  sessionId: string;
  sessionName: string;
  x: number;
  y: number;
  canRename?: boolean;
};

export type SessionActionTarget = {
  sessionId: string;
  sessionName: string;
  anchorRect?: AppDialogAnchor | null;
};

type SessionContextMenuProps = {
  target: SessionContextMenuTarget;
  onClose: () => void;
  onRename: (target: SessionActionTarget) => void;
  onDelete: (target: SessionActionTarget) => void;
};

export function SessionContextMenu({
  target,
  onClose,
  onRename,
  onDelete,
}: SessionContextMenuProps) {
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="app-transient-surface app-modal-panel absolute w-[220px] rounded-[18px] border p-1.5"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 220)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {target.canRename !== false ? (
          <button
            type="button"
            className="app-transient-flat-action w-full rounded-[12px] px-3 py-2 text-left text-[13px] transition"
            onClick={() => {
              onClose();
              onRename({
                sessionId: target.sessionId,
                sessionName: target.sessionName,
                anchorRect: { left: target.x, top: target.y, width: 1, height: 1 },
              });
            }}
          >
            Rename…
          </button>
        ) : null}
        <button
          type="button"
          className="app-transient-row app-transient-row-danger mt-1 w-full rounded-[12px] px-3 py-2 text-left text-[13px] transition"
          onClick={() => {
            onClose();
            onDelete({
              sessionId: target.sessionId,
              sessionName: target.sessionName,
              anchorRect: { left: target.x, top: target.y, width: 1, height: 1 },
            });
          }}
        >
          Remove chat…
        </button>
      </div>
    </div>
  );
}

type RenameSessionDialogProps = {
  target: SessionActionTarget;
  onCancel: () => void;
  onConfirm: (sessionId: string, title: string) => void;
};

export function RenameSessionDialog({ target, onCancel, onConfirm }: RenameSessionDialogProps) {
  const [draft, setDraft] = useState(target.sessionName);
  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== target.sessionName.trim();
  const submit = () => {
    if (!canSubmit) return;
    onConfirm(target.sessionId, trimmed);
    onCancel();
  };
  return (
    <AppDialog
      titleId="rename-session-dialog-title"
      onDismiss={onCancel}
      presentation="popover"
      anchorRect={target.anchorRect}
    >
      <AppDialogTitle id="rename-session-dialog-title" className="text-[13px] leading-5">Rename session</AppDialogTitle>
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Session title"
        className="app-input-shell mt-3 h-9 w-full rounded-[12px] px-3 text-[13px] outline-none"
      />
      <AppDialogActions className="mt-3 gap-2">
        <Button variant="quiet" size="sm" className="rounded-[12px] px-3" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          className="rounded-[12px] px-3"
          disabled={!canSubmit}
          onClick={submit}
        >
          Rename
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}

type DeleteSessionDialogProps = {
  target: SessionActionTarget;
  onCancel: () => void;
  onConfirm: (sessionId: string) => Promise<void> | void;
};

export function DeleteSessionDialog({ target, onCancel, onConfirm }: DeleteSessionDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    if (isDeleting) return;
    onCancel();
  };

  const confirm = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirm(target.sessionId);
      onCancel();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(`Could not remove chat: ${message}`);
      setIsDeleting(false);
    }
  };

  return (
    <AppDialog
      titleId="remove-chat-dialog-title"
      onDismiss={cancel}
      dismissDisabled={isDeleting}
      busy={isDeleting}
      presentation="popover"
      anchorRect={target.anchorRect}
    >
      <AppDialogTitle id="remove-chat-dialog-title" className="text-[13px] leading-5">Remove chat?</AppDialogTitle>
      {error ? (
        <div className="app-error-text mt-2 text-[11px] leading-4 text-rose-500" role="alert">
          {error}
        </div>
      ) : null}
      <AppDialogActions className="mt-3 gap-2">
        <Button variant="quiet" size="sm" className="rounded-[12px] px-3" autoFocus disabled={isDeleting} onClick={cancel}>Cancel</Button>
        <Button
          size="sm"
          className="rounded-[12px] px-3"
          disabled={isDeleting}
          aria-busy={isDeleting}
          onClick={() => { void confirm(); }}
        >
          {isDeleting ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          <span>{isDeleting ? 'Removing…' : error ? 'Try again' : 'Remove chat'}</span>
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}

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
