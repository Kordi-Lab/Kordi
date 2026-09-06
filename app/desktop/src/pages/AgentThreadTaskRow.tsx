import { useContext, useEffect, useState } from 'react';
import { AgentSubsessionNavigationContext } from '@/features/cloud/useAgentSubsession';
import { agentThreadElapsed, agentThreadStatus } from '@/features/cloud/agentSubsessionTasks';
import type { AgentSubsessionTask } from '@/features/cloud/agentSubsessionTypes';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

export function AgentThreadTaskRow({ task }: { task: AgentSubsessionTask }) {
  const open = useContext(AgentSubsessionNavigationContext);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!task.live || task.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.live, task.status, task.startedAtMs]);
  const status = agentThreadStatus(task);
  const elapsed = agentThreadElapsed(task, now);
  return <div className="app-inspector-source-row flex items-start gap-3" data-agent-thread-task={task.sessionId}>
    <IdentityAvatar kind="agent" name={task.agentDisplayName} seed={task.agentId} imageUrl={task.agentAvatarUrl} className="h-7 w-7" />
    <div className="min-w-0 flex-1">
      <button type="button" disabled={!open} onClick={() => open?.(task.sessionId)} className="app-inspector-heading text-left">{task.title}</button>
      <div className="mt-1 app-inspector-text-block">{task.agentDisplayName} · Owner · {task.ownerDisplayName}</div>
      <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]" data-agent-thread-status={status}>{[status, elapsed, task.executionBackend === 'desktop' ? 'Mac runtime' : 'Cloud runtime'].filter(Boolean).join(' · ')}</div>
    </div>
    <button type="button" disabled={!open} onClick={() => open?.(task.sessionId)} className="app-button-quiet text-[12px]" aria-label={`Open Agent thread: ${task.title}`}>Open</button>
  </div>;
}
