import { Flag } from 'lucide-react';

import { cn } from '@/lib/utils';

import { reportSelectionState, useReportSelection } from './reportSelectionStore';
import { useSafetyActions } from './safetyActions';

/** Selection-bar action that reports the selected messages together. */
export function ReportSelectedMessagesButton({ className }: { className?: string }) {
  const safety = useSafetyActions();
  const messages = useReportSelection();
  if (!safety.safetyFeaturesAvailable || messages.length === 0) return null;
  const { target, problem } = reportSelectionState(messages);
  const count = messages.length;
  return (
    <button
      type="button"
      data-message-selection-report="true"
      className={cn('app-button-quiet inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50', className)}
      disabled={!target}
      title={problem ?? undefined}
      aria-label={`Report ${count} selected ${count === 1 ? 'message' : 'messages'}`}
      onClick={() => { if (target) safety.openReport(target); }}
    >
      <Flag className="h-3.5 w-3.5" aria-hidden="true" />
      Report
    </button>
  );
}
