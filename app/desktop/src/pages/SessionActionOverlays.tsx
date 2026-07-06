import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

export type SessionContextMenuTarget = {
  sessionId: string;
  sessionName: string;
  x: number;
  y: number;
  canMoveToProject?: boolean;
};

export type SessionActionTarget = {
  sessionId: string;
  sessionName: string;
};

export type SessionMoveProjectTarget = {
  id: string;
  name: string;
  root?: string;
};

type SessionContextMenuProps = {
  target: SessionContextMenuTarget;
  onClose: () => void;
  onRename: (target: SessionActionTarget) => void;
  onMove: (target: SessionActionTarget) => void;
  onDelete: (target: SessionActionTarget) => void;
};

export function SessionContextMenu({
  target,
  onClose,
  onRename,
  onMove,
  onDelete,
}: SessionContextMenuProps) {
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="app-modal-panel absolute w-[220px] rounded-[20px] border border-white/10 bg-[color:var(--app-panel-bg)] p-1.5 shadow-[var(--app-shadow-float)]"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 220)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="w-full rounded-[14px] px-3 py-2 text-left text-[13px] text-slate-100 transition hover:bg-white/[0.05]"
          onClick={() => {
            onClose();
            onRename({ sessionId: target.sessionId, sessionName: target.sessionName });
          }}
        >
          Rename…
        </button>
        {target.canMoveToProject ? (
          <button
            type="button"
            className="mt-1 w-full rounded-[14px] px-3 py-2 text-left text-[13px] text-slate-100 transition hover:bg-white/[0.05]"
            onClick={() => {
              onClose();
              onMove({ sessionId: target.sessionId, sessionName: target.sessionName });
            }}
          >
            Move to project…
          </button>
        ) : null}
        <button
          type="button"
          className="mt-1 w-full rounded-[14px] px-3 py-2 text-left text-[13px] text-rose-100 transition hover:bg-rose-500/10"
          onClick={() => {
            onClose();
            onDelete({ sessionId: target.sessionId, sessionName: target.sessionName });
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[8px]" onMouseDown={onCancel}>
      <div className="app-modal-panel w-full max-w-md rounded-[28px] border border-white/10 p-5 text-white shadow-[var(--app-shadow-float)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="text-[16px] font-semibold">Rename session</div>
        <div className="mt-2 text-[13px] leading-6 text-slate-400">
          Choose a new title for <span className="font-medium text-slate-200">{target.sessionName}</span>.
        </div>
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder="Session title"
          className="mt-4 w-full rounded-[16px] border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-slate-500"
        />
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" className="rounded-full px-4" onClick={onCancel}>Cancel</Button>
          <Button
            className="rounded-full px-4"
            disabled={!canSubmit}
            onClick={submit}
          >
            Rename
          </Button>
        </div>
      </div>
    </div>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[8px]"
      onMouseDown={cancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="app-modal-panel w-full max-w-md rounded-[28px] border border-white/10 p-5 text-white shadow-[var(--app-shadow-float)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="text-[16px] font-semibold">Remove chat?</div>
        <div className="mt-2 text-[13px] leading-6 text-slate-400">
          <span className="font-medium text-slate-200">{target.sessionName}</span> will be removed from your chat list on this device and your signed-in cloud devices.
        </div>
        <div className="mt-3 text-[13px] leading-6 text-slate-400">
          It will show again when there is a new update in this chat.
        </div>
        {error ? (
          <div className="app-error-text mt-4 rounded-[16px] border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100">
            {error}
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" className="rounded-full px-4" autoFocus disabled={isDeleting} onClick={cancel}>Cancel</Button>
          <Button
            className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400"
            disabled={isDeleting}
            onClick={() => { void confirm(); }}
          >
            {isDeleting ? 'Removing…' : 'Remove chat'}
          </Button>
        </div>
      </div>
    </div>
  );
}

type MoveSessionDialogProps = {
  target: SessionActionTarget;
  projects: SessionMoveProjectTarget[];
  onCancel: () => void;
  onMoveToProject: (sessionId: string, projectRoot: string) => void;
};

export function MoveSessionDialog({
  target,
  projects,
  onCancel,
  onMoveToProject,
}: MoveSessionDialogProps) {
  const [newProjectRootDraft, setNewProjectRootDraft] = useState('');
  const existingProjectTargets = useMemo(
    () => projects.filter((project) => Boolean(project.root?.trim())),
    [projects],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[8px]" onMouseDown={onCancel}>
      <div className="app-modal-panel w-full max-w-lg rounded-[28px] border border-white/10 p-5 text-white shadow-[var(--app-shadow-float)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="text-[16px] font-semibold">Move to project</div>
        <div className="mt-2 text-[13px] leading-6 text-slate-400">
          Move <span className="font-medium text-slate-200">{target.sessionName}</span> out of Chats and into an explicit project folder.
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">Existing projects</div>
          <div className="mt-2 grid gap-2">
            {existingProjectTargets.length > 0 ? existingProjectTargets.map((project) => (
              <button
                key={project.id}
                type="button"
                className="rounded-[18px] border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:bg-white/[0.05]"
                onClick={() => {
                  const projectRoot = project.root?.trim();
                  if (!projectRoot) return;
                  onMoveToProject(target.sessionId, projectRoot);
                  onCancel();
                }}
              >
                <div className="text-[13px] font-medium text-white">{project.name}</div>
                <div className="mt-1 truncate text-[11px] text-slate-400">{project.root}</div>
              </button>
            )) : (
              <div className="rounded-[18px] border border-dashed border-white/10 px-4 py-3 text-[12px] text-slate-500">
                No explicit projects yet.
              </div>
            )}
          </div>
        </div>

        <div className="mt-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">Create new project folder</div>
          <input
            value={newProjectRootDraft}
            onChange={(event) => setNewProjectRootDraft(event.target.value)}
            placeholder="Enter a folder path"
            className="mt-2 w-full rounded-[16px] border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-slate-500"
          />
          <div className="mt-1 text-[11px] text-slate-500">Relative paths resolve from the current desktop workspace.</div>
        </div>

        <div className="mt-5 flex justify-between gap-3">
          <Button variant="secondary" className="rounded-full px-4" onClick={onCancel}>Cancel</Button>
          <Button
            className="rounded-full px-4"
            disabled={!newProjectRootDraft.trim()}
            onClick={() => {
              if (!newProjectRootDraft.trim()) return;
              onMoveToProject(target.sessionId, newProjectRootDraft.trim());
              onCancel();
            }}
          >
            Create and move
          </Button>
        </div>
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[8px]" onMouseDown={onCancel}>
      <div className="app-modal-panel w-full max-w-xl rounded-[28px] border border-[color:var(--app-divider)] p-5 text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="text-[16px] font-semibold">Create project</div>
        <div className="mt-2 text-[13px] leading-6 text-[color:var(--utility-muted-text)]">
          Projects group sessions by a shared local folder. Every session under a project uses the same project context and settings.
        </div>

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
                className="mt-2 w-full rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3 py-2.5 text-[13px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              />
              <span className="mt-1 block text-[11px] text-[color:var(--utility-muted-text)]">Use a folder path without spaces.</span>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Display name optional</span>
              <input
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="Use folder name"
                className="mt-2 w-full rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3 py-2.5 text-[13px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
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
                className="mt-2 w-full rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3 py-2.5 text-[13px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--utility-muted-text)]">Parent folder optional</span>
              <input
                value={parentDir}
                onChange={(event) => setParentDir(event.target.value)}
                placeholder="Defaults to ~/KordiProjects"
                className="mt-2 w-full rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3 py-2.5 text-[13px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              />
              <span className="mt-1 block text-[11px] text-[color:var(--utility-muted-text)]">Kordi-created project paths cannot contain spaces.</span>
            </label>
          </div>
        )}

        {error ? <div className="app-error-text mt-4 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">{error}</div> : null}

        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" className="rounded-full px-4" onClick={onCancel}>Cancel</Button>
          <Button
            className="rounded-full px-4"
            disabled={!canSubmit || isSubmitting}
            onClick={() => {
              void submit();
            }}
          >
            {isSubmitting ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </div>
    </div>
  );
}
