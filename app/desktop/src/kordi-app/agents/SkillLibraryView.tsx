import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  FolderGit2,
  Globe2,
  LoaderCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import {
  fetchDesktopCommunitySkillDetail,
  fetchDesktopCommunitySkillProviders,
  fetchDesktopSkillLibraryDetail,
  installDesktopCommunitySkill,
  openDesktopExternalUrl,
  readDesktopSkillLibraryFile,
  searchDesktopCommunitySkills,
  writeDesktopSkillLibraryFile,
  type DesktopCommunitySkillDetail,
  type DesktopCommunitySkillSummary,
  type DesktopSkillLibraryDetail,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import { skillLibraryFileDisplay } from './model';

type CommunityProvider = 'clawhub' | 'skills-sh';

export type SkillAgentTarget = Pick<Agent, 'id' | 'name' | 'role' | 'avatarSeed' | 'profileImageUrl' | 'loadedSkills'>;

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function formatCount(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 1_000 ? 'compact' : 'standard' }).format(value);
}

function installedCommunityMatch(skills: DesktopSkillLibraryEntry[], result?: DesktopCommunitySkillSummary | null) {
  if (!result) return null;
  return skills.find((skill) => (
    skill.provider === result.provider
      && skill.owner === result.owner
      && (skill.sourceUrl === result.sourceUrl || skill.name === result.slug)
  )) ?? null;
}

const SKILL_CATEGORIES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Agent building', pattern: /\b(agent creator|agent builder|create agents?|build agents?|skill creator|skill installer)\b/i },
  { label: 'UI', pattern: /\b(ui|ux|design|interface|layout|responsive|typography|typeset|color|visual|animation|frontend|accessibility|theme)\b/i },
  { label: 'Research', pattern: /\b(research|search|browse|discover|citation|sources?|information retrieval)\b/i },
  { label: 'Engineering', pattern: /\b(code|coding|repository|developer|debug|test|testing|react|next\.js|performance|technical|api)\b/i },
  { label: 'Writing', pattern: /\b(write|writing|copy|document|editorial|summarize|translation)\b/i },
  { label: 'Automation', pattern: /\b(automate|automation|workflow|schedule|orchestrat|task runner)\b/i },
  { label: 'Productivity', pattern: /\b(productivity|organize|planning|focus|calendar|email)\b/i },
];

function skillCategory(skill: DesktopSkillLibraryEntry) {
  const searchableText = `${skill.name.replace(/-/g, ' ')} ${skill.description}`;
  return SKILL_CATEGORIES.find(({ pattern }) => pattern.test(searchableText))?.label ?? 'General';
}

function communityProviderLabel(provider: string) {
  if (provider === 'clawhub') return 'ClawHub';
  if (provider === 'skills-sh') return 'skills.sh';
  return provider;
}

function skillInstallSource(skill: DesktopSkillLibraryEntry) {
  if (skill.provider?.trim()) return communityProviderLabel(skill.provider.trim());
  if (skill.origin === 'built') return 'Kordi Factory';
  if (skill.origin === 'project' || skill.scope === 'project') return 'This project';
  if (skill.origin === 'community') return 'Community';
  if (skill.scope === 'package') return 'Installed package';
  if (['installed', 'external'].includes(skill.origin) || ['global', 'shared', 'external'].includes(skill.scope)) return 'Local library';
  return '—';
}

function normalizedSkillName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

export function AddToAgentControl({
  skill,
  content,
  agentTargets,
  onAddToAgent,
}: {
  skill: DesktopSkillLibraryEntry;
  content: string;
  agentTargets: SkillAgentTarget[];
  onAddToAgent: (agentId: string, skill: DesktopSkillLibraryEntry, content: string) => Promise<void> | void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const skillName = normalizedSkillName(skill.name);

  useEffect(() => {
    setAddingAgentId(null);
    setAddError(null);
  }, [skill.id]);

  useEffect(() => {
    if (!pickerOpen || typeof document === 'undefined') return undefined;

    const closePicker = (restoreFocus = false) => {
      detailsRef.current?.removeAttribute('open');
      setPickerOpen(false);
      if (restoreFocus) queueMicrotask(() => summaryRef.current?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && detailsRef.current?.contains(target)) return;
      closePicker();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [pickerOpen]);

  if (agentTargets.length === 0) return null;

  const addToAgent = async (agent: SkillAgentTarget) => {
    if (addingAgentId) return;
    setAddingAgentId(agent.id);
    setAddError(null);
    try {
      await onAddToAgent(agent.id, skill, content);
      detailsRef.current?.removeAttribute('open');
      setPickerOpen(false);
    } catch (error) {
      setAddError(errorMessage(error, `Kordi could not add ${skill.name} to ${agent.name}.`));
    } finally {
      setAddingAgentId(null);
    }
  };

  return (
    <details
      ref={detailsRef}
      className="app-skill-agent-picker"
      onToggle={(event) => setPickerOpen(event.currentTarget.open)}
    >
      <summary ref={summaryRef} className="app-button-quiet app-agent-studio-button is-primary" aria-label={`Add ${skill.name} to an agent`}>
        <Plus className="h-4 w-4" />
        Add to agent
      </summary>
      <div className="app-skill-agent-picker-panel" role="menu" aria-label="Choose an agent">
        <div className="app-skill-agent-picker-heading">
          <strong>Choose an agent</strong>
          <span>The skill will be staged in its private draft.</span>
        </div>
        <div className="app-skill-agent-picker-list app-scroll-area">
          {agentTargets.map((agent) => {
            const alreadyAdded = agent.loadedSkills.some((name) => normalizedSkillName(name) === skillName);
            const adding = addingAgentId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                disabled={Boolean(addingAgentId) || alreadyAdded}
                onClick={() => void addToAgent(agent)}
              >
                <IdentityAvatar
                  kind="agent"
                  seed={agent.avatarSeed ?? agent.id}
                  name={agent.name}
                  imageUrl={agent.profileImageUrl}
                  className="h-8 w-8 rounded-[10px]"
                />
                <span className="min-w-0">
                  <strong>{agent.name}</strong>
                  <small>{agent.role || 'Agent'}</small>
                </span>
                <span className="app-skill-agent-picker-state">
                  {adding ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Adding</> : alreadyAdded ? <><Check className="h-3.5 w-3.5" />Added</> : null}
                </span>
              </button>
            );
          })}
        </div>
        {addError ? <div className="app-skill-agent-picker-error" role="alert">{addError}</div> : null}
      </div>
    </details>
  );
}

export function SkillLibraryView({
  skills,
  selectedSkillId,
  loading,
  error,
  mutatingSkillId,
  agentTargets,
  onSelectSkill,
  onRefresh,
  onSetEnabled,
  onRemove,
  onInstalled,
  onAddToAgent,
}: {
  skills: DesktopSkillLibraryEntry[];
  selectedSkillId: string | null;
  loading: boolean;
  error: string | null;
  mutatingSkillId: string | null;
  agentTargets: SkillAgentTarget[];
  onSelectSkill: (skillId: string) => void;
  onRefresh: () => Promise<DesktopSkillLibraryEntry[]>;
  onSetEnabled: (skill: DesktopSkillLibraryEntry, enabled: boolean) => Promise<DesktopSkillLibraryEntry | null>;
  onRemove: (skill: DesktopSkillLibraryEntry) => Promise<boolean>;
  onInstalled: (skill: DesktopSkillLibraryEntry) => Promise<void> | void;
  onAddToAgent: (agentId: string, skill: DesktopSkillLibraryEntry, content: string) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<'installed' | 'community'>('installed');

  return (
    <main className="app-agent-studio-main app-skill-library-main">
      <header className="app-agent-studio-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-agent-studio-factory-mark" aria-hidden="true"><Puzzle className="h-5 w-5" /></span>
          <h2>Skill Library</h2>
        </div>
        <button type="button" className="app-button-quiet app-agent-studio-button is-ghost" onClick={() => void onRefresh()} disabled={loading}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />Refresh</button>
      </header>
      <div className="app-skill-library-mode" role="tablist" aria-label="Skill Library sections">
        <button type="button" role="tab" aria-selected={mode === 'installed'} className={cn(mode === 'installed' && 'is-active')} onClick={() => setMode('installed')}>My skills <span>{skills.length}</span></button>
        <button type="button" role="tab" aria-selected={mode === 'community'} className={cn(mode === 'community' && 'is-active')} onClick={() => setMode('community')}>Community</button>
      </div>
      {mode === 'installed' ? (
        <InstalledSkillView
          skills={skills}
          selectedSkillId={selectedSkillId}
          loading={loading}
          error={error}
          mutatingSkillId={mutatingSkillId}
          agentTargets={agentTargets}
          onSelectSkill={onSelectSkill}
          onRefresh={onRefresh}
          onSetEnabled={onSetEnabled}
          onRemove={onRemove}
          onAddToAgent={onAddToAgent}
        />
      ) : (
        <CommunitySkillView
          skills={skills}
          agentTargets={agentTargets}
          onInstalled={onInstalled}
          onAddToAgent={onAddToAgent}
        />
      )}
    </main>
  );
}

function InstalledSkillView({
  skills,
  selectedSkillId,
  loading,
  error,
  mutatingSkillId,
  agentTargets,
  onSelectSkill,
  onRefresh,
  onSetEnabled,
  onRemove,
  onAddToAgent,
}: {
  skills: DesktopSkillLibraryEntry[];
  selectedSkillId: string | null;
  loading: boolean;
  error: string | null;
  mutatingSkillId: string | null;
  agentTargets: SkillAgentTarget[];
  onSelectSkill: (skillId: string) => void;
  onRefresh: () => Promise<DesktopSkillLibraryEntry[]>;
  onSetEnabled: (skill: DesktopSkillLibraryEntry, enabled: boolean) => Promise<DesktopSkillLibraryEntry | null>;
  onRemove: (skill: DesktopSkillLibraryEntry) => Promise<boolean>;
  onAddToAgent: (agentId: string, skill: DesktopSkillLibraryEntry, content: string) => Promise<void> | void;
}) {
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null;
  const [detail, setDetail] = useState<DesktopSkillLibraryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRequestRef = useRef(0);

  useEffect(() => {
    if (!selectedSkillId && skills[0]) onSelectSkill(skills[0].id);
  }, [onSelectSkill, selectedSkillId, skills]);

  useEffect(() => {
    let cancelled = false;
    fileRequestRef.current += 1;
    setConfirmRemove(false);
    setSelectedPath('SKILL.md');
    setDetail(null);
    setDetailError(null);
    if (!selectedSkill) return undefined;
    setDetailLoading(true);
    void fetchDesktopSkillLibraryDetail(selectedSkill.id)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setContent(next.skillMd);
        setSavedContent(next.skillMd);
      })
      .catch((detailLoadError) => {
        if (!cancelled) setDetailError(errorMessage(detailLoadError, `Kordi could not open ${selectedSkill.name}.`));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedSkill?.id]);

  const selectFile = async (path: string) => {
    if (!selectedSkill || path === selectedPath) return;
    const request = fileRequestRef.current + 1;
    fileRequestRef.current = request;
    setSelectedPath(path);
    setFileLoading(true);
    setDetailError(null);
    try {
      const text = path === 'SKILL.md' && detail ? detail.skillMd : await readDesktopSkillLibraryFile(selectedSkill.id, path);
      if (fileRequestRef.current === request) {
        setContent(text);
        setSavedContent(text);
      }
    } catch (readError) {
      if (fileRequestRef.current === request) {
        setContent('');
        setSavedContent('');
        setDetailError(errorMessage(readError, `Kordi could not read ${path}.`));
      }
    } finally {
      if (fileRequestRef.current === request) setFileLoading(false);
    }
  };

  const save = async () => {
    if (!selectedSkill || saving || content === savedContent) return;
    setSaving(true);
    setDetailError(null);
    try {
      const next = await writeDesktopSkillLibraryFile(selectedSkill.id, selectedPath, content);
      setDetail(next);
      setSavedContent(content);
      await onRefresh();
    } catch (saveError) {
      setDetailError(errorMessage(saveError, `Kordi could not save ${selectedPath}.`));
    } finally {
      setSaving(false);
    }
  };

  if (loading && skills.length === 0) return <SkillLibraryState loading title="Loading installed skills" detail="Reading the real skill roots used by the Kordi runtime." />;
  if (error && skills.length === 0) return <SkillLibraryState title="Skill Library is unavailable" detail={error} />;
  if (!selectedSkill) return <SkillLibraryState title="Your library is empty" detail="Build a skill in Factory or find one in Community." />;

  const activeFile = detail?.files.find((file) => file.path === selectedPath);
  const canEditFile = Boolean(detail?.skill.editable && activeFile?.text);
  const category = skillCategory(selectedSkill);
  const installedFrom = skillInstallSource(selectedSkill);
  const version = selectedSkill.version?.trim() || '—';

  return (
    <div className="app-skill-library-detail">
      <section className="app-skill-library-summary">
        <div className="app-skill-library-title-row">
          <span className="app-agent-studio-skill-avatar is-large"><Puzzle className="h-5 w-5" /></span>
          <div className="min-w-0"><h3>{selectedSkill.name}</h3><p>{selectedSkill.description || 'No description provided.'}</p></div>
          <span className={cn('app-agent-studio-state-pill', selectedSkill.enabled && 'is-enabled')}>{selectedSkill.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <dl className="app-skill-library-facts">
          <div><dt>Category</dt><dd>{category}</dd></div>
          <div><dt>Installed from</dt><dd>{installedFrom}</dd></div>
          <div><dt>Version</dt><dd>{version}</dd></div>
        </dl>
        <div className="app-skill-library-actions">
          <button type="button" className="app-button-quiet app-agent-studio-button" disabled={mutatingSkillId === selectedSkill.id} onClick={() => void onSetEnabled(selectedSkill, !selectedSkill.enabled)}>{mutatingSkillId === selectedSkill.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{selectedSkill.enabled ? 'Disable' : 'Enable'}</button>
          <AddToAgentControl skill={selectedSkill} content={detail?.skillMd ?? ''} agentTargets={agentTargets} onAddToAgent={onAddToAgent} />
          {selectedSkill.removable ? <button type="button" className="app-button-quiet app-agent-studio-button is-danger" onClick={() => setConfirmRemove(true)}><Trash2 className="h-4 w-4" />Remove</button> : null}
        </div>
        {confirmRemove ? (
          <div className="app-skill-library-confirm" role="alertdialog" aria-label={`Remove ${selectedSkill.name}`}>
            <span>Remove this managed skill from Kordi?</span>
            <button type="button" onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button type="button" className="is-danger" onClick={() => void onRemove(selectedSkill).then((removed) => { if (removed) setConfirmRemove(false); })}>Remove</button>
          </div>
        ) : null}
      </section>
      {error ? <div className="app-agent-studio-inline-error">{error}</div> : null}
      {detailError ? <div className="app-agent-studio-inline-error">{detailError}</div> : null}
      {detailLoading ? <SkillLibraryState loading title="Opening skill" detail="Reading files and provenance." /> : detail ? (
        <div className="app-skill-library-files">
          <nav aria-label={`${selectedSkill.name} files`}>
            <div className="app-skill-library-files-label">Files</div>
            {detail.files.map((file) => {
              const display = skillLibraryFileDisplay(file.path);
              return (
                <button key={file.path} type="button" className={cn(selectedPath === file.path && 'is-active')} onClick={() => void selectFile(file.path)}>
                  <FileText className="h-4 w-4" />
                  <span><strong>{display.name}</strong>{display.parent ? <small>{display.parent}</small> : null}</span>
                </button>
              );
            })}
          </nav>
          <section className="app-skill-library-editor">
            <header>
              <strong className="min-w-0">{selectedPath}</strong>
              {canEditFile ? <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" disabled={saving || fileLoading || content === savedContent} onClick={() => void save()}>{saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save file</button> : null}
            </header>
            {fileLoading ? <div className="app-skill-library-loading"><LoaderCircle className="h-4 w-4 animate-spin" />Loading file…</div> : canEditFile ? <textarea value={content} onChange={(event) => setContent(event.currentTarget.value)} spellCheck={false} /> : <pre>{content}</pre>}
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function CommunitySkillView({
  skills,
  agentTargets,
  onInstalled,
  onAddToAgent,
}: {
  skills: DesktopSkillLibraryEntry[];
  agentTargets: SkillAgentTarget[];
  onInstalled: (skill: DesktopSkillLibraryEntry) => Promise<void> | void;
  onAddToAgent: (agentId: string, skill: DesktopSkillLibraryEntry, content: string) => Promise<void> | void;
}) {
  const [provider, setProvider] = useState<CommunityProvider>('clawhub');
  const [providers, setProviders] = useState<CommunityProvider[]>(['clawhub']);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DesktopCommunitySkillSummary[]>([]);
  const [selected, setSelected] = useState<DesktopCommunitySkillSummary | null>(null);
  const [detail, setDetail] = useState<DesktopCommunitySkillDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const installedSkill = useMemo(() => installedCommunityMatch(skills, selected), [selected, skills]);
  const selectedPreviewFile = useMemo(() => (
    detail?.files.find((file) => file.path === selectedFilePath)
      ?? detail?.files.find((file) => file.path === 'SKILL.md')
      ?? detail?.files[0]
      ?? null
  ), [detail, selectedFilePath]);

  useEffect(() => {
    let cancelled = false;
    void fetchDesktopCommunitySkillProviders()
      .then((available) => {
        if (cancelled) return;
        const next = available.filter((entry): entry is CommunityProvider => (
          entry === 'clawhub' || entry === 'skills-sh'
        ));
        setProviders(next.length > 0 ? next : ['clawhub']);
        if (!next.includes(provider)) setProvider('clawhub');
      })
      .catch(() => {
        if (!cancelled) setProviders(['clawhub']);
      });
    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    detailRequestRef.current += 1;
    setSelected(null);
    setDetail(null);
    setSelectedFilePath(null);
    setResults([]);
    setError(null);
  }, [provider]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSearching(true);
      setError(null);
      void searchDesktopCommunitySkills(provider, normalized)
        .then((next) => {
          if (!cancelled) setResults(next);
        })
        .catch((searchError) => {
          if (!cancelled) setError(errorMessage(searchError, 'Kordi could not search this community catalog.'));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [provider, query]);

  const openResult = async (skill: DesktopCommunitySkillSummary) => {
    const request = detailRequestRef.current + 1;
    detailRequestRef.current = request;
    setSelected(skill);
    setDetail(null);
    setSelectedFilePath(null);
    setDetailLoading(true);
    setError(null);
    try {
      const next = await fetchDesktopCommunitySkillDetail({
        provider,
        owner: skill.owner,
        slug: skill.slug,
        version: skill.version,
      });
      if (detailRequestRef.current === request) {
        setDetail(next);
        setSelectedFilePath(
          next.files.find((file) => file.path === 'SKILL.md')?.path
            ?? next.files[0]?.path
            ?? null,
        );
      }
    } catch (detailError) {
      if (detailRequestRef.current === request) setError(errorMessage(detailError, `Kordi could not inspect ${skill.name}.`));
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false);
    }
  };

  const install = async () => {
    if (!detail || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const installed = await installDesktopCommunitySkill({
        provider,
        owner: detail.skill.owner,
        slug: detail.skill.slug,
        version: detail.skill.version,
        scope: 'global',
        reviewedDigest: detail.reviewDigest,
      });
      await onInstalled(installed);
      setSelected((current) => current ? { ...current, installed: true } : current);
      setDetail((current) => current ? { ...current, skill: { ...current.skill, installed: true } } : current);
    } catch (installError) {
      setError(errorMessage(installError, `Kordi could not install ${detail.skill.name}.`));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="app-skill-community">
      <aside className="app-skill-community-results">
        <div className="app-skill-community-provider" role="group" aria-label="Community source" style={{ gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))` }}>
          {providers.map((entry) => (
            <button key={entry} type="button" className={cn(provider === entry && 'is-active')} onClick={() => setProvider(entry)}>{communityProviderLabel(entry)}</button>
          ))}
        </div>
        <label className="app-agent-studio-search"><Search className="h-4 w-4" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={`Search ${provider === 'clawhub' ? 'ClawHub' : 'Skills.sh'}`} /></label>
        <div className="app-skill-community-result-list">
          {searching ? <div className="app-skill-community-hint"><LoaderCircle className="h-4 w-4 animate-spin" />Searching community skills…</div> : null}
          {!searching && query.trim().length < 2 ? <div className="app-skill-community-hint"><Globe2 className="h-4 w-4" />Search by task, tool, or workflow.</div> : null}
          {!searching && query.trim().length >= 2 && results.length === 0 && !error ? <div className="app-skill-community-hint">No matching skills found.</div> : null}
          {results.map((skill) => (
            <button key={skill.id} type="button" className={cn(selected?.id === skill.id && 'is-active')} onClick={() => void openResult(skill)}>
              <Puzzle className="h-4 w-4" />
              <span className="min-w-0"><strong>{skill.name}</strong><small>{skill.owner ? `${skill.owner} · ` : ''}{formatCount(skill.downloads)} installs</small></span>
              {skill.installed || installedCommunityMatch(skills, skill) ? <Check className="h-3.5 w-3.5" aria-label="Installed" /> : null}
            </button>
          ))}
        </div>
      </aside>
      <section className="app-skill-community-preview">
        {error ? <div className="app-agent-studio-inline-error">{error}</div> : null}
        {detailLoading ? <SkillLibraryState loading title="Inspecting community skill" detail="Loading its manifest, files, and available security report." /> : detail ? (
          <>
            <header className="app-skill-community-preview-head">
              <div><h3>{detail.skill.name}</h3><p>{detail.skill.description || 'No description provided.'}</p><span className="app-skill-community-source">{detail.skill.owner ?? communityProviderLabel(detail.skill.provider)}</span></div>
              <a className="app-button-quiet app-agent-studio-icon-button" href={detail.skill.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open community source" onClick={(event) => { event.preventDefault(); void openDesktopExternalUrl(detail.skill.sourceUrl); }}><ExternalLink className="h-4 w-4" /></a>
            </header>
            <div className={cn('app-skill-community-security', detail.securityStatus === 'clean' || detail.securityStatus === 'pass' ? 'is-clean' : 'is-warning')}>
              {detail.securityStatus === 'clean' || detail.securityStatus === 'pass' ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
              <div><strong>{detail.securityStatus}</strong><span>{detail.securitySummary}</span></div>
            </div>
            <div className="app-skill-community-meta">
              <span><Download className="h-3.5 w-3.5" />{formatCount(detail.skill.downloads)} installs</span>
              <span><FolderGit2 className="h-3.5 w-3.5" />{detail.files.length} files</span>
              {detail.skill.version ? <span>v{detail.skill.version}</span> : null}
            </div>
            <div className="app-skill-community-install">
              <span className="app-skill-community-install-note">Installs to My Kordi and stays disabled until you enable it.</span>
              {installedSkill ? (
                agentTargets.length > 0 ? <AddToAgentControl skill={installedSkill} content={detail.skillMd} agentTargets={agentTargets} onAddToAgent={onAddToAgent} />
                  : <span className="app-agent-studio-state-pill is-enabled"><Check className="h-3.5 w-3.5" />Installed</span>
              ) : <button type="button" className="app-button-quiet app-agent-studio-button is-primary" onClick={() => void install()} disabled={installing}>{installing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{installing ? 'Installing' : 'Install reviewed skill'}</button>}
            </div>
            <div className="app-skill-community-file-strip" aria-label="Community skill files">{detail.files.map((file) => <button key={file.path} type="button" className={cn(selectedPreviewFile?.path === file.path && 'is-active')} onClick={() => setSelectedFilePath(file.path)}><FileText className="h-3.5 w-3.5" />{file.path}</button>)}</div>
            <pre className="app-skill-community-code">{selectedPreviewFile?.text ?? 'Preview unavailable for this binary file.'}</pre>
          </>
        ) : <SkillLibraryState title="Inspect before installing" detail="Select a result to review its instructions, files, provenance, and available security report." />}
      </section>
    </div>
  );
}

function SkillLibraryState({ loading = false, title, detail }: { loading?: boolean; title: string; detail: string }) {
  return (
    <div className="app-skill-library-state">
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Puzzle className="h-4 w-4" />}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
