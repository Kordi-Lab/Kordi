import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Check,
  Clock3,
  FileCode2,
  FileText,
  FolderOpen,
  History,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  Search,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { handleDocumentCopySurfaceKeyDown } from '@/features/contentSelection';
import { cn } from '@/lib/utils';
import type { DesktopAgentBuilderStatus } from '@/lib/desktop';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import type { ComposerModelOption, ComposerProviderOption } from '../components';
import type { Agent } from '../types';
import { skillLibraryFileDisplay, visibleAgentStudioTabIds, type AgentEditHistoryEntry, type AgentSaveFeedback, type AgentStudioCapabilityKind, type AgentStudioConfigDraft, type AgentStudioTab, type FactoryArtifactKind, type PersistedAgentConfig } from './model';
import type { ShapeAgentDraft } from './shapeAgentDraft';
import { AgentStudioRoutingEditor } from './AgentStudioRoutingEditor';
import { AgentStudioBlueprintView } from './AgentStudioBlueprintView';
import { CLOUD_AGENT_TOOL_DESCRIPTIONS, type AgentModelRoutingDraft } from './factoryAgentUtils';

type FilePreviewState = { status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string };
type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;
const TABS: Array<{ id: AgentStudioTab; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'blueprint', label: 'Blueprint', icon: SlidersHorizontal },
  { id: 'capabilities', label: 'Capabilities', icon: Puzzle },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'history', label: 'History', icon: History },
];

function capabilityField(kind: AgentStudioCapabilityKind): keyof Pick<AgentStudioConfigDraft, 'loadedSkills' | 'loadedTools' | 'loadedPlugins'> {
  if (kind === 'skill') return 'loadedSkills';
  if (kind === 'tool') return 'loadedTools';
  return 'loadedPlugins';
}

function capabilityIcon(kind: AgentStudioCapabilityKind) {
  if (kind === 'skill') return Puzzle;
  if (kind === 'tool') return Wrench;
  return Plug;
}

function cleanCapabilityName(raw: string) {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (!trimmed) return '';
  const tail = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return tail.replace(/\.git$/i, '').trim() || trimmed;
}

function EmptyWorkspaceState({ icon: Icon, title, detail }: { icon: typeof FileText; title: string; detail: string }) {
  return (
    <div className="app-agent-studio-empty">
      <Icon className="h-4 w-4" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function WorkspaceHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="app-agent-studio-view-head">
      <h3>{title}</h3>
      {action}
    </div>
  );
}

type CapabilityItem = {
  kind: AgentStudioCapabilityKind;
  name: string;
  description: string;
  loaded: boolean;
};

type CapabilityCatalogItem = Pick<CapabilityItem, 'kind' | 'name'>;

const CAPABILITY_KINDS: AgentStudioCapabilityKind[] = ['skill', 'tool', 'plugin'];

function readableCapabilityName(value: string) {
  return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function createCapabilityCatalog(sources: Record<AgentStudioCapabilityKind, string[]>) {
  return CAPABILITY_KINDS
    .flatMap((kind) => Array.from(new Set(sources[kind])).map((name) => ({ kind, name })))
    .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

function mergeCapabilityCatalog(current: CapabilityCatalogItem[], incoming: CapabilityCatalogItem[]) {
  const known = new Set(current.map((item) => `${item.kind}:${item.name}`));
  const additions = incoming.filter((item) => !known.has(`${item.kind}:${item.name}`));
  return additions.length > 0 ? [...current, ...additions] : current;
}

function capabilityDescription({
  kind,
  name,
  skillDescriptions,
}: {
  kind: AgentStudioCapabilityKind;
  name: string;
  skillDescriptions: Readonly<Record<string, string>>;
}) {
  if (kind === 'skill') {
    return skillDescriptions[name]
      || skillDescriptions[name.toLocaleLowerCase()]
      || `Reusable guidance for ${readableCapabilityName(name)}.`;
  }
  if (kind === 'tool') {
    return CLOUD_AGENT_TOOL_DESCRIPTIONS[name]
      || `Use ${readableCapabilityName(name)} in this agent.`;
  }
  return `Extend this agent with ${readableCapabilityName(name)}.`;
}

function CapabilityEditor({
  mode,
  capability,
  editableKinds,
  onClose,
  onAdd,
  onRename,
}: {
  mode: 'add' | 'edit';
  capability?: CapabilityItem;
  editableKinds: ReadonlySet<AgentStudioCapabilityKind>;
  onClose: () => void;
  onAdd: (kind: AgentStudioCapabilityKind, name: string) => void;
  onRename: (kind: AgentStudioCapabilityKind, previousName: string, nextName: string) => void;
}) {
  const firstEditable = (['skill', 'tool', 'plugin'] as AgentStudioCapabilityKind[]).find((kind) => editableKinds.has(kind)) ?? 'skill';
  const [kind, setKind] = useState<AgentStudioCapabilityKind>(capability?.kind ?? firstEditable);
  const [source, setSource] = useState<'catalog' | 'path' | 'repository'>('catalog');
  const [value, setValue] = useState(capability?.name ?? '');
  const normalized = cleanCapabilityName(value);

  return (
    <section className="app-agent-studio-popover" role="dialog" aria-label={mode === 'add' ? 'Add capability' : `Edit ${capability?.name ?? 'capability'}`}>
      <div className="app-agent-studio-popover-head">
        <strong>{mode === 'add' ? 'Add capability' : 'Edit capability'}</strong>
        <button type="button" className="app-button-quiet app-agent-studio-icon-button" onClick={onClose} aria-label="Close capability editor"><X className="h-4 w-4" /></button>
      </div>
      {mode === 'add' ? (
        <>
          <div className="app-agent-studio-source-options">
            {(['catalog', 'path', 'repository'] as const).map((option) => (
              <button key={option} type="button" className={cn(source === option && 'is-active')} onClick={() => setSource(option)}>
                {option === 'catalog' ? <Puzzle className="h-4 w-4" /> : option === 'path' ? <FolderOpen className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
                {option === 'catalog' ? 'Catalog' : option === 'path' ? 'Local path' : 'Repository'}
              </button>
            ))}
          </div>
          <label className="app-agent-studio-field">
            <span>Capability type</span>
            <select value={kind} onChange={(event) => setKind(event.currentTarget.value as AgentStudioCapabilityKind)}>
              {(['skill', 'tool', 'plugin'] as AgentStudioCapabilityKind[]).map((option) => (
                <option key={option} value={option} disabled={!editableKinds.has(option)}>{option[0]?.toUpperCase()}{option.slice(1)}{editableKinds.has(option) ? '' : ' · read only'}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <label className="app-agent-studio-field">
        <span>{source === 'catalog' ? 'Capability name' : source === 'path' ? 'Local path' : 'Repository URL or package'}</span>
        <input value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder={source === 'catalog' ? 'navigate-knowledge' : source === 'path' ? './skills/review' : 'github:team/review-skill'} />
      </label>
      <div className="app-agent-studio-popover-actions">
        <button type="button" className="app-button-quiet app-agent-studio-button is-ghost is-small" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="app-button-quiet app-agent-studio-button is-primary is-small"
          disabled={!normalized || !editableKinds.has(kind)}
          onClick={() => {
            if (mode === 'add') onAdd(kind, normalized);
            else if (capability) onRename(capability.kind, capability.name, normalized);
            onClose();
          }}
        >
          {mode === 'add' ? 'Add to draft' : 'Save to draft'}
        </button>
      </div>
    </section>
  );
}

export function CapabilitiesView({
  creating,
  config,
  creationDraft,
  availableSkills,
  skillDescriptions,
  availableTools,
  availablePlugins,
  editableKinds,
  allowCapabilityCreation,
  onToggle,
  onAdd,
  onRename,
  builderStatus,
}: {
  creating: boolean;
  config: AgentStudioConfigDraft | null;
  creationDraft: ShapeAgentDraft | null;
  availableSkills: string[];
  skillDescriptions: Readonly<Record<string, string>>;
  availableTools: string[];
  availablePlugins: string[];
  editableKinds: ReadonlySet<AgentStudioCapabilityKind>;
  allowCapabilityCreation: boolean;
  onToggle: (kind: AgentStudioCapabilityKind, name: string, selected: boolean) => void;
  onAdd: (kind: AgentStudioCapabilityKind, name: string) => void;
  onRename: (kind: AgentStudioCapabilityKind, previousName: string, nextName: string) => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | AgentStudioCapabilityKind>('all');
  const [loadedOnly, setLoadedOnly] = useState(false);
  const [editor, setEditor] = useState<{ mode: 'add' | 'edit'; capability?: CapabilityItem } | null>(null);
  const creationSkills = creationDraft?.skills.map((skill) => skill.name) ?? [];
  const draftConfig: AgentStudioConfigDraft = config ?? {
    systemPrompt: creationDraft?.systemPrompt ?? '',
    loadedSkills: creationSkills,
    loadedTools: builderStatus?.draft?.tools ?? [],
    loadedPlugins: builderStatus?.draft?.plugins ?? [],
  };
  const incomingCatalog = useMemo(() => createCapabilityCatalog({
    skill: Array.from(new Set([...availableSkills, ...draftConfig.loadedSkills])),
    tool: Array.from(new Set([...availableTools, ...draftConfig.loadedTools])),
    plugin: Array.from(new Set([...availablePlugins, ...draftConfig.loadedPlugins])),
  }), [availablePlugins, availableSkills, availableTools, draftConfig.loadedPlugins, draftConfig.loadedSkills, draftConfig.loadedTools]);
  const [catalog, setCatalog] = useState<CapabilityCatalogItem[]>(incomingCatalog);
  useEffect(() => {
    setCatalog((current) => mergeCapabilityCatalog(current, incomingCatalog));
  }, [incomingCatalog]);
  const draftSkillDescriptions = Object.fromEntries([
    ...(creationDraft?.skills ?? []),
    ...(builderStatus?.draft?.skills ?? []),
  ]
    .filter((skill) => skill.description.trim() && skill.description.trim() !== 'Focused instructions for this agent.')
    .map((skill) => [skill.name.toLocaleLowerCase(), skill.description.trim()]));
  const resolvedSkillDescriptions = { ...skillDescriptions, ...draftSkillDescriptions };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = catalog
    .map(({ kind, name }): CapabilityItem => ({
      kind,
      name,
      description: capabilityDescription({ kind, name, skillDescriptions: resolvedSkillDescriptions }),
      loaded: draftConfig[capabilityField(kind)].includes(name),
    }))
    .filter((item) => filter === 'all' || item.kind === filter)
    .filter((item) => !loadedOnly || item.loaded)
    .filter((item) => !normalizedQuery || `${item.name} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery));

  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading
        title="Capabilities"
        action={allowCapabilityCreation ? <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" disabled={editableKinds.size === 0 || (creating && !creationDraft)} onClick={() => setEditor({ mode: 'add' })}><Plus className="h-3.5 w-3.5" />Add capability</button> : undefined}
      />
      <div className="app-agent-studio-capability-toolbar">
        <label className="app-agent-studio-search"><Search className="h-4 w-4" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search capabilities" /></label>
        <div className="app-agent-studio-segmented" role="group" aria-label="Capability type">
          {(['all', 'skill', 'tool', 'plugin'] as const).map((value) => <button key={value} type="button" className={cn(filter === value && 'is-active')} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : `${value[0]?.toUpperCase()}${value.slice(1)}s`}</button>)}
        </div>
        <button type="button" className={cn('app-button-quiet app-agent-studio-button is-small', loadedOnly && 'is-selected')} onClick={() => setLoadedOnly((current) => !current)}>Loaded only</button>
      </div>
      <div className="app-agent-studio-capability-list">
        {items.map((item) => {
          const Icon = capabilityIcon(item.kind);
          const editable = editableKinds.has(item.kind);
          return (
            <div key={`${item.kind}:${item.name}`} className="app-agent-studio-capability-row">
              <span className={cn('app-agent-studio-capability-icon', `is-${item.kind}`)}><Icon className="h-3.5 w-3.5" /></span>
              <div className="app-agent-studio-capability-copy">
                <div className="app-agent-studio-capability-name"><strong>{item.name}</strong></div>
                <p title={item.description}>{item.description}</p>
              </div>
              <div className="app-agent-studio-capability-actions">
                {editable && allowCapabilityCreation && item.loaded ? <button type="button" className="app-button-quiet app-agent-studio-icon-button" aria-label={`Edit ${item.name}`} onClick={() => setEditor({ mode: 'edit', capability: item })}><Pencil className="h-3.5 w-3.5" /></button> : null}
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.loaded}
                  aria-label={`${item.loaded ? 'Remove' : 'Add'} ${item.name} ${item.loaded ? 'from' : 'to'} this agent`}
                  className={cn('app-agent-studio-switch', item.loaded && 'is-on')}
                  disabled={!editable}
                  title={editable ? `${item.loaded ? 'Remove from' : 'Add to'} draft` : 'This capability is read only'}
                  onClick={() => onToggle(item.kind, item.name, item.loaded)}
                />
              </div>
            </div>
          );
        })}
        {items.length === 0 ? <EmptyWorkspaceState icon={Puzzle} title="No matching capabilities" detail="Clear the filters or add a capability to the draft." /> : null}
      </div>
      {editor ? (
        <CapabilityEditor
          mode={editor.mode}
          capability={editor.capability}
          editableKinds={editableKinds}
          onClose={() => setEditor(null)}
          onAdd={(kind, name) => {
            setCatalog((current) => mergeCapabilityCatalog(current, [{ kind, name }]));
            onAdd(kind, name);
          }}
          onRename={(kind, previousName, nextName) => {
            setCatalog((current) => current.map((item) => (
              item.kind === kind && item.name === previousName ? { kind, name: nextName } : item
            )));
            onRename(kind, previousName, nextName);
          }}
        />
      ) : null}
    </div>
  );
}

function FilesView({
  agent,
  creating,
  creationDraft,
  activeDetail,
  config,
  activeFilePreview,
  activeFileDraft,
  activeFileCanEdit,
  activeFileIsEditing,
  fileFeedback,
  canEditPrompt,
  onSelectPrompt,
  onSelectFile,
  onPromptChange,
  onCreationDraftChange,
  onStartFileEditing,
  onCancelFileEditing,
  onSaveFile,
  onFileDraftChange,
  builderStatus,
  onReadBuilderFile,
  onWriteBuilderFile,
}: {
  agent?: Agent;
  creating: boolean;
  creationDraft: ShapeAgentDraft | null;
  activeDetail: DetailTarget;
  config: AgentStudioConfigDraft | null;
  activeFilePreview: FilePreviewState;
  activeFileDraft: string;
  activeFileCanEdit: boolean;
  activeFileIsEditing: boolean;
  fileFeedback: AgentSaveFeedback | null;
  canEditPrompt: boolean;
  onSelectPrompt: () => void;
  onSelectFile: (path: string) => void;
  onPromptChange: (value: string) => void;
  onCreationDraftChange: (draft: ShapeAgentDraft) => void;
  onStartFileEditing: () => void;
  onCancelFileEditing: () => void;
  onSaveFile: () => void;
  onFileDraftChange: (value: string) => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
  onReadBuilderFile?: (path: string) => Promise<string>;
  onWriteBuilderFile?: (path: string, content: string) => Promise<unknown>;
}) {
  if (builderStatus && onReadBuilderFile && onWriteBuilderFile) {
    return (
      <BuilderDraftFilesView
        status={builderStatus}
        onReadFile={onReadBuilderFile}
        onWriteFile={onWriteBuilderFile}
      />
    );
  }
  const detail = creating ? { kind: 'prompt' as const } : activeDetail ?? { kind: 'prompt' as const };
  const prompt = creating ? creationDraft?.systemPrompt ?? '' : config?.systemPrompt ?? '';
  const isPrompt = detail.kind === 'prompt';
  const selectedPath = detail.kind === 'file' ? detail.path : null;

  return (
    <div className="app-agent-studio-view-scroll is-files-view">
      <WorkspaceHeading title="Build files" />
      {!creating && !agent ? <EmptyWorkspaceState icon={FileText} title="No agent selected" detail="Select an agent to inspect its files." /> : (
        <div className="app-agent-studio-files-layout">
          <div className="app-agent-studio-file-list">
            <button type="button" className={cn(isPrompt && 'is-active')} onClick={onSelectPrompt}>
              <FileCode2 className="h-4 w-4" /><span><strong>System prompt</strong><small>{canEditPrompt ? 'Editable draft' : 'Read only'}</small></span>
            </button>
            {(agent?.identityFiles ?? []).map((file) => (
              <button key={file} type="button" className={cn(selectedPath === file && 'is-active')} onClick={() => onSelectFile(file)}>
                <FileText className="h-4 w-4" /><span><strong>{file.split('/').pop() ?? file}</strong><small>{file}</small></span>
              </button>
            ))}
          </div>
          <section className="app-agent-studio-file-editor">
            <div className="app-agent-studio-file-toolbar">
              <div className="min-w-0"><strong>{isPrompt ? 'System prompt' : selectedPath?.split('/').pop() ?? 'File'}</strong><span>{isPrompt ? (canEditPrompt ? 'Reviewable draft' : 'Read only') : selectedPath}</span></div>
              {!isPrompt && activeFileCanEdit ? (
                activeFileIsEditing ? <div className="flex gap-2"><button type="button" className="app-button-quiet app-agent-studio-button is-ghost is-small" onClick={onCancelFileEditing}>Discard</button><button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={onSaveFile}>Save file</button></div>
                  : <button type="button" className="app-button-quiet app-agent-studio-button is-small" onClick={onStartFileEditing} disabled={activeFilePreview.status === 'loading'}>Edit file</button>
              ) : null}
            </div>
            {fileFeedback && !isPrompt ? <div className={cn('app-agent-studio-file-feedback', fileFeedback.tone === 'error' && 'is-error')}>{fileFeedback.text}</div> : null}
            {isPrompt ? (
              canEditPrompt ? <textarea value={prompt} onChange={(event) => {
                if (creating && creationDraft) onCreationDraftChange({ ...creationDraft, systemPrompt: event.currentTarget.value });
                else onPromptChange(event.currentTarget.value);
              }} spellCheck={false} /> : <pre data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown}>{prompt || 'No prompt available.'}</pre>
            ) : activeFileIsEditing ? <textarea value={activeFileDraft} onChange={(event) => onFileDraftChange(event.currentTarget.value)} spellCheck={false} />
              : <pre data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown}>{activeFilePreview.status === 'loading' ? 'Loading…' : activeFileDraft || 'No preview available.'}</pre>}
          </section>
        </div>
      )}
    </div>
  );
}

function BuilderDraftFilesView({
  status,
  onReadFile,
  onWriteFile,
}: {
  status: DesktopAgentBuilderStatus;
  onReadFile: (path: string) => Promise<string>;
  onWriteFile: (path: string, content: string) => Promise<unknown>;
}) {
  const files = status.validation.files;
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? 'agent.json');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedDisplay = skillLibraryFileDisplay(selectedPath);
  useEffect(() => {
    if (files.some((file) => file.path === selectedPath)) return;
    setSelectedPath(files[0]?.path ?? 'agent.json');
  }, [files, selectedPath]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void onReadFile(selectedPath)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
      })
      .catch((readError) => {
        if (!cancelled) setError(readError instanceof Error ? readError.message : 'Unable to read the draft file.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [onReadFile, selectedPath, status.validation.fingerprint]);

  const save = async () => {
    if (saving || content === savedContent) return;
    setSaving(true);
    setError(null);
    try {
      await onWriteFile(selectedPath, content);
      setSavedContent(content);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the draft file.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-agent-studio-view-scroll is-files-view">
      <WorkspaceHeading title="Draft files" />
      <div className="app-agent-studio-files-layout">
        <div className="app-agent-studio-file-list">
          {files.map((file) => {
            const display = skillLibraryFileDisplay(file.path);
            return <button key={file.path} type="button" className={cn(selectedPath === file.path && 'is-active')} aria-label={`${file.path}${file.valid ? '' : ', needs attention'}`} onClick={() => setSelectedPath(file.path)}>
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              <span><strong>{display.name}</strong>{display.parent ? <small>{display.parent}</small> : null}</span>
              {!file.valid ? <span className="app-agent-studio-file-validity is-error" title="Needs attention"><X className="h-3 w-3" /></span> : null}
            </button>;
          })}
        </div>
        <section className="app-agent-studio-file-editor">
          <div className="app-agent-studio-file-toolbar">
            <div className="min-w-0"><strong>{selectedDisplay.name}</strong>{selectedDisplay.parent ? <span>{selectedDisplay.parent}</span> : null}</div>
            {!loading && (saving || content !== savedContent) ? (
              <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            ) : !loading ? <span className="app-agent-studio-file-saved"><Check className="h-3 w-3" />Saved</span> : null}
          </div>
          {error ? <div className="app-agent-studio-file-feedback is-error">{error}</div> : null}
          {loading ? <div className="app-agent-studio-runtime-note"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading draft file…</div> : (
            <textarea value={content} onChange={(event) => setContent(event.currentTarget.value)} spellCheck={false} />
          )}
        </section>
      </div>
    </div>
  );
}

function RunsView({
  agent,
  onOpenReachout,
  builderStatus,
  builderTesting,
  onTestBuilderDraft,
}: {
  agent?: Agent;
  onOpenReachout?: (sessionId: string) => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
  builderTesting?: boolean;
  onTestBuilderDraft?: () => void;
}) {
  if (builderStatus) {
    const reportIsCurrent = Boolean(
      builderStatus.testReport
        && builderStatus.testReport.fingerprint === builderStatus.validation.fingerprint,
    );
    return (
      <div className="app-agent-studio-view-scroll">
        <WorkspaceHeading
          title="Validate and test"
          action={<button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" disabled={!builderStatus.validation.valid || builderTesting} onClick={onTestBuilderDraft}>{builderTesting ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Testing…</> : 'Test draft'}</button>}
        />
        <div className="app-agent-studio-run-checks">
          <section className={cn('app-agent-studio-run-check', builderStatus.validation.valid ? 'is-success' : 'is-error')}>
            <span>{builderStatus.validation.valid ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}</span>
            <div><strong>{builderStatus.validation.valid ? 'Files are valid' : 'Draft needs attention'}</strong><p>{builderStatus.validation.valid ? `${builderStatus.validation.files.length} draft files passed structural validation.` : builderStatus.validation.errors.join(' ')}</p></div>
          </section>
          <section className={cn('app-agent-studio-run-check', reportIsCurrent && builderStatus.testReport?.passed ? 'is-success' : builderStatus.testReport && reportIsCurrent ? 'is-error' : '')}>
            <span>{builderTesting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : reportIsCurrent && builderStatus.testReport?.passed ? <Check className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}</span>
            <div><strong>{builderTesting ? 'Testing the candidate runtime' : reportIsCurrent ? builderStatus.testReport?.passed ? 'Runtime test passed' : 'Runtime test failed' : 'Runtime test required'}</strong><p>{builderTesting ? 'Kordi is starting a disposable session with the candidate prompt and skills.' : reportIsCurrent ? builderStatus.testReport?.summary : 'Run a new test after every file change.'}</p></div>
          </section>
        </div>
      </div>
    );
  }
  const reachouts = agent?.collaborationReachouts ?? [];
  const activities = agent?.lastActivities ?? [];
  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Runs" />
      {reachouts.length === 0 && activities.length === 0 ? <EmptyWorkspaceState icon={Activity} title="No runtime activity yet" detail="Runs and direct reachouts will appear here when this agent starts working." /> : (
        <div className="app-agent-studio-simple-list">
          {reachouts.map((reachout) => (
            <button key={reachout.sessionId} type="button" onClick={() => onOpenReachout?.(reachout.sessionId)} disabled={!onOpenReachout}>
              <Activity className="h-4 w-4" /><span><strong>{reachout.title}</strong><small>{reachout.preview || 'No messages yet'}</small></span><time>{reachout.updatedAtLabel ?? ''}</time>
            </button>
          ))}
          {activities.map((activity, index) => (
            <div key={`${activity}-${index}`}><Check className="h-4 w-4" /><span><strong>{activity}</strong></span><time>Recent</time></div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryView({ entries }: { entries: AgentEditHistoryEntry[] }) {
  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Change history" />
      {entries.length === 0 ? <EmptyWorkspaceState icon={History} title="No published changes yet" detail="Saved and published configuration edits will appear here." /> : (
        <div className="app-agent-studio-simple-list">
          {entries.map((entry, index) => (
            <div key={`${entry.path}-${entry.timestamp}-${index}`}><Clock3 className="h-4 w-4" /><span><strong>{entry.action}</strong><small>{entry.path}</small></span><time>{entry.timestamp}</time></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentStudioWorkspace({
  agent,
  creating,
  artifactKind,
  creationDraft,
  creationAccessScope,
  agentAccessScope,
  onCreationAccessScopeChange,
  config,
  persisted,
  changes,
  availableSkills,
  skillDescriptions,
  availableTools,
  availablePlugins,
  editableCapabilityKinds,
  allowCapabilityCreation,
  canEditPrompt,
  onPromptChange,
  onNameChange,
  onCreationDraftChange,
  creationAvatarUrl,
  onCreationAvatarUpload,
  onCreationAvatarRandomize,
  onCreationModelRoutingChange,
  onToggleCapability,
  onAddCapability,
  onRenameCapability,
  onPublish,
  onDiscard,
  publishing,
  publishFeedback,
  publishDisabled,
  draftMutationDisabled,
  chatModelOptions = [],
  composerProviderOptions = [],
  onUpdateModelRouting,
  onUpdateAgentAccess,
  activeDetail,
  activeFilePreview,
  activeFileDraft,
  activeFileCanEdit,
  activeFileIsEditing,
  activeFileSaveFeedback,
  onSelectPrompt,
  onSelectFile,
  onStartFileEditing,
  onCancelFileEditing,
  onSaveFile,
  onFileDraftChange,
  onOpenReachout,
  builderStatus,
  builderTesting,
  onTestBuilderDraft,
  onReadBuilderFile,
  onWriteBuilderFile,
}: {
  agent?: Agent;
  creating: boolean;
  artifactKind: FactoryArtifactKind;
  creationDraft: ShapeAgentDraft | null;
  creationAccessScope: CloudAgentAccessScope;
  agentAccessScope: CloudAgentAccessScope;
  onCreationAccessScopeChange: (scope: CloudAgentAccessScope) => void;
  config: AgentStudioConfigDraft | null;
  persisted: PersistedAgentConfig | null;
  changes: Array<{ key: 'prompt' | 'skills' | 'tools' | 'plugins' | 'definition' | 'access' | 'routing'; label: string; detail: string }>;
  availableSkills: string[];
  skillDescriptions: Readonly<Record<string, string>>;
  availableTools: string[];
  availablePlugins: string[];
  editableCapabilityKinds: ReadonlySet<AgentStudioCapabilityKind>;
  allowCapabilityCreation: boolean;
  canEditPrompt: boolean;
  onPromptChange: (value: string) => void;
  onNameChange?: (value: string) => void;
  onCreationDraftChange: (draft: ShapeAgentDraft) => void;
  creationAvatarUrl?: string | null;
  onCreationAvatarUpload?: (avatar: string) => void;
  onCreationAvatarRandomize?: () => void;
  onCreationModelRoutingChange?: (values: AgentModelRoutingDraft) => Promise<void> | void;
  onToggleCapability: (kind: AgentStudioCapabilityKind, name: string, selected: boolean) => void;
  onAddCapability: (kind: AgentStudioCapabilityKind, name: string) => void;
  onRenameCapability: (kind: AgentStudioCapabilityKind, previousName: string, nextName: string) => void;
  onPublish: () => void;
  onDiscard: () => void;
  publishing: boolean;
  publishFeedback: AgentSaveFeedback | null;
  publishDisabled: boolean;
  draftMutationDisabled: boolean;
  chatModelOptions?: ComposerModelOption[];
  composerProviderOptions?: ComposerProviderOption[];
  onUpdateModelRouting?: (
    agent: Agent,
    values: {
      defaultModel?: string | null;
      defaultAuthProvider?: string | null;
      defaultAuthChoice?: string | null;
      fallbackModel?: string | null;
      fallbackAuthProvider?: string | null;
      fallbackAuthChoice?: string | null;
      thinking?: string | null;
    },
  ) => Promise<void> | void;
  onUpdateAgentAccess?: (scope: CloudAgentAccessScope) => void;
  activeDetail: DetailTarget;
  activeFilePreview: FilePreviewState;
  activeFileDraft: string;
  activeFileCanEdit: boolean;
  activeFileIsEditing: boolean;
  activeFileSaveFeedback: AgentSaveFeedback | null;
  onSelectPrompt: () => void;
  onSelectFile: (path: string) => void;
  onStartFileEditing: () => void;
  onCancelFileEditing: () => void;
  onSaveFile: () => void;
  onFileDraftChange: (value: string) => void;
  onOpenReachout?: (sessionId: string) => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
  builderTesting?: boolean;
  onTestBuilderDraft?: () => void;
  onReadBuilderFile?: (path: string) => Promise<string>;
  onWriteBuilderFile?: (path: string, content: string) => Promise<unknown>;
}) {
  const standaloneBuild = creating && artifactKind !== 'agent';
  const [tab, setTab] = useState<AgentStudioTab>(standaloneBuild ? 'files' : 'blueprint');
  const [routingOpen, setRoutingOpen] = useState(false);
  const visibleTabIds = visibleAgentStudioTabIds(creating, artifactKind);
  const visibleTabs = TABS.filter(({ id }) => visibleTabIds.includes(id));
  const activeTab = visibleTabIds.includes(tab) ? tab : visibleTabIds[0] ?? 'blueprint';
  const accessScope = creating ? creationAccessScope : agentAccessScope;
  const setAccessScope = (scope: CloudAgentAccessScope) => {
    if (creating) onCreationAccessScopeChange(scope);
    else onUpdateAgentAccess?.(scope);
  };
  const routing: AgentModelRoutingDraft = creating ? {
    defaultModel: builderStatus?.draft?.model ?? null,
    defaultAuthProvider: builderStatus?.draft?.provider ?? null,
    thinking: builderStatus?.draft?.thinking ?? null,
  } : {
    defaultModel: agent?.defaultModel ?? null,
    defaultAuthProvider: agent?.defaultAuthProvider ?? null,
    defaultAuthChoice: agent?.defaultAuthChoice ?? null,
    fallbackModel: agent?.fallbackModel ?? null,
    fallbackAuthProvider: agent?.fallbackAuthProvider ?? null,
    fallbackAuthChoice: agent?.fallbackAuthChoice ?? null,
    thinking: agent?.defaultThinking ?? null,
  };
  const canEditRouting = chatModelOptions.length > 0 && Boolean(
    creating ? onCreationModelRoutingChange : agent?.isOwned && onUpdateModelRouting,
  );

  return (
    <section className="app-agent-studio-workspace" aria-label="Factory workspace">
      <nav className="app-agent-studio-tabs" aria-label="Factory workspace sections">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={cn(activeTab === id && 'is-active')} onClick={() => setTab(id)} aria-current={activeTab === id ? 'page' : undefined}><Icon className="h-3.5 w-3.5" />{label}</button>
        ))}
      </nav>
      <fieldset className="contents" disabled={draftMutationDisabled} aria-busy={draftMutationDisabled}>
      <div className="app-agent-studio-workspace-body">
        {activeTab === 'blueprint' ? (
          <AgentStudioBlueprintView
            agent={agent}
            creating={creating}
            creationDraft={creationDraft}
            config={config}
            changes={changes}
            accessScope={accessScope}
            onAccessScopeChange={setAccessScope}
            canEditPrompt={canEditPrompt}
            onPromptChange={onPromptChange}
            onNameChange={onNameChange}
            onCreationDraftChange={onCreationDraftChange}
            creationAvatarUrl={creationAvatarUrl}
            onCreationAvatarUpload={onCreationAvatarUpload}
            onCreationAvatarRandomize={onCreationAvatarRandomize}
            onOpenCapabilities={() => setTab('capabilities')}
            onOpenRouting={canEditRouting ? () => setRoutingOpen(true) : undefined}
            builderStatus={builderStatus}
          />
        ) : null}
        {activeTab === 'capabilities' ? (
          <CapabilitiesView
            creating={creating}
            config={config}
            creationDraft={creationDraft}
            availableSkills={availableSkills}
            skillDescriptions={skillDescriptions}
            availableTools={availableTools}
            availablePlugins={availablePlugins}
            editableKinds={editableCapabilityKinds}
            allowCapabilityCreation={allowCapabilityCreation}
            onToggle={onToggleCapability}
            onAdd={onAddCapability}
            onRename={onRenameCapability}
            builderStatus={builderStatus}
          />
        ) : null}
        {activeTab === 'files' ? (
          <FilesView
            agent={agent}
            creating={creating}
            creationDraft={creationDraft}
            activeDetail={activeDetail}
            config={config}
            activeFilePreview={activeFilePreview}
            activeFileDraft={activeFileDraft}
            activeFileCanEdit={activeFileCanEdit}
            activeFileIsEditing={activeFileIsEditing}
            fileFeedback={activeFileSaveFeedback}
            canEditPrompt={canEditPrompt}
            onSelectPrompt={onSelectPrompt}
            onSelectFile={onSelectFile}
            onPromptChange={onPromptChange}
            onCreationDraftChange={onCreationDraftChange}
            onStartFileEditing={onStartFileEditing}
            onCancelFileEditing={onCancelFileEditing}
            onSaveFile={onSaveFile}
            onFileDraftChange={onFileDraftChange}
            builderStatus={builderStatus}
            onReadBuilderFile={onReadBuilderFile}
            onWriteBuilderFile={onWriteBuilderFile}
          />
        ) : null}
        {activeTab === 'runs' ? <RunsView agent={agent} onOpenReachout={onOpenReachout} builderStatus={builderStatus} builderTesting={builderTesting} onTestBuilderDraft={onTestBuilderDraft} /> : null}
        {activeTab === 'history' ? <HistoryView entries={persisted?.editHistory ?? []} /> : null}
        {publishFeedback?.text ? <div className={cn('app-agent-studio-toast', publishFeedback.tone === 'error' && 'is-error', publishFeedback.tone === 'success' && 'is-success')}>{publishFeedback.text}</div> : null}
        {routingOpen && canEditRouting ? (
          <AgentStudioRoutingEditor
            routing={routing}
            modelOptions={chatModelOptions}
            providerOptions={composerProviderOptions}
            onSave={(values) => {
              if (creating) return onCreationModelRoutingChange?.(values);
              if (agent) return onUpdateModelRouting?.(agent, values);
              return undefined;
            }}
            onClose={() => setRoutingOpen(false)}
          />
        ) : null}
      </div>
      </fieldset>
      {builderStatus?.lifecycle !== 'published' && (changes.length > 0 || creating && creationDraft) ? (
        <div className="app-agent-studio-workspace-footer">
          <span>{standaloneBuild ? `${artifactKind[0]?.toUpperCase()}${artifactKind.slice(1)} draft` : creating ? 'New agent build' : `${changes.length} unpublished change${changes.length === 1 ? '' : 's'}`}</span>
          <div className="flex gap-2"><button type="button" className="app-button-quiet app-agent-studio-button is-ghost is-small" onClick={onDiscard} disabled={publishing || draftMutationDisabled}>Discard</button><button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={onPublish} disabled={publishDisabled || publishing}>{builderTesting ? 'Testing…' : publishing ? 'Publishing…' : artifactKind === 'skill' ? 'Publish skill' : artifactKind === 'tool' ? 'Publish tool' : artifactKind === 'plugin' ? 'Publish plugin' : creating ? 'Publish agent' : 'Publish'}</button></div>
        </div>
      ) : null}
    </section>
  );
}
