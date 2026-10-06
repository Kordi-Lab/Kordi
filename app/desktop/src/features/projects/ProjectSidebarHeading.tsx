import { ChevronRight, Plus } from 'lucide-react';

export function ProjectSidebarHeading({
  section, first, expanded, onToggle, onCreateProject,
}: {
  section: 'pinned' | 'projects' | 'recents';
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCreateProject?: () => void;
}) {
  const label = section === 'pinned' ? 'Pinned' : section === 'projects' ? 'Projects' : 'Recents';
  return <div className="chat-project-section-heading" data-first-section={first || undefined}>
    {section !== 'pinned' ? <button type="button" className="chat-project-section-toggle"
      aria-expanded={expanded} onClick={onToggle}>
      <span>{label}</span><ChevronRight size={13} className="chat-project-collapse-indicator" aria-hidden="true" />
    </button> : <h3>{label}</h3>}
    {section === 'projects' ? <div className="chat-project-heading-actions">
      {onCreateProject ? <button type="button" aria-label="New project" title="New project" onClick={() => onCreateProject()}>
        <Plus size={18} aria-hidden="true" />
      </button> : null}
    </div> : null}
  </div>;
}
