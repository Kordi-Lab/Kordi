import { handleDocumentCopySurfaceKeyDown } from '@/features/contentSelection';
import { cn } from '@/lib/utils';

import type { ArtifactPreviewMode } from './artifactPreviewDocument';

function parseDelimitedRows(source: string, delimiter: ',' | '\t') {
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }

    cells.push(current.trim());
    return cells;
  });
}


export function ArtifactDataTable({ source, delimiter, mode = 'panel' }: { source: string; delimiter: ',' | '\t'; mode?: ArtifactPreviewMode }) {
  const rows = parseDelimitedRows(source, delimiter);
  if (rows.length === 0) return <div className="px-4 py-4 text-[12px] text-slate-400">This table is empty.</div>;
  const [headers, ...bodyRows] = rows;

  return (
    <div data-artifact-preview-mode={mode} data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown} className={cn('overflow-auto p-3', mode === 'panel' ? 'max-h-[32rem]' : 'min-h-full')}>
      <div className="overflow-hidden rounded-[18px] border border-white/8 bg-[color:var(--app-control-bg)]/70">
        <table className="min-w-full border-collapse text-left text-[12px] text-slate-100">
          <thead className="bg-white/[0.05] text-[10px] uppercase tracking-[0.12em] text-slate-400">
            <tr>
              {headers.map((header, index) => <th key={`header-${index}`} className="border-b border-white/8 px-3 py-2 font-medium">{header || `Column ${index + 1}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="border-b border-white/6 last:border-b-0">
                {headers.map((_, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`} className="align-top px-3 py-2 text-slate-200">{row[cellIndex] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
