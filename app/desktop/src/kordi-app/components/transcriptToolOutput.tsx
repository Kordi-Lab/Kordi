import { useMemo, useState, type ComponentType } from 'react';
import { WrapText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isDiffLikeOutput, parseDiffOutput, stripAnsi, type ParsedDiffLine } from './diffOutput';
import { MarkdownCodeBlock } from './markdown';

function looksLikeTerminalTable(text: string) {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length < 3) return false;

  const columnishLines = lines.filter((line) => /\S(?:\s{2,}|\t+)\S/.test(line));
  const dividerLines = lines.filter((line) => /^[-=\s]{6,}$/.test(line));

  return columnishLines.length >= 2 || dividerLines.length >= 1;
}

function DiffOutputBlock({ label, icon, text }: { label: string; icon: ComponentType<{ className?: string }>; text: string }) {
  const Icon = icon;
  const rows = useMemo(() => parseDiffOutput(text), [text]);
  const fileRows = rows.filter((row) => row.kind === 'file');
  const bodyRows = rows.filter((row) => row.kind !== 'file');
  const classForRow = (row: ParsedDiffLine) => cn(
    'app-transcript-diff-row',
    row.kind === 'add' && 'app-transcript-diff-row-add',
    row.kind === 'delete' && 'app-transcript-diff-row-delete',
    row.kind === 'hunk' && 'app-transcript-diff-row-hunk',
  );

  return (
    <div className="py-1.5">
      <div className="app-transcript-block-label mb-1.5 flex items-center gap-2 text-[10px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        <span className="app-transcript-utility-chip rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-400">patch</span>
      </div>
      <div className="app-transcript-diff-block" data-kordi-copy-surface="message">
        {fileRows.length > 0 ? (
          <div className="app-transcript-diff-files">
            {fileRows.map((row, index) => <div key={`diff-file-${index}`} className="truncate">{row.content}</div>)}
          </div>
        ) : null}
        <div className="app-transcript-diff-scroll">
          <div className="app-transcript-diff-table" role="table" aria-label={`${label} patch`}>
            {bodyRows.map((row, index) => (
              <div key={`diff-row-${index}`} className={classForRow(row)} role="row">
                <span className="app-transcript-diff-gutter" role="cell">{row.oldLineNumber ?? ''}</span>
                <span className="app-transcript-diff-gutter" role="cell">{row.newLineNumber ?? ''}</span>
                <span className="app-transcript-diff-marker" role="cell">{row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ' '}</span>
                <code className="app-transcript-diff-code" role="cell">{row.content || ' '}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ToolTranscriptBlock({
  label,
  icon,
  text,
  maxHeightClass,
  language,
  wrapLines,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  text: string;
  maxHeightClass?: string;
  language?: string;
  wrapLines?: boolean;
}) {
  const Icon = icon;
  const cleanedText = useMemo(() => stripAnsi(text), [text]);
  const preserveColumns = useMemo(() => looksLikeTerminalTable(cleanedText), [cleanedText]);
  const [isWrapped, setIsWrapped] = useState(wrapLines ?? !preserveColumns);

  if (isDiffLikeOutput(cleanedText)) {
    return <DiffOutputBlock label={label} icon={icon} text={cleanedText} />;
  }

  return (
    <div className="py-1.5">
      <div className="app-transcript-block-label mb-1.5 flex items-center gap-2 text-[10px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {preserveColumns ? <span className="app-transcript-utility-chip rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-400">column layout</span> : null}
      </div>
      <MarkdownCodeBlock
        code={cleanedText}
        language={language} copySurface="message"
        maxHeightClass={maxHeightClass}
        wrapLines={isWrapped}
        headerActions={
          <button
            type="button"
            aria-label={isWrapped ? 'Disable line wrapping' : 'Wrap long lines'}
            title={isWrapped ? 'Disable line wrapping' : 'Wrap long lines'}
            onClick={() => setIsWrapped((current) => !current)}
            className="app-button-quiet app-transcript-wrap-toggle inline-flex h-6 w-6 items-center justify-center rounded-md p-0"
          >
            <WrapText className="h-3 w-3" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
