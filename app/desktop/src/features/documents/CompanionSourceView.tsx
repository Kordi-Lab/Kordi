import { WrapText } from 'lucide-react';
import { useState } from 'react';
import type { DesktopArtifactPreview } from '@/kordi-app/types';

/** Bounded native preview; never executes a file or renders source as HTML. */
export function CompanionSourceView({ preview, onReload }: { preview: DesktopArtifactPreview | null; onReload: () => void }) {
  const [wrapPreference, setWrapPreference] = useState<boolean | null>(null);
  const extension = preview?.path.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
  const plainText = extension === 'txt' || extension === 'text';
  const wrap = wrapPreference ?? plainText;
  const format = plainText ? 'Plain text' : extension ? extension.toUpperCase() : 'Source';

  if (!preview) return <div className="app-companion-status" role="status">
    <p>This file is unavailable on this device.</p>
    <button type="button" onClick={onReload}>Retry</button>
  </div>;
  return <>
    <div className="app-document-source-toolbar">
      <span>{format}<span aria-hidden="true">·</span>{preview.lines.length} {preview.lines.length === 1 ? 'line' : 'lines'}</span>
      <button type="button" aria-pressed={wrap} onClick={() => setWrapPreference(!wrap)}><WrapText size={14} aria-hidden="true" />Wrap lines</button>
    </div>
    <div className="app-companion-source" data-wrap={wrap} tabIndex={0} aria-label="File source">
      {preview.lines.length ? <pre>{preview.lines.map(line => <span key={line.number} className="app-companion-source-line">
        <span aria-hidden="true">{line.number}</span><code>{line.text || '\u00a0'}</code>
      </span>)}</pre> : <p>This file is empty.</p>}
      {preview.truncated ? <p className="app-companion-status">Preview truncated.</p> : null}
    </div>
  </>;
}
