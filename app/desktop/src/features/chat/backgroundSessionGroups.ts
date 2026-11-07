import type { RelatedAgentSessionRunStatus } from '@/features/chat/relatedAgentSessions';

/** More rows than this start folded into one summary line. */
export const FOLDED_BACKGROUND_SESSION_ROWS = 3;

/** The folded line: "5 background sessions · 2 running · 1 failed". */
export function backgroundSessionGroupSummary(statuses: readonly RelatedAgentSessionRunStatus[]) {
  const count = (status: RelatedAgentSessionRunStatus) => statuses.filter(value => value === status).length;
  const running = count('running');
  const failed = count('failed');
  const parts = [`${statuses.length} background ${statuses.length === 1 ? 'session' : 'sessions'}`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  const status: RelatedAgentSessionRunStatus = running ? 'running' : failed ? 'failed'
    : count('stopped') ? 'stopped' : 'done';
  return { text: parts.join(' · '), status };
}
