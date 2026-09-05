import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { AppDialog, AppDialogTitle, AppDialogDescription } from '@/components/ui/dialog';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';
import { MarkdownContent } from './markdown';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import type { NativeAgentSubsession } from '@/features/cloud/agentSubsessionTypes';
import { normalizedRelatedAgentSessionStatus } from '@/features/chat/relatedAgentSessions';
import { CLOUD_SESSION_CHANGED_EVENT } from '@/features/cloud/session';

export function AgentSubsessionDialog({ sessionId, parentSessionId, parentRequestId, agentName, onClose }: {
  sessionId: string; parentSessionId?: string; parentRequestId?: string | null; agentName?: string | null; onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const { snapshot, error, reload } = useAgentSubsession(sessionId, true);
  const [local, setLocal] = useState<NativeAgentSubsession | null>(null);
  useEffect(() => {
    if (!error || !parentSessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const accountChanged = () => { cancelled = true; setLocal(null); if (timer) clearTimeout(timer); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, accountChanged);
    const load = async () => {
      try {
        const value = await fetchDesktopSubsessionSnapshot(sessionId);
        if (value.parentSessionId !== parentSessionId || (parentRequestId && value.parentRequestId !== parentRequestId)) return;
        if (cancelled) return;
        setLocal(value);
        if (normalizedRelatedAgentSessionStatus(value.status) === 'running') timer = setTimeout(() => { void load(); }, 1500);
      } catch { if (!cancelled) setLocal(null); }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, accountChanged); };
  }, [error, sessionId, parentSessionId, parentRequestId]);
  const record = snapshot ?? local;
  const displayName = snapshot?.agentDisplayName ?? agentName ?? 'Agent';
  const stateLabel = record ? { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[normalizedRelatedAgentSessionStatus(record.status)] : '';
  return <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={onClose} className="flex max-h-[85vh] w-[min(54rem,94vw)] max-w-none flex-col p-5">
    <div className="flex items-start justify-between gap-4">
      <div>
        <AppDialogTitle id={titleId}>{record?.title || 'Agent task'}</AppDialogTitle>
        <AppDialogDescription id={descriptionId}>
          {snapshot ? `${snapshot.agentDisplayName} · Owner · ${snapshot.ownerDisplayName} · ${stateLabel}` : local ? `${displayName} · Local runtime on this Mac · ${stateLabel}` : 'Background session'}
        </AppDialogDescription>
      </div>
      <button type="button" className="app-button-quiet rounded-lg p-2" onClick={onClose} aria-label="Close task"><X className="h-4 w-4" /></button>
    </div>
    <div className="mt-4 min-h-24 overflow-y-auto" data-agent-subsession={sessionId}>
      {error && !local ? <div role="alert"><p>{error}</p><button type="button" className="app-button-quiet mt-3 rounded-lg px-3 py-2" onClick={reload}>Try again</button></div>
        : !record ? <p role="status">Loading task…</p>
        : record.messages.map((message) => <section key={message.id} className="mb-5" data-subsession-message={message.id}>
          <p className="mb-1 text-xs text-[color:var(--utility-muted-text)]">{message.role === 'user' ? 'Task' : displayName}</p>
          <MarkdownContent text={message.text} copySurface="message" />
        </section>)}
      {record && normalizedRelatedAgentSessionStatus(record.status) === 'running' ? <p role="status" className="text-sm text-[color:var(--utility-muted-text)]">Running…</p> : null}
    </div>
  </AppDialog>;
}
