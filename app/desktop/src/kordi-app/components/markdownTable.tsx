import type { ReactNode } from 'react';

type MarkdownTableProps = {
  headers: string[];
  rows: string[][];
  renderCell: (value: string) => ReactNode;
};

export function MarkdownTable({ headers, rows, renderCell }: MarkdownTableProps) {
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-[color:var(--app-control-bg)]">
      <div
        className="max-w-full overflow-x-auto overscroll-x-contain p-1"
        role="region"
        aria-label="Scrollable table"
        tabIndex={0}
      >
        <table className="w-full min-w-[30rem] table-fixed border-collapse text-left text-sm text-slate-100">
          <thead className="bg-white/[0.05] text-slate-300">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={`header-${index}`}
                  className="break-words border-b border-white/8 px-3 py-2 font-medium [overflow-wrap:anywhere]"
                >
                  {renderCell(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="border-b border-white/6 last:border-b-0">
                {headers.map((_, cellIndex) => (
                  <td
                    key={`cell-${rowIndex}-${cellIndex}`}
                    className="break-words align-top px-3 py-2 text-slate-200 [overflow-wrap:anywhere]"
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
