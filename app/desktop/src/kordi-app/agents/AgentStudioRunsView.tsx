import { useEffect, useState } from 'react';
import { Activity, Ban, Check, CircleAlert, Clock, EyeOff, LoaderCircle, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DesktopAgentBuilderStatus } from '@/lib/desktop';
import { loadSession } from '@/features/cloud/session';
import { listProactiveActivity } from '@/features/cloud/proactiveClient';
import { proactiveActivityOutcome, relativeTimeLabel, type ProactiveActivityDecision, type ProactiveActivityEntry } from '@/features/cloud/proactiveOffer';
import type { Agent } from '../types';
import { EmptyWorkspaceState, WorkspaceHeading } from './AgentStudioWorkspaceParts';

export type LoadProactiveActivity = (agentId: string) => Promise<ProactiveActivityEntry[]>;

const DECISION_ICON: Record<ProactiveActivityDecision, typeof Activity> = {
  offer: Sparkles,
  silence: EyeOff,
  failed: CircleAlert,
  cancelled: Ban,
  pending: Clock,
};

async function loadOwnerProactiveActivity(agentId: string) {
  const session = await loadSession();
  if (!session?.token) return [];
  return listProactiveActivity(session.token, agentId, 50);
}

/** The agent's recent proactive evaluations, loaded once when the Runs tab opens. */
function ProactiveActivityList({ agentId, enabled, load, now }: { agentId: string; enabled: boolean; load: LoadProactiveActivity; now?: number }) {
  const [openedAt] = useState(() => Date.now());
  const [state, setState] = useState<{ agentId: string | null; entries: ProactiveActivityEntry[] | null; error: string | null }>({ agentId: null, entries: null, error: null });
  useEffect(() => {
    let cancelled = false;
    load(agentId)
      .then((entries) => { if (!cancelled) setState({ agentId, entries, error: null }); })
      .catch((error: unknown) => { if (!cancelled) setState({ agentId, entries: [], error: error instanceof Error ? error.message : 'Could not load proactive activity.' }); });
    return () => { cancelled = true; };
  }, [agentId, load]);
  const current = state.agentId === agentId ? state : { entries: null, error: null };
  const entries = current.entries ?? [];
  if (!enabled && entries.length === 0 && !current.error) return null;
  return (
    <section className="app-agent-studio-proactive-activity" aria-label="Proactive activity">
      <WorkspaceHeading title="Proactive" />
      {current.entries === null ? <div className="app-agent-studio-runtime-note"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading…</div>
        : current.error ? <div className="app-agent-studio-file-feedback is-error">{current.error}</div>
          : entries.length === 0 ? <div className="app-agent-studio-runtime-note">No proactive activity yet.</div> : (
            <div className="app-agent-studio-simple-list">
              {entries.map((entry, index) => {
                const Icon = DECISION_ICON[entry.decision];
                return (
                  <div key={`${entry.at}-${entry.proposalId ?? index}`} data-proactive-decision={entry.decision}>
                    <Icon className="h-4 w-4" />
                    <span><strong>{entry.conversationTitle}</strong><small>{proactiveActivityOutcome(entry)}</small></span>
                    <time dateTime={entry.at}>{relativeTimeLabel(entry.at, now ?? openedAt)}</time>
                  </div>
                );
              })}
            </div>
          )}
    </section>
  );
}

export function RunsView({
  agent,
  onOpenReachout,
  builderStatus,
  builderTesting,
  onTestBuilderDraft,
  loadProactiveActivity = loadOwnerProactiveActivity,
  proactiveActivity,
  now,
}: {
  agent?: Agent;
  /** The default agent's server id (`cloud-agent:<accountId>`) and published setting; cloud agents use their own. */
  proactiveActivity?: { agentId: string; enabled: boolean };
  onOpenReachout?: (sessionId: string) => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
  builderTesting?: boolean;
  onTestBuilderDraft?: () => void;
  loadProactiveActivity?: LoadProactiveActivity;
  now?: number;
}) {
  const activity = proactiveActivity ?? (agent?.cloudAgentId ? { agentId: agent.cloudAgentId, enabled: agent.cloudAgentProactive?.enabled === true } : null);
  const proactive = activity ? <ProactiveActivityList agentId={activity.agentId} enabled={activity.enabled} load={loadProactiveActivity} now={now} /> : null;
  if (builderStatus) {
    const reportIsCurrent = Boolean(
      builderStatus.testReport
        && builderStatus.testReport.fingerprint === builderStatus.validation.fingerprint,
    );
    return (
      <div className="app-agent-studio-view-scroll">
        <WorkspaceHeading
          title="Validate and test"
          action={<button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" disabled={!builderStatus.validation.valid || builderTesting} onClick={onTestBuilderDraft}>{builderTesting ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Testing…</> : 'Test draft'}</button>}
        />
        <div className="app-agent-studio-run-checks">
          <section className={cn('app-agent-studio-run-check', builderStatus.validation.valid ? 'is-success' : 'is-error')}>
            <span>{builderStatus.validation.valid ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}</span>
            <div><strong>{builderStatus.validation.valid ? 'Files are valid' : 'Draft needs attention'}</strong><p>{builderStatus.validation.valid ? `${builderStatus.validation.files.length} draft files passed structural validation.` : builderStatus.validation.errors.join(' ')}</p></div>
          </section>
          <section className={cn('app-agent-studio-run-check', reportIsCurrent && builderStatus.testReport?.passed ? 'is-success' : builderStatus.testReport && reportIsCurrent ? 'is-error' : '')}>
            <span>{builderTesting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : reportIsCurrent && builderStatus.testReport?.passed ? <Check className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}</span>
            <div><strong>{builderTesting ? 'Testing the candidate runtime' : reportIsCurrent ? builderStatus.testReport?.passed ? 'Runtime test passed' : 'Runtime test failed' : 'Runtime test required'}</strong><p>{builderTesting ? 'Kordi is starting a disposable session with the candidate prompt and skills.' : reportIsCurrent ? builderStatus.testReport?.summary : 'Run a new test after every file change.'}</p></div>
          </section>
        </div>
        {proactive}
      </div>
    );
  }
  const reachouts = agent?.collaborationReachouts ?? [];
  const activities = agent?.lastActivities ?? [];
  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Runs" />
      {reachouts.length === 0 && activities.length === 0 ? <EmptyWorkspaceState icon={Activity} title="No runtime activity yet" detail="Runs and direct reachouts will appear here when this agent starts working." /> : (
        <div className="app-agent-studio-simple-list">
          {reachouts.map((reachout) => (
            <button key={reachout.sessionId} type="button" onClick={() => onOpenReachout?.(reachout.sessionId)} disabled={!onOpenReachout}>
              <Activity className="h-4 w-4" /><span><strong>{reachout.title}</strong><small>{reachout.preview || 'No messages yet'}</small></span><time>{reachout.updatedAtLabel ?? ''}</time>
            </button>
          ))}
          {activities.map((activity, index) => (
            <div key={`${activity}-${index}`}><Check className="h-4 w-4" /><span><strong>{activity}</strong></span><time>Recent</time></div>
          ))}
        </div>
      )}
      {proactive}
    </div>
  );
}
