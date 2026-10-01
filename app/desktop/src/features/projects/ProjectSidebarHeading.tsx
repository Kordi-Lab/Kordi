import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react';

export function ProjectSidebarHeading({
  section, first, expanded, onToggle, onCreateProject, onSetProjectsExpanded,
}: {
  section: 'pinned' | 'projects' | 'recents';
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCreateProject?: () => void;
  onSetProjectsExpanded: (expanded: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const close = () => { setAnchor(null); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!anchor) return;
    menuRef.current?.querySelector('button')?.focus();
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) setAnchor(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setAnchor(null); triggerRef.current?.focus(); }
    };
    const scroll = () => setAnchor(null);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', scroll);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', scroll);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [anchor]);
  const label = section === 'pinned' ? 'Pinned' : section === 'projects' ? 'Projects' : 'Recents';
  return <div className="chat-project-section-heading" data-first-section={first || undefined}>
    {section === 'recents' ? <button type="button" className="chat-recents-heading"
      aria-expanded={expanded} onClick={onToggle}>
      <span>{label}</span><ChevronRight size={13} className="chat-project-collapse-indicator" aria-hidden="true" />
    </button> : <h3>{label}</h3>}
    {section === 'projects' ? <div className="chat-project-heading-actions">
      <button type="button" ref={triggerRef} aria-label="Project options" aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)} onClick={() => {
          if (anchor) { close(); return; }
          const rect = triggerRef.current!.getBoundingClientRect();
          setAnchor({ top: Math.min(rect.bottom + 4, window.innerHeight - 100), left: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)) });
        }}><MoreHorizontal size={17} aria-hidden="true" /></button>
      {onCreateProject ? <button type="button" aria-label="New project" title="New project" onClick={onCreateProject}>
        <Plus size={18} aria-hidden="true" />
      </button> : null}
    </div> : null}
    {anchor ? createPortal(<div ref={menuRef} role="dialog" aria-label="Project options"
      className="chat-project-menu chat-project-sidebar-options" style={anchor}>
      <button type="button" className="chat-project-option" onClick={() => { onSetProjectsExpanded(true); close(); }}>Expand all projects</button>
      <button type="button" className="chat-project-option" onClick={() => { onSetProjectsExpanded(false); close(); }}>Collapse all projects</button>
    </div>, document.body) : null}
  </div>;
}
