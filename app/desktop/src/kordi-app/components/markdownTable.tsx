import type { ReactNode } from 'react';

type MarkdownTableProps = {
  headers: string[];
  rows: string[][];
  renderCell: (value: string) => ReactNode;
};

type ResultTableColumns = {
  step: number;
  action: number;
  expected: number;
  actual: number;
  status: number;
};

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function resultTableColumns(headers: string[]): ResultTableColumns | null {
  const normalized = headers.map(normalizedHeader);
  const step = normalized.findIndex((header) => header === 'step');
  const action = normalized.findIndex((header) => header === 'action');
  const expected = normalized.findIndex((header) => header === 'expected result');
  const actual = normalized.findIndex((header) => header === 'actual result');
  const status = normalized.findIndex((header) => header === 'status');
  return [step, action, expected, actual, status].every((index) => index >= 0)
    ? { step, action, expected, actual, status }
    : null;
}

function statusTone(value: string) {
  const normalized = value.trim().toLowerCase();
  if (['pass', 'passed', 'success', 'succeeded', 'complete', 'completed', 'resolved'].includes(normalized)) {
    return 'success';
  }
  if (['fail', 'failed', 'error', 'blocked'].includes(normalized)) {
    return 'danger';
  }
  return 'neutral';
}

function stepLabel(value: string, fallback: number) {
  const normalized = value.trim();
  if (!normalized) return `Step ${fallback}`;
  return /^step\b/i.test(normalized) ? normalized : `Step ${normalized}`;
}

function ResultStepList({
  headers,
  rows,
  columns,
  renderCell,
}: MarkdownTableProps & { columns: ResultTableColumns }) {
  const detailColumns = [columns.action, columns.expected, columns.actual];

  return (
    <ol
      className="overflow-hidden rounded-xl border border-[color:var(--app-divider)] bg-transparent"
      aria-label="Result steps"
    >
      {rows.map((row, rowIndex) => {
        const status = row[columns.status] ?? '';
        return (
          <li
            key={`result-row-${rowIndex}`}
            className="border-b border-[color:var(--app-divider)] px-3 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[color:var(--utility-foreground)]">
                {stepLabel(row[columns.step] ?? '', rowIndex + 1)}
              </span>
              {status.trim() ? (
                <span
                  className="app-markdown-result-status inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-4"
                  data-status-tone={statusTone(status)}
                >
                  {renderCell(status)}
                </span>
              ) : null}
            </div>
            <dl className="mt-2.5 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-3">
              {detailColumns.map((cellIndex) => (
                <div key={`result-field-${rowIndex}-${cellIndex}`} className="min-w-0">
                  <dt className="text-[10px] font-medium leading-4 text-[color:var(--utility-meta-text)]">
                    {headers[cellIndex]}
                  </dt>
                  <dd className="mt-0.5 break-words text-[12px] leading-[1.5] text-[color:var(--utility-foreground)] [overflow-wrap:anywhere]">
                    {renderCell(row[cellIndex] ?? '')}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ol>
  );
}

export function MarkdownTable({ headers, rows, renderCell }: MarkdownTableProps) {
  const resultColumns = resultTableColumns(headers);
  if (resultColumns) {
    return (
      <ResultStepList
        headers={headers}
        rows={rows}
        columns={resultColumns}
        renderCell={renderCell}
      />
    );
  }

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-xl border border-[color:var(--app-divider)] bg-transparent">
      <div
        className="max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--app-quiet-control-focus-ring)]"
        role="region"
        aria-label="Scrollable table"
        tabIndex={0}
      >
        <table className="w-full min-w-[34rem] table-auto border-collapse text-left text-[12px] text-[color:var(--utility-foreground)]">
          <thead className="bg-[color:var(--app-main-muted-bg)] text-[color:var(--utility-muted-text)]">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={`header-${index}`}
                  className="break-words border-b border-[color:var(--app-divider)] px-3 py-2 text-[11px] font-medium leading-4 [overflow-wrap:anywhere]"
                >
                  {renderCell(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={`row-${rowIndex}`}
                className="border-b border-[color:var(--app-divider)] transition-colors last:border-b-0 hover:bg-[color:var(--app-control-hover)]"
              >
                {headers.map((_, cellIndex) => (
                  <td
                    key={`cell-${rowIndex}-${cellIndex}`}
                    className="break-words align-top px-3 py-2.5 leading-[1.5] text-[color:var(--utility-foreground)] [overflow-wrap:anywhere]"
                  >
                    {renderCell(row[cellIndex] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
