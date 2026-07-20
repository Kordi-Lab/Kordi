import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Check,
  Clock3,
  FileCode2,
  FileText,
  FolderOpen,
  History,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  Search,
  Settings2,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DesktopAgentBuilderStatus } from '@/lib/desktop';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import type { ComposerModelOption, ComposerProviderOption } from '../components';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import { cloudAgentAccessDescription, cloudAgentAccessLabel, type AgentEditHistoryEntry, type AgentSaveFeedback, type AgentStudioCapabilityKind, type AgentStudioConfigDraft, type FactoryArtifactKind, type PersistedAgentConfig } from './model';
import type { ShapeAgentDraft } from './shapeAgentDraft';
import { AgentStudioRoutingEditor } from './AgentStudioRoutingEditor';

export type AgentStudioTab = 'blueprint' | 'capabilities' | 'files' | 'runs' | 'history';

type FilePreviewState = { status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string };
type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

const TABS: Array<{ id: AgentStudioTab; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'blueprint', label: 'Blueprint', icon: SlidersHorizontal },
  { id: 'capabilities', label: 'Capabilities', icon: Puzzle },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'history', label: 'History', icon: History },
];

function shortPrompt(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No prompt is exposed for this agent.';
  return normalized.length > 92 ? `${normalized.slice(0, 91).trimEnd()}…` : normalized;
}

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
      <Icon className="h-6 w-6" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function WorkspaceHeading({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="app-agent-studio-view-head">
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      {action}
    </div>
  );
}

function BlueprintRow({ icon: Icon, label, value, detail, onEdit }: {
  icon: typeof Bot;
  label: string;
  value: string;
  detail?: string;
  onEdit?: () => void;
}) {
  return (
    <div className="app-agent-studio-blueprint-row">
      <div className="app-agent-studio-blueprint-label"><Icon className="h-4 w-4" />{label}</div>
      <div className="min-w-0">
        <div className="app-agent-studio-blueprint-value">{value}</div>
        {detail ? <div className="app-agent-studio-blueprint-detail">{detail}</div> : null}
      </div>
      {onEdit ? <button type="button" className="app-agent-studio-icon-button" aria-label={`Edit ${label.toLowerCase()}`} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></button> : <span />}
    </div>
  );
}

function PromptEditor({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <section className="app-agent-studio-popover is-wide" role="dialog" aria-label="Edit system prompt">
      <div className="app-agent-studio-popover-head">
        <div><strong>System prompt</strong><p>Changes stay in the draft until you publish them.</p></div>
        <button type="button" className="app-agent-studio-icon-button" onClick={onClose} aria-label="Close system prompt editor"><X className="h-4 w-4" /></button>
      </div>
      <label className="app-agent-studio-field">
        <span>Instructions</span>
        <textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} spellCheck={false} />
      </label>
      <div className="app-agent-studio-popover-actions">
        <button type="button" className="app-agent-studio-button is-primary is-small" onClick={() => { onChange(draft); onClose(); }}>Keep in draft</button>
      </div>
    </section>
  );
}

function BlueprintView({
  agent,
  creating,
  creationDraft,
  config,
  changes,
  accessScope,
  onAccessScopeChange,
  canEditPrompt,
  onPromptChange,
  onCreationDraftChange,
  onOpenCapabilities,
  onOpenRouting,
  onPublish,
  publishing,
  publishDisabled,
  builderStatus,
}: {
  agent?: Agent;
  creating: boolean;
  creationDraft: ShapeAgentDraft | null;
  config: AgentStudioConfigDraft | null;
  changes: Array<{ key: string; label: string; detail: string }>;
  accessScope: CloudAgentAccessScope;
  onAccessScopeChange: (scope: CloudAgentAccessScope) => void;
  canEditPrompt: boolean;
  onPromptChange: (value: string) => void;
  onCreationDraftChange: (draft: ShapeAgentDraft) => void;
  onOpenCapabilities: () => void;
  onOpenRouting?: () => void;
  onPublish: () => void;
  publishing: boolean;
  publishDisabled: boolean;
  builderStatus?: DesktopAgentBuilderStatus | null;
}) {
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const name = creating ? creationDraft?.name ?? 'New build' : agent?.name ?? 'Build unavailable';
  const role = creating ? creationDraft?.role ?? 'Describe what Kordi Factory should build' : agent?.role ?? '';
  const prompt = creating ? creationDraft?.systemPrompt ?? '' : config?.systemPrompt ?? '';
  const skills = creating ? creationDraft?.skills.map((skill) => skill.name) ?? [] : config?.loadedSkills ?? [];
  const tools = creating ? builderStatus?.draft?.tools ?? [] : config?.loadedTools ?? [];
  const totalChanges = creating ? (creationDraft ? 1 : 0) : changes.length;
  const runtimeStatus = creating ? 'Draft' : agent?.status ?? 'Unavailable';

  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Build blueprint" detail="Review the current build. Factory chat and manual controls update the same private draft." />
      <div className="app-agent-studio-blueprint-layout">
        <section className="app-agent-studio-blueprint">
          <div className="app-agent-studio-blueprint-core">
            <div className="flex min-w-0 items-center gap-3">
              <IdentityAvatar
                kind="agent"
                seed={agent?.avatarSeed ?? agent?.id ?? name}
                name={name}
                imageUrl={agent?.profileImageUrl}
                className="h-10 w-10 rounded-[13px]"
              />
              <div className="min-w-0">
                <div className="app-agent-studio-core-name">{name}</div>
                <div className="app-agent-studio-core-role">{role}</div>
              </div>
            </div>
            <span className={cn('app-agent-studio-runtime-state', creating && 'is-draft')}>{runtimeStatus}</span>
          </div>
          <BlueprintRow
            icon={FileCode2}
            label="Prompt"
            value={prompt ? 'Configured' : 'Not configured'}
            detail={shortPrompt(prompt)}
            onEdit={canEditPrompt && (creationDraft || !creating) ? () => setPromptEditorOpen(true) : undefined}
          />
          <BlueprintRow
            icon={Settings2}
            label="Model"
            value={creating ? builderStatus?.draft?.model || 'Uses authenticated runtime default' : agent?.defaultModel || 'No default model'}
            detail={creating ? builderStatus?.draft?.provider || 'Kordi Factory uses your active authenticated route' : [agent?.defaultAuthProvider, agent?.fallbackModel ? `fallback ${agent.fallbackModel}` : null].filter(Boolean).join(' · ') || 'Runtime default'}
            onEdit={!creating && agent?.isOwned && onOpenRouting ? onOpenRouting : undefined}
          />
          <BlueprintRow icon={Puzzle} label="Skills" value={`${skills.length} loaded`} detail={skills.join(', ') || 'No skills selected'} onEdit={onOpenCapabilities} />
          <BlueprintRow icon={Wrench} label="Tools" value={`${tools.length} selected`} detail={tools.join(', ') || 'No tools selected'} onEdit={onOpenCapabilities} />
          <div className="app-agent-studio-blueprint-row">
            <div className="app-agent-studio-blueprint-label"><LockKeyhole className="h-4 w-4" />Access</div>
            <div className="min-w-0">
              {creating || agent?.cloudAgentId ? (
                <select
                  className="app-agent-studio-inline-select"
                  value={accessScope}
                  onChange={(event) => onAccessScopeChange(event.currentTarget.value === 'participant_conversations' ? 'participant_conversations' : 'private')}
                >
                  <option value="private">{cloudAgentAccessLabel('private')}</option>
                  <option value="participant_conversations">{cloudAgentAccessLabel('participant_conversations')}</option>
                </select>
              ) : <div className="app-agent-studio-blueprint-value">Local runtime</div>}
              <div className="app-agent-studio-blueprint-detail">
                {creating || agent?.cloudAgentId ? cloudAgentAccessDescription(accessScope) : 'Access follows the connected Bridge runtime.'}
              </div>
            </div>
            <span />
          </div>
          {totalChanges > 0 ? (
            <div className="app-agent-studio-draft-summary">
              <div>
                <strong>{creating ? 'Build ready to review' : `${totalChanges} change${totalChanges === 1 ? '' : 's'} ready to review`}</strong>
                <span>{builderStatus?.publishReady ? 'Validation and runtime test passed. Nothing is live until you publish.' : builderStatus?.validation.valid ? 'Run the current draft in the Runs tab before publishing.' : builderStatus?.validation.errors[0] ?? 'Nothing is live until you publish.'}</span>
              </div>
              <button type="button" className="app-agent-studio-button is-primary is-small" onClick={onPublish} disabled={publishDisabled || publishing}>
                {publishing ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Publishing</> : creating ? 'Create agent' : 'Publish changes'}
              </button>
            </div>
          ) : null}
          {!creating && changes.length > 0 ? (
            <div className="app-agent-studio-change-list">
              {changes.map((change) => (
                <div key={`${change.key}:${change.label}`} className="app-agent-studio-change-row"><Check className="h-3.5 w-3.5" /><span>{change.label}</span><code>{change.detail}</code></div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
      {promptEditorOpen ? (
        <PromptEditor
          value={prompt}
          onChange={(value) => {
            if (creating && creationDraft) onCreationDraftChange({ ...creationDraft, systemPrompt: value });
            else onPromptChange(value);
          }}
          onClose={() => setPromptEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}

type CapabilityItem = {
  kind: AgentStudioCapabilityKind;
  name: string;
  loaded: boolean;
  published: boolean;
};

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
        <div><strong>{mode === 'add' ? 'Add capability' : 'Edit capability'}</strong><p>{mode === 'add' ? 'Add a real capability reference to the reviewable draft.' : 'Rename this capability reference in the draft.'}</p></div>
        <button type="button" className="app-agent-studio-icon-button" onClick={onClose} aria-label="Close capability editor"><X className="h-4 w-4" /></button>
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
                <option key={option} value={option} disabled={!editableKinds.has(option)}>{option[0]?.toUpperCase()}{option.slice(1)}{editableKinds.has(option) ? '' : ' · runtime managed'}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <label className="app-agent-studio-field">
        <span>{source === 'catalog' ? 'Capability name' : source === 'path' ? 'Local path' : 'Repository URL or package'}</span>
        <input value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder={source === 'catalog' ? 'navigate-knowledge' : source === 'path' ? './skills/review' : 'github:team/review-skill'} />
      </label>
      <div className="app-agent-studio-field-help">Kordi stores the normalized capability reference in this agent draft. Runtime-managed types cannot be changed here.</div>
      <div className="app-agent-studio-popover-actions">
        <button type="button" className="app-agent-studio-button is-ghost is-small" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="app-agent-studio-button is-primary is-small"
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

function CapabilitiesView({
  agent,
  creating,
  config,
  creationDraft,
  persisted,
  availableSkills,
  availableTools,
  availablePlugins,
  editableKinds,
  allowCapabilityCreation,
  onToggle,
  onAdd,
  onRename,
  builderStatus,
}: {
  agent?: Agent;
  creating: boolean;
  config: AgentStudioConfigDraft | null;
  creationDraft: ShapeAgentDraft | null;
  persisted: PersistedAgentConfig | null;
  availableSkills: string[];
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
  const publishedConfig = persisted ?? { ...draftConfig, loadedSkills: [], loadedTools: [], loadedPlugins: [], editHistory: [] };
  const sources: Record<AgentStudioCapabilityKind, string[]> = {
    skill: Array.from(new Set([...availableSkills, ...draftConfig.loadedSkills])),
    tool: Array.from(new Set([...availableTools, ...draftConfig.loadedTools])),
    plugin: Array.from(new Set([...availablePlugins, ...draftConfig.loadedPlugins])),
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = (Object.keys(sources) as AgentStudioCapabilityKind[])
    .flatMap((kind) => sources[kind].map((name): CapabilityItem => ({
      kind,
      name,
      loaded: draftConfig[capabilityField(kind)].includes(name),
      published: publishedConfig[capabilityField(kind)].includes(name),
    })))
    .filter((item) => filter === 'all' || item.kind === filter)
    .filter((item) => !loadedOnly || item.loaded)
    .filter((item) => !normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.name.localeCompare(right.name));

  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading
        title="Capabilities"
        detail="Review real skill contents and selected tool or plugin references. Changes stay in the draft; runtime-managed capabilities remain read only."
        action={allowCapabilityCreation ? <button type="button" className="app-agent-studio-button is-primary is-small" disabled={editableKinds.size === 0 || (creating && !creationDraft)} onClick={() => setEditor({ mode: 'add' })}><Plus className="h-3.5 w-3.5" />Add capability</button> : undefined}
      />
      <div className="app-agent-studio-capability-toolbar">
        <label className="app-agent-studio-search"><Search className="h-4 w-4" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search capabilities" /></label>
        <div className="app-agent-studio-segmented" role="group" aria-label="Capability type">
          {(['all', 'skill', 'tool', 'plugin'] as const).map((value) => <button key={value} type="button" className={cn(filter === value && 'is-active')} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : `${value[0]?.toUpperCase()}${value.slice(1)}s`}</button>)}
        </div>
        <button type="button" className={cn('app-agent-studio-button is-small', loadedOnly && 'is-selected')} onClick={() => setLoadedOnly((current) => !current)}>Loaded only</button>
      </div>
      <div className="app-agent-studio-capability-list">
        {items.map((item) => {
          const Icon = capabilityIcon(item.kind);
          const editable = editableKinds.has(item.kind);
          const sourceLabel = creating
            ? 'New Factory build'
            : agent?.cloudAgentId
              ? 'Cloud Agent metadata'
              : item.kind === 'skill' ? 'Runtime skill discovery' : item.kind === 'tool' ? 'Runtime tool registry' : 'Runtime extension bootstrap';
          return (
            <div key={`${item.kind}:${item.name}`} className="app-agent-studio-capability-row">
              <span className={cn('app-agent-studio-capability-icon', `is-${item.kind}`)}><Icon className="h-4 w-4" /></span>
              <div className="min-w-0">
                <div className="app-agent-studio-capability-name"><strong>{item.name}</strong><code>{item.kind}</code></div>
                <div className="app-agent-studio-capability-description">
                  {item.loaded ? 'Included in the current reviewable draft.' : 'Visible in another runtime or the published configuration.'}
                </div>
                <div className="app-agent-studio-capability-meta"><span>{sourceLabel}</span><span>{item.published ? 'Published' : item.loaded ? 'Draft only' : 'Available'}</span>{!editable ? <span>Runtime managed</span> : null}</div>
              </div>
              <div className="app-agent-studio-capability-actions">
                {editable && allowCapabilityCreation && item.loaded ? <button type="button" className="app-agent-studio-icon-button" aria-label={`Edit ${item.name}`} onClick={() => setEditor({ mode: 'edit', capability: item })}><Pencil className="h-3.5 w-3.5" /></button> : null}
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.loaded}
                  aria-label={`${item.loaded ? 'Unload' : 'Load'} ${item.name}`}
                  className={cn('app-agent-studio-switch', item.loaded && 'is-on')}
                  disabled={!editable}
                  title={editable ? `${item.loaded ? 'Remove from' : 'Add to'} draft` : 'This capability is managed by the active runtime'}
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
          onAdd={onAdd}
          onRename={onRename}
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
      <WorkspaceHeading title="Build files" detail="Preview and edit supported workspace files without leaving Kordi Factory." />
      {!creating && !agent ? <EmptyWorkspaceState icon={FileText} title="No agent selected" detail="Select an agent to inspect its files." /> : (
        <div className="app-agent-studio-files-layout">
          <div className="app-agent-studio-file-list">
            <button type="button" className={cn(isPrompt && 'is-active')} onClick={onSelectPrompt}>
              <FileCode2 className="h-4 w-4" /><span><strong>System prompt</strong><small>{canEditPrompt ? 'Editable draft' : 'Runtime managed'}</small></span>
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
                activeFileIsEditing ? <div className="flex gap-2"><button type="button" className="app-agent-studio-button is-ghost is-small" onClick={onCancelFileEditing}>Discard</button><button type="button" className="app-agent-studio-button is-primary is-small" onClick={onSaveFile}>Save file</button></div>
                  : <button type="button" className="app-agent-studio-button is-small" onClick={onStartFileEditing} disabled={activeFilePreview.status === 'loading'}>Edit file</button>
              ) : null}
            </div>
            {fileFeedback && !isPrompt ? <div className={cn('app-agent-studio-file-feedback', fileFeedback.tone === 'error' && 'is-error')}>{fileFeedback.text}</div> : null}
            {isPrompt ? (
              canEditPrompt ? <textarea value={prompt} onChange={(event) => {
                if (creating && creationDraft) onCreationDraftChange({ ...creationDraft, systemPrompt: event.currentTarget.value });
                else onPromptChange(event.currentTarget.value);
              }} spellCheck={false} /> : <pre>{prompt || 'No real prompt payload is exposed for this identity.'}</pre>
            ) : activeFileIsEditing ? <textarea value={activeFileDraft} onChange={(event) => onFileDraftChange(event.currentTarget.value)} spellCheck={false} />
              : <pre>{activeFilePreview.status === 'loading' ? 'Loading real file…' : activeFileDraft || 'No file preview is available.'}</pre>}
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
      <WorkspaceHeading title="Draft files" detail="These are the real files used by Kordi Factory, validation, testing, and publishing." />
      <div className="app-agent-studio-files-layout">
        <div className="app-agent-studio-file-list">
          {files.map((file) => (
            <button key={file.path} type="button" className={cn(selectedPath === file.path && 'is-active')} onClick={() => setSelectedPath(file.path)}>
              {file.kind === 'skill' ? <Puzzle className="h-4 w-4" /> : file.kind === 'prompt' ? <FileCode2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
              <span><strong>{file.path.split('/').pop()}</strong><small>{file.path}</small></span>
              <span className={cn('app-agent-studio-file-validity', !file.valid && 'is-error')}>{file.valid ? 'Valid' : 'Fix'}</span>
            </button>
          ))}
        </div>
        <section className="app-agent-studio-file-editor">
          <div className="app-agent-studio-file-toolbar">
            <div className="min-w-0"><strong>{selectedPath.split('/').pop()}</strong><span>{selectedPath}</span></div>
            <button type="button" className="app-agent-studio-button is-primary is-small" onClick={() => void save()} disabled={loading || saving || content === savedContent}>
              {saving ? 'Saving…' : 'Save file'}
            </button>
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
          detail="Publishing stays locked until the current files pass validation and a real runtime smoke test."
          action={<button type="button" className="app-agent-studio-button is-primary is-small" disabled={!builderStatus.validation.valid || builderTesting} onClick={onTestBuilderDraft}>{builderTesting ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Testing…</> : 'Test draft'}</button>}
        />
        <div className="app-agent-studio-run-checks">
          <section className={cn('app-agent-studio-run-check', builderStatus.validation.valid ? 'is-success' : 'is-error')}>
            <span>{builderStatus.validation.valid ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}</span>
            <div><strong>{builderStatus.validation.valid ? 'Files are valid' : 'Draft needs attention'}</strong><p>{builderStatus.validation.valid ? `${builderStatus.validation.files.length} draft files passed structural validation.` : builderStatus.validation.errors.join(' ')}</p></div>
          </section>
          <section className={cn('app-agent-studio-run-check', reportIsCurrent && builderStatus.testReport?.passed ? 'is-success' : builderStatus.testReport && reportIsCurrent ? 'is-error' : '')}>
            <span>{builderTesting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : reportIsCurrent && builderStatus.testReport?.passed ? <Check className="h-4 w-4" /> : <Activity className="h-4 w-4" />}</span>
            <div><strong>{builderTesting ? 'Testing the candidate runtime' : reportIsCurrent ? builderStatus.testReport?.passed ? 'Runtime test passed' : 'Runtime test failed' : 'Runtime test required'}</strong><p>{builderTesting ? 'Kordi is starting a disposable session with the candidate prompt and skills.' : reportIsCurrent ? builderStatus.testReport?.summary : 'Run a new test after every file change.'}</p></div>
          </section>
        </div>
      </div>
    );
  }
  const reachouts = agent?.bridgeReachouts ?? [];
  const activities = agent?.lastActivities ?? [];
  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Runs" detail="See real direct reachouts and runtime activity without mixing execution events into configuration." />
      {reachouts.length === 0 && activities.length === 0 ? <EmptyWorkspaceState icon={Activity} title="No runtime activity yet" detail="Runs and direct reachouts will appear here when this agent starts working." /> : (
        <div className="app-agent-studio-simple-list">
          {reachouts.map((reachout) => (
            <button key={reachout.sessionId} type="button" onClick={() => onOpenReachout?.(reachout.sessionId)} disabled={!onOpenReachout}>
              <Activity className="h-4 w-4" /><span><strong>{reachout.title}</strong><small>{reachout.preview || 'No messages yet'}</small></span><time>{reachout.updatedAtLabel ?? ''}</time>
            </button>
          ))}
          {activities.map((activity, index) => (
            <div key={`${activity}-${index}`}><Check className="h-4 w-4" /><span><strong>{activity}</strong><small>Reported by the current runtime</small></span><time>Recent</time></div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryView({ entries }: { entries: AgentEditHistoryEntry[] }) {
  return (
    <div className="app-agent-studio-view-scroll">
      <WorkspaceHeading title="Change history" detail="Review saved file changes and conversational proposals using their real local history." />
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
  availableTools,
  availablePlugins,
  editableCapabilityKinds,
  allowCapabilityCreation,
  canEditPrompt,
  onPromptChange,
  onCreationDraftChange,
  onToggleCapability,
  onAddCapability,
  onRenameCapability,
  onPublish,
  onDiscard,
  publishing,
  publishFeedback,
  publishDisabled,
  chatModelOptions = [],
  composerProviderOptions = [],
  onUpdateModelRouting,
  onUpdateCloudAccess,
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
  availableTools: string[];
  availablePlugins: string[];
  editableCapabilityKinds: ReadonlySet<AgentStudioCapabilityKind>;
  allowCapabilityCreation: boolean;
  canEditPrompt: boolean;
  onPromptChange: (value: string) => void;
  onCreationDraftChange: (draft: ShapeAgentDraft) => void;
  onToggleCapability: (kind: AgentStudioCapabilityKind, name: string, selected: boolean) => void;
  onAddCapability: (kind: AgentStudioCapabilityKind, name: string) => void;
  onRenameCapability: (kind: AgentStudioCapabilityKind, previousName: string, nextName: string) => void;
  onPublish: () => void;
  onDiscard: () => void;
  publishing: boolean;
  publishFeedback: AgentSaveFeedback | null;
  publishDisabled: boolean;
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
  onUpdateCloudAccess?: (scope: CloudAgentAccessScope) => void;
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
  const skillBuild = creating && artifactKind === 'skill';
  const [tab, setTab] = useState<AgentStudioTab>(skillBuild ? 'files' : 'blueprint');
  const [routingOpen, setRoutingOpen] = useState(false);
  const visibleTabs = skillBuild
    ? TABS.filter(({ id }) => id === 'files' || id === 'runs' || id === 'history')
    : TABS;
  const accessScope = creating ? creationAccessScope : agentAccessScope;
  const setAccessScope = (scope: CloudAgentAccessScope) => {
    if (creating) onCreationAccessScopeChange(scope);
    else onUpdateCloudAccess?.(scope);
  };

  return (
    <section className="app-agent-studio-workspace" aria-label="Factory workspace">
      <nav className="app-agent-studio-tabs" aria-label="Factory workspace sections">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={cn(tab === id && 'is-active')} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon className="h-3.5 w-3.5" />{label}</button>
        ))}
      </nav>
      <div className="app-agent-studio-workspace-body">
        {tab === 'blueprint' ? (
          <BlueprintView
            agent={agent}
            creating={creating}
            creationDraft={creationDraft}
            config={config}
            changes={changes}
            accessScope={accessScope}
            onAccessScopeChange={setAccessScope}
            canEditPrompt={canEditPrompt}
            onPromptChange={onPromptChange}
            onCreationDraftChange={onCreationDraftChange}
            onOpenCapabilities={() => setTab('capabilities')}
            onOpenRouting={onUpdateModelRouting && chatModelOptions.length > 0 ? () => setRoutingOpen(true) : undefined}
            onPublish={onPublish}
            publishing={publishing}
            publishDisabled={publishDisabled}
            builderStatus={builderStatus}
          />
        ) : null}
        {tab === 'capabilities' ? (
          <CapabilitiesView
            agent={agent}
            creating={creating}
            config={config}
            creationDraft={creationDraft}
            persisted={persisted}
            availableSkills={availableSkills}
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
        {tab === 'files' ? (
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
        {tab === 'runs' ? <RunsView agent={agent} onOpenReachout={onOpenReachout} builderStatus={builderStatus} builderTesting={builderTesting} onTestBuilderDraft={onTestBuilderDraft} /> : null}
        {tab === 'history' ? <HistoryView entries={persisted?.editHistory ?? []} /> : null}
        {publishFeedback?.text ? <div className={cn('app-agent-studio-toast', publishFeedback.tone === 'error' && 'is-error', publishFeedback.tone === 'success' && 'is-success')}>{publishFeedback.text}</div> : null}
        {routingOpen && agent && onUpdateModelRouting ? (
          <AgentStudioRoutingEditor
            agent={agent}
            modelOptions={chatModelOptions}
            providerOptions={composerProviderOptions}
            onSave={onUpdateModelRouting}
            onClose={() => setRoutingOpen(false)}
          />
        ) : null}
      </div>
      {(changes.length > 0 || creating && creationDraft) ? (
        <div className="app-agent-studio-workspace-footer">
          <span>{skillBuild ? 'New skill build' : creating ? 'New Factory build' : `${changes.length} unpublished change${changes.length === 1 ? '' : 's'}`}</span>
          <div className="flex gap-2"><button type="button" className="app-agent-studio-button is-ghost is-small" onClick={onDiscard} disabled={publishing}>Discard</button><button type="button" className="app-agent-studio-button is-primary is-small" onClick={onPublish} disabled={publishDisabled || publishing}>{publishing ? (skillBuild ? 'Installing…' : 'Publishing…') : skillBuild ? 'Install skill' : creating ? 'Create agent' : 'Publish'}</button></div>
        </div>
      ) : null}
    </section>
  );
}
