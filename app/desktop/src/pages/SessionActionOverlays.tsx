import { useState } from 'react';
import { Archive, ArchiveRestore, Bell, BellOff, CheckCircle2, LoaderCircle, Mail, Pin, PinOff, Trash2 } from 'lucide-react';

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
  archived?: boolean;
  pinned?: boolean;
  muted?: boolean;
  unread?: boolean;
};

export type GroupContextMenuTarget = {
  groupSpaceId: string;
  groupName: string;
  sessionIds: string[];
  x: number;
  y: number;
  archived?: boolean;
  pinned?: boolean;
  muted?: boolean;
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
  onArchive: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
  onSetPinned: (sessionId: string, pinned: boolean) => void;
  onSetMuted: (sessionId: string, muted: boolean) => void;
  onSetUnread: (sessionId: string, unread: boolean) => void;
  onDelete: (target: SessionActionTarget) => void;
};

export function SessionContextMenu({
  target,
  onClose,
  onRename,
  onArchive,
  onRestore,
  onSetPinned,
  onSetMuted,
  onSetUnread,
  onDelete,
}: SessionContextMenuProps) {
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="app-transient-surface app-modal-panel absolute w-[220px] rounded-[18px] border p-1.5"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 300)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {target.canRename !== false ? (
          <button
            type="button"
            className="app-transient-flat-action app-transient-action-row w-full whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
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
        {!target.archived ? (
          <button
            type="button"
            data-session-context-action="pin"
            className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
            onClick={() => run(() => onSetPinned(target.sessionId, !target.pinned))}
          >
            {target.pinned
              ? <PinOff className="app-transient-action-icon" aria-hidden="true" />
              : <Pin className="app-transient-action-icon" aria-hidden="true" />}
            {target.pinned ? 'Unpin' : 'Pin'}
          </button>
        ) : null}
        <button
          type="button"
          data-session-context-action={target.unread ? 'read' : 'unread'}
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => onSetUnread(target.sessionId, !target.unread))}
        >
          {target.unread
            ? <CheckCircle2 className="app-transient-action-icon" aria-hidden="true" />
            : <Mail className="app-transient-action-icon" aria-hidden="true" />}
          {target.unread ? 'Mark as read' : 'Mark as unread'}
        </button>
        <button
          type="button"
          data-session-context-action="mute"
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => onSetMuted(target.sessionId, !target.muted))}
        >
          {target.muted
            ? <Bell className="app-transient-action-icon" aria-hidden="true" />
            : <BellOff className="app-transient-action-icon" aria-hidden="true" />}
          {target.muted ? 'Unmute' : 'Mute notifications'}
        </button>
        <button
          type="button"
          data-session-context-action={target.archived ? 'restore' : 'archive'}
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => (
            target.archived
              ? onRestore(target.sessionId)
              : onArchive(target.sessionId)
          ))}
        >
          {target.archived
            ? <ArchiveRestore className="app-transient-action-icon" aria-hidden="true" />
            : <Archive className="app-transient-action-icon" aria-hidden="true" />}
          {target.archived ? 'Restore' : 'Archive'}
        </button>
        <button
          type="button"
          className="app-transient-row app-transient-row-danger app-transient-action-row mt-1 flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => {
            onClose();
            onDelete({
              sessionId: target.sessionId,
              sessionName: target.sessionName,
              anchorRect: { left: target.x, top: target.y, width: 1, height: 1 },
            });
          }}
        >
          <Trash2 className="app-transient-action-icon" aria-hidden="true" />
          Delete chat…
        </button>
      </div>
    </div>
  );
}

export function GroupContextMenu({
  target,
  onClose,
  onSetPinned,
  onSetMuted,
  onMarkRead,
  onArchive,
  onRestore,
}: {
  target: GroupContextMenuTarget;
  onClose: () => void;
  onSetPinned: (groupSpaceId: string, pinned: boolean) => void;
  onSetMuted: (sessionIds: string[], muted: boolean) => void;
  onMarkRead: (sessionIds: string[]) => void;
  onArchive: (sessionIds: string[]) => void;
  onRestore: (sessionIds: string[]) => void;
}) {
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="app-transient-surface app-modal-panel absolute w-[220px] rounded-[18px] border p-1.5"
        style={{
          left: Math.max(12, Math.min(target.x, window.innerWidth - 232)),
          top: Math.max(12, Math.min(target.y, window.innerHeight - 260)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={`Actions for ${target.groupName}`}
      >
        {!target.archived ? (
          <button
            type="button"
            data-group-context-action="pin"
            className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
            onClick={() => run(() => onSetPinned(target.groupSpaceId, !target.pinned))}
          >
            {target.pinned
              ? <PinOff className="app-transient-action-icon" aria-hidden="true" />
              : <Pin className="app-transient-action-icon" aria-hidden="true" />}
            {target.pinned ? 'Unpin group' : 'Pin group'}
          </button>
        ) : null}
        <button
          type="button"
          data-group-context-action="read"
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => onMarkRead(target.sessionIds))}
        >
          <CheckCircle2 className="app-transient-action-icon" aria-hidden="true" />
          Mark group as read
        </button>
        <button
          type="button"
          data-group-context-action="mute"
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => onSetMuted(target.sessionIds, !target.muted))}
        >
          {target.muted
            ? <Bell className="app-transient-action-icon" aria-hidden="true" />
            : <BellOff className="app-transient-action-icon" aria-hidden="true" />}
          {target.muted ? 'Unmute group' : 'Mute group'}
        </button>
        <button
          type="button"
          data-group-context-action={target.archived ? 'restore' : 'archive'}
          className="app-transient-flat-action app-transient-action-row flex w-full items-center gap-2.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-left transition"
          onClick={() => run(() => (
            target.archived ? onRestore(target.sessionIds) : onArchive(target.sessionIds)
          ))}
        >
          {target.archived
            ? <ArchiveRestore className="app-transient-action-icon" aria-hidden="true" />
            : <Archive className="app-transient-action-icon" aria-hidden="true" />}
          {target.archived ? 'Restore group' : 'Archive group'}
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
      <AppDialogTitle id="remove-chat-dialog-title" className="text-[13px] leading-5">Delete this chat from your list?</AppDialogTitle>
      <p className="app-transient-muted mt-2 text-[11px] leading-4">
        This does not delete it for other participants. It will return if someone sends a new message.
      </p>
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
          <span>{isDeleting ? 'Deleting…' : error ? 'Try again' : 'Delete chat'}</span>
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
