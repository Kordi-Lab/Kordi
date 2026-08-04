import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { SupportReportPermissionCard } from '@/features/support/SupportReportPermissionCard';
import {
  parseSupportReportProposal,
  supportReportDisplayText,
} from '@/features/support/supportReport';
import { useSupportReportSubmission } from '@/features/support/supportReportSubmission';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './markdown';

const ASSISTANT_ANSWER_FOLDED_VISIBLE_LINES = 6;

function assistantAnswerFoldInfo(text: string) {
  const lines = text.split(/\r?\n/);
  const hiddenLineCount = Math.max(0, lines.length - ASSISTANT_ANSWER_FOLDED_VISIBLE_LINES);
  const shouldFold = hiddenLineCount > 0 || text.replace(/\s+/g, ' ').trim().length > 720;
  return { shouldFold, hiddenLineCount };
}

function foldedAssistantAnswerToggleLabel(hiddenLineCount: number) {
  if (hiddenLineCount > 0) {
    return `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`;
  }
  return 'Show full response';
}

export function FoldableAssistantAnswer({
  text,
  foldable = true,
  tone = 'default',
}: {
  text: string;
  foldable?: boolean;
  tone?: 'default' | 'cancelled';
}) {
  const [expanded, setExpanded] = useState(false);
  const supportSubmission = useSupportReportSubmission();
  const reportProposal = useMemo(
    () => supportSubmission ? parseSupportReportProposal(text) : null,
    [supportSubmission, text],
  );
  const visibleText = supportSubmission
    ? reportProposal?.displayText ?? supportReportDisplayText(text)
    : text;
  const foldInfo = useMemo(() => assistantAnswerFoldInfo(visibleText), [visibleText]);
  const shouldFold = foldable && foldInfo.shouldFold;
  const folded = shouldFold && !expanded;
  const cancelled = tone === 'cancelled';

  return (
    <div className={cn(
      'app-live-assistant-answer w-full text-[13px]',
      cancelled && 'app-live-assistant-answer-cancelled text-rose-300',
    )}>
      <div className={cn('app-live-assistant-answer-content', folded && 'app-live-assistant-answer-folded')}>
        <MarkdownContent
          text={visibleText}
          showLinkIcons
          className={cn(
            'app-live-assistant-answer-markdown',
            cancelled && '[&_p]:!text-rose-300 [&_li]:!text-rose-300 [&_blockquote]:!text-rose-300',
          )}
        />
      </div>
      {shouldFold ? (
        <div className="app-fold-reveal-row app-live-assistant-answer-reveal-row">
          <button
            type="button"
            className="app-button-quiet app-inline-expand-toggle app-live-assistant-answer-toggle"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            <span>{folded ? foldedAssistantAnswerToggleLabel(foldInfo.hiddenLineCount) : 'Hide response'}</span>
            {folded
              ? <ChevronDown className="app-inline-expand-toggle-icon" aria-hidden="true" />
              : <ChevronUp className="app-inline-expand-toggle-icon" aria-hidden="true" />}
          </button>
          <span className="app-fold-reveal-line" aria-hidden="true" />
        </div>
      ) : null}
      {reportProposal ? (
        <SupportReportPermissionCard proposal={reportProposal} />
      ) : null}
    </div>
  );
}
