import { CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Message } from '../types';
import { MarkdownContent } from './markdown';

function cleanCompactionSummary(text: string) {
  const withoutResourceBlocks = text
    .replace(/\n?\s*<read-files>[\s\S]*?<\/read-files>\s*/gi, '\n')
    .replace(/\n?\s*<modified-files>[\s\S]*?<\/modified-files>\s*/gi, '\n')
    .replace(/\n?\s*<read-files>[\s\S]*$/gi, '')
    .replace(/\n?\s*<modified-files>[\s\S]*$/gi, '');

  return withoutResourceBlocks
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactionTokenLabel(detail?: string) {
  const match = detail?.match(/Conversation compressed\s*•\s*([^•]+?)\s+tokens before/i);
  return match?.[1]?.trim() ? `${match[1].trim()} tokens before` : null;
}

export function CompactionSummaryMessage({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => cleanCompactionSummary(msg.text), [msg.text]);
  const tokenLabel = compactionTokenLabel(msg.detail);
  const hasSummary = summary.trim().length > 0;

  return (
    <div className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-1.5">
      <div className="app-message-meta">{msg.sender?.trim() || 'Kordi'} • {msg.time}</div>
      <div className="app-detail-sheet w-full">
        <div className="flex items-start gap-3 px-3.5 py-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-300/20 bg-emerald-400/10 text-emerald-200">
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-[13px] font-medium text-[color:var(--utility-foreground)]">Conversation compressed</div>
              {tokenLabel ? (
                <span className="rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--utility-muted-text)]">
                  {tokenLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">
              Older history is now a compact checkpoint. Recent messages stay available for the next response.
            </div>
          </div>
          {hasSummary ? (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="app-button-quiet inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              aria-expanded={expanded}
            >
              {expanded ? 'Hide summary' : 'Show summary'}
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
        {expanded && hasSummary ? (
          <div className="max-h-[26rem] overflow-y-auto border-t border-[color:var(--app-divider)] px-4 py-3 pr-5">
            <MarkdownContent text={summary} tone="muted" className="text-[13px]" showLinkIcons copySurface="message" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
