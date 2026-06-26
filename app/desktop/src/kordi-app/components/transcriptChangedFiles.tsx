import { useState } from 'react';

import type { ChangedFileRow } from '../types';

export function openInlineChangedFile(row: ChangedFileRow, onOpenArtifact?: (artifactId: string) => void) {
  onOpenArtifact?.(row.artifactId);
}

export function InlineChangedFiles({
  rows,
  onOpenArtifact,
}: {
  rows: ChangedFileRow[];
  incomplete?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;

  const header = `Changed ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`;

  return (
    <div data-inline-changed-files="true" className="app-inline-changed-files mt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 text-slate-400 transition hover:bg-white/[0.035] hover:text-slate-200"
        aria-expanded={expanded}
      >
        <span className="text-[10px] text-slate-500" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span>{header}</span>
      </button>
      {expanded ? (
        <div className="mt-1 space-y-0.5 pl-4">
          {rows.map((row) => (
            <button
              key={row.artifactId}
              type="button"
              data-inline-changed-file-row="true"
              data-artifact-id={row.artifactId}
              onClick={() => openInlineChangedFile(row, onOpenArtifact)}
              className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] leading-4 text-slate-300 transition hover:bg-white/[0.035] hover:text-white"
              aria-label={`Open ${row.path} in Artifact Inspector`}
              title={row.path}
            >
              {row.path}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
