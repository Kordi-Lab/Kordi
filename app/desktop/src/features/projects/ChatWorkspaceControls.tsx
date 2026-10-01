import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FolderPlus, GitBranch, Laptop, LoaderCircle } from 'lucide-react';
import type { Conversation } from '@/kordi-app/types';
import { ChatProjectPicker } from './ChatProjectPicker';
import { projectForChat, useChatProjects } from './chatProjects';
import type { ChatWorkspaceSelection, GitWorkspace } from './gitWorkspace';

export function ChatWorkspaceControls({ conversation, disabled }: { conversation: Conversation; disabled: boolean }) {
  const projects = useChatProjects();
  const project = projectForChat(projects?.projects ?? [], conversation.id);
  const requestKey = `${project?.root ?? ""}:${conversation.localSessionCwd ?? ""}`;
  const [gitResult, setGitResult] = useState<{ key: string; value: GitWorkspace | null } | null>(null);
  const git = gitResult?.key === requestKey ? gitResult.value : null;
  const [loading, setLoading] = useState(false);
  const waiting = loading || Boolean(projects?.gitWorkspace && project?.root && gitResult?.key !== requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [light, setLight] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const root = project?.root;
  const load = projects?.gitWorkspace;
  const cwd = conversation.localSessionCwd ?? undefined;
  useEffect(() => {
    let cancelled = false;
    if (!load || !root) return;
    void load(root, cwd).then((value) => { if (!cancelled) { setGitResult({ key: requestKey, value }); setError(null); } })
      .catch(() => { if (!cancelled) { setGitResult({ key: requestKey, value: null }); setError('Unable to read Git workspace. Select the branch control to retry.'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, root, cwd, conversation.id, requestKey]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const pointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', pointer);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', pointer); window.removeEventListener('resize', close); };
  }, [open]);
  if (!projects?.enabled) return null;
  const select = async (workspace: ChatWorkspaceSelection) => {
    if (!root || !load) return;
    setBusy(true); setError(null); setOpen(false);
    try {
      await projects.assign(conversation.id, root, workspace);
      // The canonical refresh updates cwd. Read again for providers whose selection
      // retains the same session object until the next catalog update.
      const next = workspace.workspaceRoot ?? (!workspace.worktree ? root : undefined);
      if (next) setGitResult({ key: `${root}:${next}`, value: await load(root, next) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change workspace.'); }
    finally { setBusy(false); trigger.current?.focus(); }
  };
  return <div className="chat-workspace-controls">
    <div className="chat-workspace-selector-row" aria-label="Chat workspace">
      <span className="chat-workspace-pill chat-workspace-location" title="Files and commands run on this Mac"><Laptop size={14} aria-hidden="true" />Local</span>
      <ChatProjectPicker sessionId={conversation.id} disabled={disabled || busy} />
      {root && load ? <div className="chat-workspace-pill chat-workspace-git">
        <button ref={trigger} type="button" disabled={disabled || busy || waiting} aria-label="Select branch or worktree"
          aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
          title={git?.branch ?? (git ? 'Detached HEAD' : 'Git workspace')}
          onClick={() => {
            if (open) { setOpen(false); return; }
            if (!git) { setLoading(true); void load(root, cwd).then((value) => { setGitResult({ key: requestKey, value }); setError(null); }).catch(() => setError('Unable to read Git workspace.')).finally(() => setLoading(false)); return; }
            const rect = trigger.current!.getBoundingClientRect();
            setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)), bottom: Math.max(8, Math.min(window.innerHeight - rect.top + 6, window.innerHeight - 340)) });
            setLight(Boolean(trigger.current?.closest('.theme-light'))); setOpen(true);
          }}>
          {waiting || busy ? <LoaderCircle size={14} className="animate-spin" /> : <GitBranch size={14} aria-hidden="true" />}
          <span>{waiting ? 'Loading…' : git ? git.branch ?? 'Detached HEAD' : error ? 'Retry Git' : 'No Git'}</span>
        </button>
        {git ? <label title={git.isWorktree ? 'Return to the project folder; keep the worktree on disk' : 'Create an isolated checkout for this chat'}>
          <input type="checkbox" aria-label="Use worktree" checked={git.isWorktree} disabled={disabled || busy}
            onChange={(event) => void select({ worktree: event.target.checked })} />
          worktree
        </label> : null}
      </div> : null}
      {projects.openImporter ? <button type="button" className="chat-workspace-pill chat-workspace-add" disabled={disabled || busy}
        aria-label="Add project to chat" title="Add project" onClick={() => projects.openImporter?.(conversation.id)}><FolderPlus size={15} aria-hidden="true" /></button> : null}
    </div>
    {error ? <p className="chat-workspace-error" role="alert">{error}</p> : null}
    {open && git ? createPortal(<div id={id} ref={menu} role="dialog" aria-label="Select branch or worktree"
      className={`chat-project-menu chat-workspace-menu${light ? ' app-compact-model-menu-light' : ''}`} style={position}
      onKeyDown={(event) => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'Tab' && (event.shiftKey ? index === 0 : index === buttons.length - 1)) {
          event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
        }
      }}>
      <div className="chat-workspace-menu-heading">Existing worktrees</div>
      {git.worktrees.map((tree) => <button key={tree.path} type="button" className="chat-project-option"
        title={tree.path} aria-pressed={tree.path === git.workspaceRoot} onClick={() => void select({ workspaceRoot: tree.path })}>
        <GitBranch size={13} aria-hidden="true" /><span>{tree.branch ?? 'Detached HEAD'}{tree.path === root ? ' · project folder' : ''}</span>
        {tree.path === git.workspaceRoot ? <Check size={13} aria-hidden="true" /> : null}
      </button>)}
      <div className="chat-workspace-menu-heading">New worktree from branch</div>
      {git.branches.map((branch) => <button key={branch} type="button" className="chat-project-option"
        onClick={() => void select({ worktree: true, branch })}><GitBranch size={13} aria-hidden="true" /><span>{branch}</span></button>)}
    </div>, document.body) : null}
  </div>;
}
