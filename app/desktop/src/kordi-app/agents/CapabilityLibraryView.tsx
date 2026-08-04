import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Check, FileText, LoaderCircle, Puzzle, Wrench } from 'lucide-react';

import {
  fetchDesktopSkillLibraryDetail,
  readDesktopSkillLibraryFile,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { CommunitySkillView } from './SkillLibraryView';
import type { FactoryLibraryArtifact, FactoryLibrarySection } from './model';

const KIND_ICONS = { skill: Puzzle, tool: Wrench, plugin: Blocks } satisfies Record<FactoryLibrarySection, typeof Puzzle>;

export type FactorySkillLibraryMode = 'installed' | 'community';

function kindLabel(kind: FactoryLibrarySection) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function skillSource(skill: DesktopSkillLibraryEntry) {
  if (skill.provider?.trim()) return skill.provider === 'skills-sh' ? 'skills.sh' : skill.provider.trim();
  if (skill.origin === 'built') return 'Kordi Factory';
  if (skill.origin === 'project' || skill.scope === 'project') return 'This project';
  if (skill.origin === 'community') return 'Community';
  if (skill.scope === 'package') return 'Installed package';
  if (['installed', 'external'].includes(skill.origin) || ['global', 'shared', 'external'].includes(skill.scope)) return 'Local library';
  return skill.sourceLabel.replace(/^settings:/i, '') || 'Local library';
}

function SkillModeSwitch({
  mode,
  count,
  onChange,
}: {
  mode: FactorySkillLibraryMode;
  count: number;
  onChange: (mode: FactorySkillLibraryMode) => void;
}) {
  return (
    <div className="app-factory-skill-mode" role="tablist" aria-label="Skill sources">
      <button type="button" role="tab" aria-selected={mode === 'installed'} className={cn(mode === 'installed' && 'is-active')} onClick={() => onChange('installed')}>My skills <span>{count}</span></button>
      <button type="button" role="tab" aria-selected={mode === 'community'} className={cn(mode === 'community' && 'is-active')} onClick={() => onChange('community')}>Community</button>
    </div>
  );
}

export function CapabilityLibraryView({
  kind,
  artifact,
  skill,
  skillMode = 'installed',
  installedSkills = [],
  onSkillModeChange = () => undefined,
  onCommunityInstalled = () => undefined,
  onEditInBuild,
}: {
  kind: FactoryLibrarySection;
  artifact: FactoryLibraryArtifact | null;
  skill?: DesktopSkillLibraryEntry | null;
  skillMode?: FactorySkillLibraryMode;
  installedSkills?: DesktopSkillLibraryEntry[];
  onSkillModeChange?: (mode: FactorySkillLibraryMode) => void;
  onCommunityInstalled?: (skill: DesktopSkillLibraryEntry) => Promise<void> | void;
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

  if (kind === 'skill' && skillMode === 'community') {
    return (
      <main className="app-agent-studio-main app-factory-community-main">
        <header className="app-agent-studio-header">
          <div className="flex min-w-0 items-center gap-3">
            <span className="app-agent-studio-factory-mark" aria-hidden="true"><Puzzle className="h-5 w-5" /></span>
            <h2>Skills</h2>
          </div>
          <SkillModeSwitch mode={skillMode} count={installedSkills.length} onChange={onSkillModeChange} />
        </header>
        <CommunitySkillView
          skills={installedSkills}
          agentTargets={[]}
          onInstalled={onCommunityInstalled}
          onAddToAgent={() => undefined}
        />
      </main>
    );
  }

  if (!artifact) {
    return <main className="app-agent-studio-main"><div className="app-skill-library-state"><Icon className="h-4 w-4" /><strong>No {kind} selected</strong><span>Choose a {kind} to inspect.</span></div></main>;
  }

  return (
    <main className="app-agent-studio-main app-factory-inspect-main">
      <header className="app-agent-studio-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-agent-studio-factory-mark" aria-hidden="true"><Icon className="h-5 w-5" /></span>
          <div className="min-w-0"><h2>{artifact.name}</h2><p>{kindLabel(kind)} · {artifact.status}</p></div>
        </div>
        <div className="app-agent-studio-header-actions">
          {kind === 'skill' ? <SkillModeSwitch mode={skillMode} count={installedSkills.length} onChange={onSkillModeChange} /> : null}
          <button type="button" className="app-button-quiet app-agent-studio-button is-primary" onClick={() => onEditInBuild(artifact)}>Edit in Build</button>
        </div>
      </header>

      <div className="app-factory-library-detail">
        <aside className="app-factory-library-overview app-scroll-area">
          <section>
            <h3>About</h3>
            <p>{artifact.description || 'No description.'}</p>
          </section>
          <section>
            <h3>Details</h3>
            <dl>
              <div><dt>Status</dt><dd><Check className="h-3.5 w-3.5" />{artifact.status}</dd></div>
              <div><dt>Used by</dt><dd>{usage}</dd></div>
              {skill ? <><div><dt>Source</dt><dd>{skillSource(skill)}</dd></div><div><dt>Version</dt><dd>{skill.version || 'Unversioned'}</dd></div><div><dt>Files</dt><dd>{skill.fileCount}</dd></div></> : <div><dt>Identifier</dt><dd>{artifact.id}</dd></div>}
            </dl>
          </section>
        </aside>

        <section className="app-factory-library-preview">
          {error ? <div className="app-agent-studio-inline-error" role="alert">{error}</div> : null}
          {kind === 'skill' ? (
            <>
              <nav className="app-factory-library-file-tabs" aria-label={`${artifact.name} files`}>
                {files.map((file) => <button key={file.path} type="button" aria-current={file.path === selectedPath ? 'true' : undefined} className={cn(file.path === selectedPath && 'is-active')} onClick={() => void openFile(file.path)}><FileText className="h-3.5 w-3.5" /><span>{file.path}</span></button>)}
              </nav>
              <div className="app-factory-library-code">
                {loading ? <div className="app-skill-library-loading"><LoaderCircle className="h-4 w-4 animate-spin" />Loading file…</div> : <pre>{content || 'No text preview is available.'}</pre>}
              </div>
            </>
          ) : (
            <div className="app-factory-library-definition">
              <Icon className="h-6 w-6" />
              <div><strong>{artifact.name}</strong><span>{kindLabel(kind)}</span></div>
              <p>{artifact.description || 'No description.'}</p>
              <code>{artifact.id}</code>
              <button type="button" className="app-button-quiet app-agent-studio-button" onClick={() => onEditInBuild(artifact)}>Change in Build</button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
