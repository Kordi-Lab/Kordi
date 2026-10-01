// "AI access" for a group or direct conversation: what agents asked here can
// see, "Don't let AI use my messages", who turned it on, and PiP.
import { useId, useState } from 'react';

import { AI_ACCESS_COPY, pipHelpText, turnedOnByText } from '@/features/agentTrust/aiAccessCopy';
import type { AgentTrustApi } from '@/features/agentTrust/agentTrustApi';
import { useConversationAiAccess } from '@/features/agentTrust/useConversationAiAccess';
import type { ChatSyncAiHistoryScope } from '@/features/cloud/agentTrustTypes';
import { AgentTrustDialog, AgentTrustDialogButton, AgentTrustSwitchRow } from './agentTrustControls';

const MUTED = 'text-[11px] leading-[1.45] text-[color:var(--utility-muted-text)]';

export type AiAccessPanelProps = {
  sessionId: string | null | undefined;
  /** Direct conversations offer only "Don't let AI use my messages". */
  mode?: 'group' | 'direct';
  memberNames?: ReadonlyMap<string, string>;
  currentAccountId?: string | null;
  api?: AgentTrustApi;
};

export function AiAccessPanel({ sessionId, mode = 'group', memberNames = new Map(), currentAccountId, api }: AiAccessPanelProps) {
  const ai = useConversationAiAccess(sessionId, api);
  const headingId = useId();
  const scopeLabelId = useId();
  const scopeHelpId = useId();
  const [confirmingRecent, setConfirmingRecent] = useState(false);
  if (ai.status === 'unavailable') return null;
  if (ai.status === 'loading' || !ai.access) {
    return (
      <section aria-labelledby={headingId} className="app-ai-access-panel mt-3 border-t pt-2" data-ai-access-panel="loading">
        <h3 id={headingId} className="px-1.5 text-[11px] font-semibold">{AI_ACCESS_COPY.title}</h3>
        <p role="status" className={`px-1.5 ${MUTED}`}>Loading…</p>
      </section>
    );
  }
  const access = ai.access;
  const isGroup = mode === 'group';
  const canManage = isGroup && access.viewer_can_manage;
  const pip = isGroup && access.pip?.available ? access.pip : null;
  const chooseScope = (scope: ChatSyncAiHistoryScope) => {
    if (scope === access.history_scope || ai.pending) return;
    if (scope === 'recent') setConfirmingRecent(true);
    else void ai.update({ history_scope: scope });
  };

  return (
    <section aria-labelledby={headingId} className="app-ai-access-panel mt-3 border-t px-1.5 pt-2" data-ai-access-panel={mode}>
      <h3 id={headingId} className="text-[11px] font-semibold">{AI_ACCESS_COPY.title}</h3>
      {isGroup ? (
        <div className="py-2">
          <div id={scopeLabelId} className="text-[12px] font-medium leading-5">{AI_ACCESS_COPY.scopeLabel}</div>
          <div role="radiogroup" aria-labelledby={scopeLabelId} aria-describedby={scopeHelpId} className="mt-1 flex flex-col gap-1">
            {(['mentions', 'recent'] as const).map((scope) => (
              <label key={scope} className="flex min-h-7 items-center gap-2 text-[12px]">
                <input
                  type="radio"
                  name={`${scopeLabelId}-scope`}
                  value={scope}
                  checked={access.history_scope === scope}
                  disabled={!canManage || ai.pending}
                  onChange={() => chooseScope(scope)}
                  className="h-4 w-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-sidebar-accent)]"
                />
                <span>{scope === 'mentions' ? AI_ACCESS_COPY.mentionsLabel : AI_ACCESS_COPY.recentLabel}</span>
              </label>
            ))}
          </div>
          <p id={scopeHelpId} className={`mt-1 ${MUTED}`}>
            {access.history_scope === 'recent' ? AI_ACCESS_COPY.recentHelp : AI_ACCESS_COPY.mentionsHelp}
          </p>
          <p className={`mt-1 ${MUTED}`}>{AI_ACCESS_COPY.scopeNote}</p>
          {!canManage ? <p className={`mt-1 ${MUTED}`} data-ai-access-read-only="true">{AI_ACCESS_COPY.nonManager}</p> : null}
        </div>
      ) : null}
      <AgentTrustSwitchRow
        label={AI_ACCESS_COPY.optOutLabel}
        help={AI_ACCESS_COPY.optOutHelp}
        footnote={AI_ACCESS_COPY.optOutFootnote}
        checked={access.viewer_excluded}
        disabled={ai.pending}
        onChange={(checked) => { void ai.update({ exclude_my_messages: checked }); }}
      />
      <div className="flex items-baseline justify-between gap-3 py-1 text-[12px]" data-ai-access-turned-on-by="true">
        <span className="font-medium">{AI_ACCESS_COPY.turnedOnBy}</span>
        <span className={`${MUTED} text-right`}>{turnedOnByText(access.excluded_member_ids, memberNames, currentAccountId)}</span>
      </div>
      {pip ? (
        <AgentTrustSwitchRow
          label={AI_ACCESS_COPY.pipLabel}
          help={pipHelpText(pip.provider_label)}
          footnote={!canManage ? AI_ACCESS_COPY.nonManager : undefined}
          checked={pip.enabled}
          disabled={!canManage || ai.pending}
          onChange={(checked) => { void ai.update({ pip_enabled: checked }); }}
        />
      ) : null}
      {isGroup ? <p className={`py-1 ${MUTED}`}>{AI_ACCESS_COPY.footer}</p> : null}
      {ai.error ? <p role="alert" className="py-1 text-[11px] text-[color:var(--app-danger-text,#e5484d)]">{ai.error}</p> : null}
      {confirmingRecent ? (
        <AgentTrustDialog
          title={AI_ACCESS_COPY.confirmTitle}
          onClose={() => setConfirmingRecent(false)}
          dataAttribute="ai-access-recent"
          actions={(
            <>
              <AgentTrustDialogButton onClick={() => setConfirmingRecent(false)}>Cancel</AgentTrustDialogButton>
              <AgentTrustDialogButton
                primary
                label="Allow agents to read recent messages"
                onClick={() => {
                  setConfirmingRecent(false);
                  void ai.update({ history_scope: 'recent' });
                }}
              >
                Allow
              </AgentTrustDialogButton>
            </>
          )}
        >
          <p>{AI_ACCESS_COPY.confirmBody}</p>
        </AgentTrustDialog>
      ) : null}
    </section>
  );
}
