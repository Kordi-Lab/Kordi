// "Waiting for you": actions an agent or PiP asked this person to decide in
// the open chat, shown above the composer. Allowing calendar sharing or
// confirming a PiP suggestion happens only here, never on the agent's say-so.
import { useId } from 'react';

import type { AgentTrustApi } from '@/features/agentTrust/agentTrustApi';
import { pendingActionCopy, type PendingActionFormatOptions } from '@/features/agentTrust/pendingActionCopy';
import { usePendingAgentActions } from '@/features/agentTrust/usePendingAgentActions';
import type { AgentActionDecision, PendingAgentAction } from '@/features/cloud/agentTrustTypes';
import { cn } from '@/lib/utils';

const MUTED = 'text-[color:var(--utility-muted-text)]';
const BUTTON = 'min-h-11 flex-1 basis-[9rem] whitespace-normal rounded-[12px] px-3 py-1.5 text-[12px] font-semibold leading-4 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--app-sidebar-accent)] disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none';

function PendingActionItem({ action, deciding, disabled, format, onDecide }: {
  action: PendingAgentAction;
  deciding: boolean;
  disabled: boolean;
  format?: PendingActionFormatOptions;
  onDecide: (action: PendingAgentAction, decision: AgentActionDecision) => void;
}) {
  const copy = pendingActionCopy(action, format);
  const titleId = useId();
  const bodyId = useId();
  return (
    <li
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={deciding || undefined}
      data-pending-agent-action={action.kind}
      className="border-t border-[color:var(--app-control-border)] py-2.5 first:border-t-0 first:pt-0 last:pb-0"
    >
      <p id={titleId} className="text-[13px] font-semibold leading-5">{copy.title}</p>
      <div id={bodyId} className="mt-0.5 text-[12px] leading-[1.45]">
        <p>{copy.body}</p>
        {copy.footnote ? <p className={cn('mt-1 text-[11px]', MUTED)}>{copy.footnote}</p> : null}
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          aria-label={copy.declineName}
          disabled={disabled}
          onClick={() => onDecide(action, 'decline')}
          className={cn(BUTTON, 'app-button-quiet border border-[color:var(--app-control-border)]')}
        >
          {copy.declineLabel}
        </button>
        <button
          type="button"
          aria-label={copy.approveName}
          disabled={disabled}
          onClick={() => onDecide(action, 'approve')}
          className={cn(BUTTON, 'bg-[color:var(--app-sidebar-accent)] text-[color:var(--app-sidebar-accent-text)]')}
        >
          {copy.approveLabel}
        </button>
      </div>
    </li>
  );
}

export function PendingAgentActionsBanner({ sessionId, api, format }: {
  sessionId: string | null | undefined;
  api?: AgentTrustApi;
  /** Locale and time zone for times; tests pin them. */
  format?: PendingActionFormatOptions;
}) {
  const pending = usePendingAgentActions(sessionId, api);
  if (!pending.enabled) return null;
  const { announcement } = pending;
  const decide = (action: PendingAgentAction, decision: AgentActionDecision) => {
    void pending.decide(action, decision);
  };
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-pending-agent-actions-live="true">
        {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
      </div>
      {pending.actions.length > 0 || pending.error ? (
        <div className="shrink-0 px-5 pt-3">
          <section
            role="region"
            aria-label="Waiting for you"
            data-pending-agent-actions="true"
            className="max-h-[40vh] overflow-y-auto rounded-[14px] border border-[color:var(--app-control-border)] bg-[color:var(--app-modal-bg)] px-3.5 py-3 text-[color:var(--utility-foreground)]"
          >
            {pending.error ? (
              <div className="mb-2 flex items-start gap-2">
                <p role="alert" className="min-w-0 flex-1 text-[12px] text-[color:var(--app-danger-text,#e5484d)]">{pending.error}</p>
                {pending.actions.length === 0 ? (
                  <button
                    type="button"
                    onClick={pending.dismissError}
                    className={cn(BUTTON, 'app-button-quiet min-h-8 flex-none basis-auto')}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            ) : null}
            {pending.actions.length > 0 ? (
              <ul>
                {pending.actions.map((action) => (
                  <PendingActionItem
                    key={action.actionId}
                    action={action}
                    deciding={pending.decidingId === action.actionId}
                    disabled={pending.decidingId !== null}
                    format={format}
                    onDecide={decide}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
