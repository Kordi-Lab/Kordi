import type { DesktopArtifactPreview } from '@/kordi-app/types';

/** Bounded native preview; never executes a file or renders source as HTML. */
export function CompanionSourceView({ preview, onReload }: { preview: DesktopArtifactPreview | null; onReload: () => void }) {
  if (!preview) return <div className="app-companion-status" role="status">
    <p>This file is unavailable on this device.</p>
    <button type="button" onClick={onReload}>Retry</button>
  </div>;
  return <div className="app-companion-source" tabIndex={0} aria-label="File source">
    {preview.lines.length ? <pre>{preview.lines.map(line => <span key={line.number} className="app-companion-source-line"><span aria-hidden="true">{line.number}</span><code>{line.text || '\u00a0'}</code></span>)}</pre> : <p>This file is empty.</p>}
    {preview.truncated ? <p className="app-companion-status">Preview truncated.</p> : null}
  </div>;
}
