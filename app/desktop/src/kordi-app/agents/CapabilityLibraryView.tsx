import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, FileText, LoaderCircle, LockKeyhole, Puzzle, Wrench } from 'lucide-react';

import { fetchDesktopSkillLibraryDetail, readDesktopSkillLibraryFile, type DesktopSkillLibraryEntry } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import type { FactoryLibraryArtifact, FactoryLibrarySection } from './model';

const KIND_ICONS = { skill: Puzzle, tool: Wrench, plugin: Blocks } satisfies Record<FactoryLibrarySection, typeof Puzzle>;

function kindLabel(kind: FactoryLibrarySection) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function CapabilityLibraryView({
  kind,
  artifact,
  skill,
  onEditInBuild,
}: {
  kind: FactoryLibrarySection;
  artifact: FactoryLibraryArtifact | null;
  skill?: DesktopSkillLibraryEntry | null;
  onEditInBuild: (artifact: FactoryLibraryArtifact) => void;
}) {
  const [files, setFiles] = useState<Array<{ path: string; text: boolean }>>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(kind === 'skill' && Boolean(skill));
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const Icon = KIND_ICONS[kind];

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (kind !== 'skill' || !skill) return undefined;
    void fetchDesktopSkillLibraryDetail(skill.id)
      .then((detail) => {
        if (requestRef.current !== request) return;
        setFiles(detail.files);
        const path = detail.files.find((file) => file.path === 'SKILL.md')?.path ?? detail.files[0]?.path ?? null;
        setSelectedPath(path);
        setContent(path === 'SKILL.md' ? detail.skillMd : '');
      })
      .catch((loadError) => {
        if (requestRef.current === request) setError(loadError instanceof Error ? loadError.message : `Unable to inspect ${skill.name}.`);
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false);
      });
    return () => { requestRef.current += 1; };
  }, [kind, skill]);

  const usage = useMemo(() => artifact?.usedBy.join(', ') || 'Not used by an agent', [artifact?.usedBy]);

  const openFile = async (path: string) => {
    if (!skill || path === selectedPath) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setSelectedPath(path);
    setLoading(true);
    setError(null);
    try {
      const text = await readDesktopSkillLibraryFile(skill.id, path);
      if (requestRef.current === request) setContent(text);
    } catch (readError) {
      if (requestRef.current === request) setError(readError instanceof Error ? readError.message : `Unable to read ${path}.`);
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  };

  if (!artifact) {
    return <main className="app-agent-studio-main"><div className="app-skill-library-state"><Icon className="h-5 w-5" /><strong>No {kind} selected</strong><span>Choose a {kind} to inspect its published state.</span></div></main>;
  }

  return (
    <main className="app-agent-studio-main app-factory-inspect-main">
      <header className="app-agent-studio-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-agent-studio-factory-mark" aria-hidden="true"><Icon className="h-5 w-5" /></span>
          <div className="min-w-0"><h2>{artifact.name}</h2><p>{kindLabel(kind)} · {artifact.status}</p></div>
        </div>
        <button type="button" className="app-button-quiet app-agent-studio-button is-primary" onClick={() => onEditInBuild(artifact)}>Edit in Build</button>
      </header>
      <div className="app-factory-inspect-scroll app-scroll-area">
        <div className="app-factory-readonly-note"><LockKeyhole className="h-4 w-4" /><span>This is the published {kind}. Changes resume its private Build conversation.</span></div>
        <section className="app-factory-inspect-section">
          <header><h3>Published state</h3></header>
          <dl className="app-factory-inspect-grid">
            <div><dt>Kind</dt><dd>{kindLabel(kind)}</dd></div>
            <div><dt>Status</dt><dd>{artifact.status}</dd></div>
            <div><dt>Used by</dt><dd>{usage}</dd></div>
            {skill ? <><div><dt>Source</dt><dd>{skill.sourceLabel}</dd></div><div><dt>Version</dt><dd>{skill.version || 'Unversioned'}</dd></div><div><dt>Files</dt><dd>{skill.fileCount}</dd></div></> : null}
          </dl>
          <p className="app-factory-inspect-copy">{artifact.description || `No published description for this ${kind}.`}</p>
        </section>
        {kind === 'skill' ? (
          <section className="app-factory-inspect-section">
            <header><h3>Files</h3></header>
            {error ? <div className="app-agent-studio-inline-error" role="alert">{error}</div> : null}
            <div className="app-skill-library-files is-readonly">
              <nav aria-label={`${artifact.name} files`}>
                {files.map((file) => <button key={file.path} type="button" className={cn(file.path === selectedPath && 'is-active')} onClick={() => void openFile(file.path)}><FileText className="h-4 w-4" /><span><strong>{file.path}</strong></span></button>)}
              </nav>
              <section className="app-skill-library-editor">
                <header><strong>{selectedPath ?? 'Preview'}</strong><span>Read only</span></header>
                {loading ? <div className="app-skill-library-loading"><LoaderCircle className="h-4 w-4 animate-spin" />Loading file…</div> : <pre>{content || 'No text preview is available.'}</pre>}
              </section>
            </div>
          </section>
        ) : (
          <section className="app-factory-inspect-section">
            <header><h3>Definition</h3><button type="button" onClick={() => onEditInBuild(artifact)}>Change in Build</button></header>
            <p className="app-factory-inspect-copy">The published {kind} identifier is <strong>{artifact.name}</strong>. Its implementation and permissions are reviewed in Build before publishing.</p>
          </section>
        )}
      </div>
    </main>
  );
}
