import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { ChangedFileRow } from '../types';

function changedFileStatusGlyph(status: ChangedFileRow['status']) {
  if (status === 'new') return '+';
  if (status === 'deleted') return '−';
  return '✱';
}

function changedFileStatusLabel(status: ChangedFileRow['status']) {
  if (status === 'new') return 'new';
  if (status === 'deleted') return 'deleted';
  return 'modified';
}

function changedFileStatusClassName(status: ChangedFileRow['status']) {
  if (status === 'new') return 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200';
  if (status === 'deleted') return 'border-rose-300/20 bg-rose-300/10 text-rose-200';
  return 'border-sky-300/20 bg-sky-300/10 text-sky-200';
}

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

  const visibleRows = expanded || rows.length < 5 ? rows : rows.slice(0, 5);
  const hiddenCount = rows.length - visibleRows.length;
  const header = `Changed ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`;

  return (
    <div data-inline-changed-files="true" className="app-inline-changed-files mt-2.5 rounded-[16px] border border-white/10 bg-white/[0.035] p-2.5 shadow-sm">
      <div className="mb-2 px-1 text-[12px] font-semibold text-slate-200">{header}</div>
      <div className="space-y-1.5">
        {visibleRows.map((row) => {
          const statusLabel = changedFileStatusLabel(row.status);
          return (
            <button
              key={row.artifactId}
              type="button"
              data-inline-changed-file-row="true"
              data-artifact-id={row.artifactId}
              onClick={() => openInlineChangedFile(row, onOpenArtifact)}
              className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[12px] border border-white/8 bg-black/10 px-2.5 py-2 text-left transition hover:border-white/16 hover:bg-white/[0.045]"
              aria-label={`Open ${row.path} in Artifact Inspector`}
              title={row.path}
            >
              <span className={cn('grid h-5.5 w-5.5 place-items-center rounded-md border text-[12px] font-black leading-none', changedFileStatusClassName(row.status))} aria-hidden="true">
                {changedFileStatusGlyph(row.status)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11.5px] leading-4 text-slate-200">{row.path}</span>
                <span className="block text-[10px] leading-3 text-slate-500">{statusLabel}</span>
              </span>
              {row.diffStat ? (
                <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] leading-none">
                  <span className="text-emerald-300">+{row.diffStat.added}</span>
                  <span className="text-rose-300">−{row.diffStat.removed}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:bg-white/[0.04] hover:text-slate-200"
          aria-expanded={expanded}
        >
          Show {hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}
