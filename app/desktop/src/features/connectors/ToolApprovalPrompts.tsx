import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import {
  TOOL_APPROVAL_REQUEST_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
  TOOL_APPROVAL_RESPOND_COMMAND,
  applyToolApprovalEvent,
  parseToolApprovalPrompt,
  toolApprovalDetails,
  toolApprovalHeadline,
  type ToolApprovalPrompt,
} from './toolApprovalModel';

export function ToolApprovalCard({
  prompt,
  onRespond,
}: {
  prompt: ToolApprovalPrompt;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  const details = toolApprovalDetails(prompt.args);
  return (
    <section
      role="alertdialog"
      aria-labelledby={`tool-approval-${prompt.requestId}`}
      data-tool-approval-card="true"
      className="mx-3 mb-2 flex min-w-0 items-start gap-2.5 rounded-[14px] border border-[color:var(--app-divider)] bg-[color:var(--app-main-muted-bg)] px-3 py-2.5"
    >
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--utility-muted-text)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id={`tool-approval-${prompt.requestId}`} className="text-[12px] font-semibold leading-4 text-[color:var(--utility-foreground)]">
          {toolApprovalHeadline(prompt)}
        </h3>
        {details ? (
          <p className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--utility-muted-text)]" title={details}>{details}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" className="app-button-quiet rounded-full px-2.5 py-1 text-[12px]" onClick={() => onRespond(prompt.requestId, false)}>
          Not now
        </button>
        <button type="button" className="app-button-primary rounded-full px-2.5 py-1 text-[12px]" onClick={() => onRespond(prompt.requestId, true)}>
          Allow
        </button>
      </div>
    </section>
  );
}

/** Inline approval cards for connector actions, shown above the composer. */
export function ToolApprovalPrompts() {
  const [prompts, setPrompts] = useState<ToolApprovalPrompt[]>([]);

  useEffect(() => {
    if (!isNativeDesktopShell()) return undefined;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const onRequest = await listen<unknown>(TOOL_APPROVAL_REQUEST_EVENT, (event) => {
        const prompt = parseToolApprovalPrompt(event.payload);
        if (prompt) setPrompts((current) => applyToolApprovalEvent(current, { kind: 'request', prompt }));
      });
      const onResolved = await listen<{ requestId?: string }>(TOOL_APPROVAL_RESOLVED_EVENT, (event) => {
        const requestId = event.payload?.requestId;
        if (typeof requestId === 'string') setPrompts((current) => applyToolApprovalEvent(current, { kind: 'resolved', requestId }));
      });
      if (disposed) {
        onRequest();
        onResolved();
      } else {
        unlisteners.push(onRequest, onResolved);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  if (prompts.length === 0) return null;
  const respond = (requestId: string, approved: boolean) => {
    setPrompts((current) => applyToolApprovalEvent(current, { kind: 'resolved', requestId }));
    void invokeDesktop<boolean>(TOOL_APPROVAL_RESPOND_COMMAND, { requestId, approved }).catch(() => undefined);
  };
  return (
    <div data-tool-approval-prompts="true">
      {prompts.map((prompt) => <ToolApprovalCard key={prompt.requestId} prompt={prompt} onRespond={respond} />)}
    </div>
  );
}
