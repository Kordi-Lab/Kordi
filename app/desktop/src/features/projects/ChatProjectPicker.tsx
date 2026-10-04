import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { projectForChat, useChatProjects } from './chatProjects';

export function ChatProjectPicker({
  sessionId, disabled = false, menuLabel = false,
}: { sessionId: string; disabled?: boolean; menuLabel?: boolean }) {
  const projects = useChatProjects();
  const selected = projectForChat(projects?.projects ?? [], sessionId);
  const [light, setLight] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const onPointer = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!projects?.enabled) return null;
  const matches = projects.projects.filter((project) => project.root
    && project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update project.'); }
    finally { setBusy(false); }
  };

  return <>
    <button ref={trigger} type="button" disabled={disabled || busy}
      className={menuLabel ? 'chat-project-context-action' : 'chat-project-trigger'}
      aria-label={menuLabel ? 'Move to project' : selected ? `Project: ${selected.name}` : 'Choose project'}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={() => {
        if (open) { close(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), bottom: Math.max(8, Math.min(window.innerHeight - rect.top + 6, window.innerHeight - 340)) });
        setLight(Boolean(trigger.current?.closest('.theme-light')));
        setQuery(''); setError(null); setCreating(false); setOpen(true);
      }}>
      <Folder size={13} aria-hidden="true" />
      <span>{menuLabel ? 'Move to project…' : selected?.name ?? 'Choose project'}</span>
    </button>
    {open ? createPortal(<div ref={surface} id={id} role="dialog" aria-label="Choose project"
      aria-busy={busy} className={`chat-project-menu app-composer-model-menu-layer${light ? ' app-compact-model-menu-light' : ''}`} style={position}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          const controls = Array.from(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
          const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
          if (document.activeElement === edge) {
            event.preventDefault();
            (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus();
          }
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        if (creating) return;
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button[data-project-option]:not(:disabled)') ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {creating ? <form className="chat-project-create" onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) void run(() => projects.create(sessionId, name.trim(), folder.trim()));
      }}>
        <div className="chat-project-create-heading"><span>New project</span><button type="button" aria-label="Back to projects" disabled={busy} onClick={() => setCreating(false)}><X size={14} /></button></div>
        <label>Project name<input ref={search} autoFocus value={name} onChange={(event) => setName(event.target.value)} required disabled={busy} placeholder="My project" /></label>
        <label>Existing folder <span>(optional)</span><input value={folder} onChange={(event) => setFolder(event.target.value)} disabled={busy} placeholder="Path to a local folder" /></label>
        <p>Leave the folder empty to create a new workspace.</p>
        <button className="chat-project-create-submit" type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />} Create project</button>
      </form> : <>
        <div className="chat-project-search"><Search size={13} aria-hidden="true" /><input ref={search} aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="chat-project-options">
          {selected ? <button data-project-option type="button" disabled={busy} className="chat-project-option" onClick={() => void run(() => projects.assign(sessionId, ''))}><X size={13} />No project</button> : null}
          {matches.map((project) => <button data-project-option type="button" key={project.id} disabled={busy} className="chat-project-option"
            aria-pressed={project.id === selected?.id} onClick={() => project.id === selected?.id ? close() : void run(() => projects.assign(sessionId, project.root!))}>
            <Folder size={13} aria-hidden="true" /><span>{project.name}</span>{project.id === selected?.id ? <Check size={13} aria-hidden="true" /> : null}
          </button>)}
          {!matches.length ? <p className="chat-project-empty">{query ? 'No matching projects' : 'No projects yet'}</p> : null}
        </div>
        <div className="chat-project-menu-footer"><button data-project-option type="button" disabled={busy} className="chat-project-option" onClick={() => {
          if (projects.openImporter) { close(); projects.openImporter(sessionId); return; }
          setName(query); setFolder(''); setCreating(true);
        }}><Plus size={14} aria-hidden="true" />New project</button></div>
      </>}
      {error ? <p role="alert" className="chat-project-error">{error}</p> : null}
    </div>, document.body) : null}
  </>;
}
