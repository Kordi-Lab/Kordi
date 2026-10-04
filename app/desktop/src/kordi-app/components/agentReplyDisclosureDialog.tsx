// "About this reply": who wrote an agent reply, whose agent it is, who asked,
// where it ran, and, for Kordi Cloud runs, the model the server recorded.
import { useEffect, useState } from 'react';

import { defaultAgentTrustApi, type AgentTrustApi } from '@/features/agentTrust/agentTrustApi';
import {
  onReplyDisclosureRequested,
  replyDisclosureRequestFor,
  type ReplyDisclosureTarget,
} from '@/features/agentTrust/replyDisclosureTarget';
import { useAiFeatures } from '@/features/agentTrust/useAiFeatures';
import { useReplyDisclosure } from '@/features/agentTrust/useReplyDisclosures';
import { pipDisclosureText, REPLY_DISCLOSURE_FOOTNOTE, replyDisclosureRows } from '@/features/agentTrust/replyDisclosureCopy';
import { AgentTrustDialog, AgentTrustDialogButton } from './agentTrustControls';

function ReplyDetails({ target, request, api }: {
  target: ReplyDisclosureTarget;
  request: ReturnType<typeof replyDisclosureRequestFor>;
  api: AgentTrustApi;
}) {
  const state = useReplyDisclosure(request, api);
  if (state.status === 'loading') return <p role="status">Checking…</p>;
  if (state.status === 'missing') return <p>Details aren&apos;t available for this reply.</p>;
  if (state.status === 'error') {
    return (
      <p role="alert">
        Couldn&apos;t load details.{' '}
        <button type="button" className="underline" onClick={state.retry}>Try again.</button>
      </p>
    );
  }
  return (
    <ul className="space-y-1" data-reply-disclosure-rows="true">
      {replyDisclosureRows(state.disclosure, target).map((row) => <li key={row}>{row}</li>)}
    </ul>
  );
}

export function AgentReplyDisclosureDialog({ target, sessionId, accountId, onClose, api = defaultAgentTrustApi() }: {
  target: ReplyDisclosureTarget;
  sessionId?: string | null;
  accountId?: string | null;
  onClose: () => void;
  api?: AgentTrustApi;
}) {
  const features = useAiFeatures(api);
  const request = target.isPip ? null : replyDisclosureRequestFor(target, { sessionId, accountId });
  return (
    <AgentTrustDialog
      title="About this reply"
      onClose={onClose}
      dataAttribute="reply-disclosure"
      actions={<AgentTrustDialogButton primary onClick={onClose}>Done</AgentTrustDialogButton>}
    >
      <h3 className="mb-2 text-[13px] font-semibold">Written by AI</h3>
      {target.isPip ? (
        <>
          <ul className="space-y-1">
            <li>Agent: PiP</li>
            <li>Runs for: Kordi</li>
          </ul>
          <p className="mt-2">{pipDisclosureText(features?.pip.providerLabel)}</p>
        </>
      ) : <ReplyDetails target={target} request={request} api={api} />}
      <p className="mt-3 text-[11px] leading-[1.45] text-[color:var(--utility-muted-text)]">{REPLY_DISCLOSURE_FOOTNOTE}</p>
    </AgentTrustDialog>
  );
}

/** Opens "About this reply" for whichever reply the AI chip or message menu names. */
export function AgentReplyDisclosureHost({ sessionId, accountId, api }: {
  sessionId?: string | null;
  accountId?: string | null;
  api?: AgentTrustApi;
}) {
  const [target, setTarget] = useState<ReplyDisclosureTarget | null>(null);
  useEffect(() => onReplyDisclosureRequested(setTarget), []);
  if (!target) return null;
  return (
    <AgentReplyDisclosureDialog
      key={target.key}
      target={target}
      sessionId={sessionId}
      accountId={accountId}
      onClose={() => setTarget(null)}
      api={api}
    />
  );
}
