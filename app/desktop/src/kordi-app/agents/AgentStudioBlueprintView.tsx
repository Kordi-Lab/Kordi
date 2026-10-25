import { useRef, useState, type ReactNode } from 'react';
import { Bot, Check, FileCode2, LockKeyhole, Pencil, Puzzle, Radar, Settings2, Wrench, X } from 'lucide-react';
import type { CloudAgentAccessScope } from '@/features/cloud/cloudAgentsClient';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import type { DesktopAgentBuilderStatus } from '@/lib/desktop';
import { CloudSignupAvatarPicker } from '../cloud/CloudSignupAvatarPicker';
import type { Agent } from '../types';
import { cloudAgentAccessDescription, cloudAgentAccessLabel, cloudAgentProactiveDescription, cloudAgentProactiveLabel, type AgentStudioConfigDraft } from './model';
import { BlueprintMenuRow } from './BlueprintMenuRow';
import type { ShapeAgentDraft } from './shapeAgentDraft';
import { factoryAvatarSeed } from './useFactoryCreationAvatar';

const noopAvatarAction = () => undefined;

/** The Proactive row's value, how a change reaches the draft, and (for the default agent) where the Runs tab loads activity. */
export type AgentProactiveControl = { enabled: boolean; onChange?: (enabled: boolean) => void; activity?: { agentId: string; enabled: boolean } };

const ACCESS_OPTIONS = (['private', 'participant_conversations'] as const).map((scope) => ({ value: scope, label: cloudAgentAccessLabel(scope) }));
const PROACTIVE_OPTIONS = (['off', 'on'] as const).map((value) => ({ value, label: cloudAgentProactiveLabel(value === 'on'), description: cloudAgentProactiveDescription(value === 'on') }));

function BlueprintRow({ icon: Icon, label, value, detail, onEdit }: {
  icon: typeof Bot;
  label: string;
  value: ReactNode;
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
      {onEdit ? <button type="button" className="app-button-quiet app-agent-studio-icon-button is-inline-edit" aria-label={`Edit ${label.toLowerCase()}`} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></button> : <span />}
    </div>
  );
}

function PromptEditor({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <section className="app-agent-studio-popover is-wide" role="dialog" aria-label="Edit system prompt">
      <div className="app-agent-studio-popover-head">
        <div><strong>System prompt</strong><p>Changes stay in the draft until you publish them.</p></div>
        <button type="button" className="app-button-quiet app-agent-studio-icon-button" onClick={onClose} aria-label="Close system prompt editor"><X className="h-4 w-4" /></button>
      </div>
      <label className="app-agent-studio-field">
        <span>Instructions</span>
        <textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} spellCheck={false} />
      </label>
      <div className="app-agent-studio-popover-actions">
        <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={() => { onChange(draft); onClose(); }}>Keep in draft</button>
      </div>
    </section>
  );
}

function NameEditor({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <form className="app-agent-studio-popover" role="dialog" aria-label="Edit agent name" onSubmit={(event) => {
      event.preventDefault();
      const name = inputRef.current?.value.trim() ?? '';
      if (!name) return;
      onChange(name);
      onClose();
    }}>
      <div className="app-agent-studio-popover-head">
        <div><strong>Agent name</strong><p>This is the name people see in chats, mentions, and replies.</p></div>
        <button type="button" className="app-button-quiet app-agent-studio-icon-button" onClick={onClose} aria-label="Close agent name editor"><X className="h-4 w-4" /></button>
      </div>
      <label className="app-agent-studio-field">
        <span>Name</span>
        <input ref={inputRef} maxLength={120} defaultValue={value} placeholder="Kordi" required />
      </label>
      <div className="app-agent-studio-popover-actions">
        <button type="submit" className="app-button-quiet app-agent-studio-button is-primary is-small">Keep in draft</button>
      </div>
    </form>
  );
}

export function AgentStudioBlueprintView({
  agent,
  creating,
  creationDraft,
  config,
  changes,
  accessScope,
  onAccessScopeChange,
  proactive,
  canEditPrompt,
  onPromptChange,
  onNameChange,
  onCreationDraftChange,
  creationAvatarUrl,
  onCreationAvatarUpload,
  onCreationAvatarRandomize,
  onOpenCapabilities,
  onOpenRouting,
  builderStatus,
}: {
  agent?: Agent;
  creating: boolean;
  creationDraft: ShapeAgentDraft | null;
  config: AgentStudioConfigDraft | null;
  changes: Array<{ key: string; label: string; detail: string }>;
  accessScope: CloudAgentAccessScope;
  onAccessScopeChange: (scope: CloudAgentAccessScope) => void;
  proactive?: AgentProactiveControl;
  canEditPrompt: boolean;
  onPromptChange: (value: string) => void;
  onNameChange?: (value: string) => void;
  onCreationDraftChange: (draft: ShapeAgentDraft) => void;
  creationAvatarUrl?: string | null;
  onCreationAvatarUpload?: (avatar: string) => void;
  onCreationAvatarRandomize?: (seed?: string) => void;
  onOpenCapabilities: () => void;
  onOpenRouting?: () => void;
  builderStatus?: DesktopAgentBuilderStatus | null;
}) {
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const prompt = creating ? creationDraft?.systemPrompt ?? '' : config?.systemPrompt ?? '';
  const name = creating ? creationDraft?.name ?? '' : builderStatus?.draft?.name ?? agent?.name ?? '';
  const canEditName = Boolean(onNameChange && (
    (creating && creationDraft)
    || (builderStatus?.draft && agent && (agent.cloudAgentId || usesDefaultLocalAgentSession(agent)))
  ));
  const canEditAvatar = Boolean(
    onCreationAvatarUpload
    && onCreationAvatarRandomize
    && (
      (creating && creationDraft)
      || (builderStatus?.draft && agent && (agent.cloudAgentId || usesDefaultLocalAgentSession(agent)))
    ),
  );
  const skills = creating ? creationDraft?.skills.map((skill) => skill.name) ?? [] : config?.loadedSkills ?? [];
  const tools = creating ? builderStatus?.draft?.tools ?? [] : config?.loadedTools ?? [];
  const totalChanges = creating ? (creationDraft ? 1 : 0) : changes.length;

  const shortPrompt = prompt.replace(/\s+/g, ' ').trim();
  return (
    <div className="app-agent-studio-view-scroll is-blueprint-view">
      <section className="app-agent-studio-blueprint" aria-label="Agent configuration">
        <BlueprintRow
          icon={Bot}
          label="Name"
          value={name || 'Unnamed agent'}
          detail="Shown in chats, mentions, and replies."
          onEdit={canEditName ? () => setNameEditorOpen(true) : undefined}
        />
        {canEditAvatar ? (
          <BlueprintRow
            icon={Bot}
            label="Avatar"
            value={<CloudSignupAvatarPicker imageUrl={creationAvatarUrl ?? ''} onUpload={onCreationAvatarUpload ?? noopAvatarAction} onRegenerate={onCreationAvatarRandomize ?? noopAvatarAction} onPick={onCreationAvatarRandomize} currentSeed={factoryAvatarSeed(creationAvatarUrl, agent?.avatarSeed ?? agent?.id)} uploadLabel="Upload agent avatar" />}
          />
        ) : null}
        <BlueprintRow
          icon={FileCode2}
          label="Prompt"
          value={prompt ? 'Configured' : 'Not configured'}
          detail={!shortPrompt ? 'No prompt configured.' : shortPrompt.length > 92 ? `${shortPrompt.slice(0, 91).trimEnd()}…` : shortPrompt}
          onEdit={canEditPrompt && (creationDraft || !creating) ? () => setPromptEditorOpen(true) : undefined}
        />
        <BlueprintRow
          icon={Settings2}
          label="Model"
          value={creating ? builderStatus?.draft?.model || 'Uses authenticated runtime default' : agent?.defaultModel || 'No default model'}
          detail={creating ? builderStatus?.draft?.provider || 'Kordi Factory uses your active authenticated route' : [agent?.defaultAuthProvider, agent?.fallbackModel ? `fallback ${agent.fallbackModel}` : null].filter(Boolean).join(' · ') || 'Runtime default'}
          onEdit={onOpenRouting}
        />
        <BlueprintRow icon={Puzzle} label="Skills" value={`${skills.length} loaded`} detail={skills.join(', ') || 'No skills selected'} onEdit={onOpenCapabilities} />
        <BlueprintRow icon={Wrench} label="Tools" value={`${tools.length} selected`} detail={tools.join(', ') || 'No tools selected'} onEdit={onOpenCapabilities} />
        <BlueprintMenuRow icon={LockKeyhole} label="Access" menuLabel="Agent access" value={accessScope} detail={cloudAgentAccessDescription(accessScope)} options={ACCESS_OPTIONS} onSelect={creating || agent ? onAccessScopeChange : undefined} />
        {proactive ? (
          <BlueprintMenuRow icon={Radar} label="Proactive" menuLabel="Agent proactive" value={proactive.enabled ? 'on' : 'off'} detail={cloudAgentProactiveDescription(proactive.enabled)} options={PROACTIVE_OPTIONS} onSelect={proactive.onChange && (creating || agent) ? (value) => proactive.onChange?.(value === 'on') : undefined} />
        ) : null}
        {totalChanges > 0 ? (
          <div className="app-agent-studio-draft-summary"><div>
            <strong>{creating ? 'Build ready to review' : `${totalChanges} change${totalChanges === 1 ? '' : 's'} ready to review`}</strong>
            <span>{builderStatus?.validation.valid ? 'Validation passed. Nothing is live until you publish.' : builderStatus?.validation.errors[0] ?? 'Nothing is live until you publish.'}</span>
          </div></div>
        ) : null}
        {!creating && changes.length > 0 ? (
          <div className="app-agent-studio-change-list">{changes.map((change) => (
            <div key={`${change.key}:${change.label}`} className="app-agent-studio-change-row"><Check className="h-3.5 w-3.5" /><span>{change.label}</span><code>{change.detail}</code></div>
          ))}</div>
        ) : null}
      </section>
      {promptEditorOpen ? <PromptEditor value={prompt} onChange={(value) => { if (creating && creationDraft) onCreationDraftChange({ ...creationDraft, systemPrompt: value }); else onPromptChange(value); }} onClose={() => setPromptEditorOpen(false)} /> : null}
      {nameEditorOpen && onNameChange ? <NameEditor value={name} onChange={onNameChange} onClose={() => setNameEditorOpen(false)} /> : null}
    </div>
  );
}
