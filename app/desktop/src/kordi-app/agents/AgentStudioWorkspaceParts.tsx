import type { ReactNode } from 'react';
import type { FileText } from 'lucide-react';
import { ErrorLine } from '@/components/ui/ErrorLine';

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

/** File save feedback: errors use the shared error line, other notes stay muted. */
export function FileFeedback({ text, tone }: { text: string; tone?: string }) {
  return tone === 'error'
    ? <ErrorLine className="mt-0 px-2.5 py-[7px]">{text}</ErrorLine>
    : <div className="app-agent-studio-file-feedback">{text}</div>;
}
