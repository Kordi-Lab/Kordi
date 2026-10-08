import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';
import {
  TOOL_APPROVAL_PENDING_COMMAND,
  TOOL_APPROVAL_REQUEST_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
  TOOL_APPROVAL_RESPOND_COMMAND,
  applyToolApprovalEvent,
  parsePendingToolApprovals,
  parseToolApprovalPrompt,
  toolApprovalHeadline,
  toolApprovalSource,
  toolApprovalView,
  type ToolApprovalPrompt,
} from './toolApprovalModel';

export function ToolApprovalCard({
  prompt,
  onRespond,
}: {
  prompt: ToolApprovalPrompt;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  const view = toolApprovalView(prompt);
  const headingId = `tool-approval-${prompt.requestId}`;
  return (
    <section
      role="alertdialog"
      aria-labelledby={headingId}
      data-tool-approval-card="true"
      className="mx-3 mb-2 flex min-w-0 items-start gap-2.5 rounded-[14px] border border-[color:var(--app-divider)] bg-[color:var(--app-main-muted-bg)] px-3 py-2.5"
    >
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--utility-muted-text)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="text-[12px] font-semibold leading-4 text-[color:var(--utility-foreground)]">
          {toolApprovalHeadline(prompt)}
        </h3>
        <p className="mt-0.5 break-words text-[11px] leading-4 text-[color:var(--utility-muted-text)]" data-tool-approval-source="true">
          {toolApprovalSource(prompt)}
        </p>
        {view.fields.length ? (
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-4">
            {view.fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-[color:var(--utility-muted-text)]">{field.label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-[color:var(--utility-foreground)]">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {view.blocks.map((block) => (
          <div key={block.label} className="mt-1.5">
            <p className="text-[11px] leading-4 text-[color:var(--utility-muted-text)]">{block.label}</p>
            <pre
              tabIndex={0}
              className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-[color:var(--app-divider)] px-2 py-1 font-mono text-[11px] leading-4 text-[color:var(--utility-foreground)]"
            >
              {block.text}
            </pre>
          </div>
        ))}
        {view.truncated ? (
          <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--utility-muted-text)]" data-tool-approval-truncated="true">
            Part of this request is too long to show here. Choose Not now if you cannot check it.
          </p>
        ) : null}
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button type="button" className="app-button-quiet rounded-full px-2.5 py-1 text-[12px]" onClick={() => onRespond(prompt.requestId, false)}>
            Not now
          </button>
          <button type="button" className="app-button-primary rounded-full px-2.5 py-1 text-[12px]" onClick={() => onRespond(prompt.requestId, true)}>
            Allow
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Inline approval cards for connector actions, shown above the composer.
 * Reads the open prompts on mount and whenever the window regains focus, so
 * a prompt raised while this view was not mounted is still shown.
 */
export function ToolApprovalPrompts() {
  const [prompts, setPrompts] = useState<ToolApprovalPrompt[]>([]);

  useEffect(() => {
    if (!isNativeDesktopShell()) return undefined;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const refresh = () => {
      void invokeDesktop<unknown>(TOOL_APPROVAL_PENDING_COMMAND)
        .then((pending) => {
          if (!disposed) setPrompts(parsePendingToolApprovals(pending));
        })
        .catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
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
        refresh();
      }
    }).catch(() => refresh());
    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  if (prompts.length === 0) return null;
  const respond = (requestId: string, approved: boolean) => {
    setPrompts((current) => applyToolApprovalEvent(current, { kind: 'resolved', requestId }));
    void invokeDesktop<boolean>(TOOL_APPROVAL_RESPOND_COMMAND, { requestId, approved }).catch(() => undefined);
  };
  return (
    <div data-tool-approval-prompts="true" className="max-h-[60vh] overflow-y-auto">
      {prompts.map((prompt) => <ToolApprovalCard key={prompt.requestId} prompt={prompt} onRespond={respond} />)}
    </div>
  );
}
