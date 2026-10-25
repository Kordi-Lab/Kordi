import type { ReactNode } from 'react';
import type { FileText } from 'lucide-react';

export function EmptyWorkspaceState({ icon: Icon, title, detail }: { icon: typeof FileText; title: string; detail: string }) {
  return (
    <div className="app-agent-studio-empty">
      <Icon className="h-4 w-4" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function WorkspaceHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="app-agent-studio-view-head">
      <h3>{title}</h3>
      {action}
    </div>
  );
}
