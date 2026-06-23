import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CreateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import type { Agent } from '../types';
import { parseShapeResources, type ShapeAgentDraft } from './shapeAgentDraft';
import { buildShapeAgentDraftPrompt } from './shapeAgentPrompts';
import { draftShapeAgentWithDesktopRuntime, shapeAgentRouteFromCreatorAgent } from './shapeAgentRuntime';

type AgentCreateDialogProps = {
  open: boolean;
  onClose: () => void;
  creatorAgent?: Agent | null;
  onCreateCloudAgent?: (input: CreateCloudAgentInput) => Promise<Agent>;
  onCreated?: (agent: Agent) => void;
};

function resourcesForPayload(resources: ReturnType<typeof parseShapeResources>, creatorAgent?: Agent | null) {
  const creatorResource = creatorAgent ? [{
    kind: 'creator-agent',
    value: creatorAgent.id,
    title: creatorAgent.name,
    summary: `${creatorAgent.loadedTools.length} tools, ${creatorAgent.loadedSkills.length} skills used during shaping`,
  }] : [];
  return [...creatorResource, ...resources.map((resource) => ({
    kind: resource.kind,
    value: resource.value,
    title: null,
    summary: null,
  }))];
}

function skillsForPayload(draft: ShapeAgentDraft) {
  return draft.skills.map((skill) => ({ name: skill.name, description: skill.description }));
}

export function AgentCreateDialog({ open, creatorAgent, onClose, onCreateCloudAgent, onCreated }: AgentCreateDialogProps) {
  const [resourcesText, setResourcesText] = useState('');
  const [identity, setIdentity] = useState('');
  const [draft, setDraft] = useState<ShapeAgentDraft | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'idle' | 'info' | 'error' | 'success'; text: string }>({ tone: 'idle', text: '' });
  const [creating, setCreating] = useState(false);
  const [shaping, setShaping] = useState(false);

  const resources = useMemo(() => parseShapeResources(resourcesText), [resourcesText]);
  const creatorRoute = useMemo(() => shapeAgentRouteFromCreatorAgent(creatorAgent), [creatorAgent]);
  const shapePrompt = useMemo(() => buildShapeAgentDraftPrompt({ resources, identity, creatorAgent }), [creatorAgent, identity, resources]);
  const canShape = Boolean(creatorAgent && creatorRoute && !shaping);
  const canCreate = Boolean(onCreateCloudAgent && draft && !creating);

  if (!open) return null;

  const generateDraft = async () => {
    setShaping(true);
    setFeedback({ tone: 'info', text: 'Shaping draft with the local Agent runtime…' });
    try {
      if (!creatorAgent || !creatorRoute) {
        setFeedback({ tone: 'error', text: "Configure Kordi's LLM provider and model route before shaping a Cloud Agent." });
        return;
      }
      const result = await draftShapeAgentWithDesktopRuntime({ resources, identity, creatorAgent, route: creatorRoute });
      setDraft(result.draft);
      setFeedback({
        tone: result.source === 'llm' ? 'success' : 'info',
        text: result.source === 'llm'
          ? 'LLM-shaped draft is ready to review.'
          : `Draft shaped from your inputs. ${result.error ?? 'The local model was unavailable.'}`,
      });
    } finally {
      setShaping(false);
    }
  };

  const createAgent = async () => {
    if (!draft || !onCreateCloudAgent) return;
    setCreating(true);
    setFeedback({ tone: 'info', text: 'Creating private Cloud agent…' });
    try {
      const agent = await onCreateCloudAgent({
        accessScope: 'private',
        name: draft.name,
        role: draft.role,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        sourceSummary: draft.sourceSummary,
        boundaries: draft.boundaries,
        resources: resourcesForPayload(resources, creatorAgent),
        skills: skillsForPayload(draft),
        modelRouting: {},
      });
      setFeedback({ tone: 'success', text: 'Agent created privately in Cloud.' });
      onCreated?.(agent);
      onClose();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to create Cloud agent' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="app-overlay app-agent-create-overlay fixed inset-0 z-[2147482500] flex items-center justify-center px-4 py-6" role="dialog" aria-modal="true" aria-labelledby="agent-create-title">
      <div className="app-modal-panel app-agent-create-dialog max-h-full w-full max-w-3xl overflow-hidden rounded-[24px] border">
        <div className="app-agent-panel-header flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <div id="agent-create-title" className="app-agent-panel-title text-[16px] font-semibold">Create Cloud Agent</div>
            <div className="app-agent-panel-subtitle mt-1 text-[12px] leading-5">Kordi shapes the private Agent with its configured LLM provider, tools, and skills.</div>
          </div>
          <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onClose}>Close</Button>
        </div>

        <div className="app-agent-create-body grid max-h-[min(70vh,42rem)] gap-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4 border-r border-[color:var(--app-divider)] px-5 py-5">
            <div className="app-agent-empty-callout app-agent-create-source-card rounded-[14px] border px-4 py-3 text-[12px] leading-5">
              <div className="app-agent-row-title font-medium">Created by {creatorAgent?.name ?? 'Kordi'}</div>
              <div className="app-agent-row-meta mt-1">Uses Kordi's configured LLM provider and current tool/skill context during shaping.</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="app-agent-chip rounded-full border px-2.5 py-1">{creatorAgent?.loadedTools.length ?? 0} tools</span>
                <span className="app-agent-chip rounded-full border px-2.5 py-1">{creatorAgent?.loadedSkills.length ?? 0} skills</span>
                <span className="app-agent-chip rounded-full border px-2.5 py-1">{creatorAgent?.identityFiles.length ?? 0} files</span>
              </div>
              <div className="app-agent-row-meta mt-3 line-clamp-2">Tools: {(creatorAgent?.loadedTools ?? []).slice(0, 8).join(', ') || 'none exposed'}</div>
              <div className="app-agent-row-meta mt-1 line-clamp-2">Skills: {(creatorAgent?.loadedSkills ?? []).slice(0, 8).join(', ') || 'none exposed'}</div>
              <div className={cn('mt-2 text-[12px]', creatorRoute ? 'text-emerald-300' : 'text-rose-300')}>
                {creatorRoute ? `LLM route: ${creatorRoute.defaultAuthProvider} · ${creatorRoute.defaultModel}` : "Configure Kordi's LLM provider/model before shaping."}
              </div>
            </div>

            <div>
              <label className="app-agent-row-title text-[12px] font-medium" htmlFor="agent-resources">Resources</label>
              <textarea
                id="agent-resources"
                value={resourcesText}
                onChange={(event) => setResourcesText(event.target.value)}
                placeholder="Paste URLs, file paths, or a short source description…"
                className="app-agent-inspector-row mt-2 min-h-28 w-full resize-y rounded-[14px] border bg-transparent px-3 py-3 text-[13px] leading-5 outline-none"
              />
            </div>
            <div>
              <label className="app-agent-row-title text-[12px] font-medium" htmlFor="agent-identity">Identity</label>
              <textarea
                id="agent-identity"
                value={identity}
                onChange={(event) => setIdentity(event.target.value)}
                placeholder="Example: A technical support agent for our product docs."
                className="app-agent-inspector-row mt-2 min-h-24 w-full resize-y rounded-[14px] border bg-transparent px-3 py-3 text-[13px] leading-5 outline-none"
              />
            </div>
            <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[12px] leading-5">
              <div className="app-agent-row-title font-medium">Access</div>
              <select className="mt-2 w-full rounded-[12px] border border-[color:var(--app-divider)] bg-transparent px-3 py-2 text-[12px]" value="private" onChange={() => undefined} aria-label="Agent access">
                <option value="private">Private — only me</option>
                <option value="contacts" disabled>Share with contacts — coming later</option>
                <option value="workspace" disabled>Workspace/shared Cloud — coming later</option>
              </select>
              <div className="app-agent-row-meta mt-2">MVP agents are creator-owned/private Cloud sync only.</div>
            </div>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div>
              <div className="app-agent-row-title text-[13px] font-medium">Draft</div>
              <div className="app-agent-row-meta mt-1 text-[11px]">Output follows the Cloud Agent definition schema.</div>
            </div>

            {draft ? (
              <div className="space-y-3">
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="app-agent-inspector-row w-full rounded-[14px] border bg-transparent px-3 py-2 text-[13px] font-medium outline-none" />
                <input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} className="app-agent-inspector-row w-full rounded-[14px] border bg-transparent px-3 py-2 text-[13px] outline-none" />
                <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="app-agent-inspector-row min-h-20 w-full resize-y rounded-[14px] border bg-transparent px-3 py-3 text-[13px] outline-none" />
                <textarea value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} className="app-agent-code-panel min-h-40 w-full resize-y rounded-[14px] border bg-transparent px-3 py-3 font-mono text-[12px] leading-5 outline-none" />
                <div className="app-agent-row-meta text-[11px]">Shape prompt preview is kept for LLM refinement:</div>
                <pre className="app-agent-code-panel max-h-28 overflow-auto rounded-[14px] border px-3 py-3 text-[10px] leading-4 whitespace-pre-wrap">{shapePrompt}</pre>
              </div>
            ) : (
              <div className="app-agent-empty-state app-agent-create-empty-draft rounded-[18px] border px-4 py-10 text-center text-[13px] leading-5">Add resources and identity, then click Shape draft.</div>
            )}
            {feedback.text ? <div className={cn('text-[12px]', feedback.tone === 'error' ? 'text-rose-300' : feedback.tone === 'success' ? 'text-emerald-300' : 'text-slate-400')}>{feedback.text}</div> : null}
          </div>
        </div>

        <div className="app-agent-create-footer app-agent-create-actions flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--app-divider)] px-5 py-4">
          <div className="app-agent-row-meta text-[12px] leading-5">
            Shape prepares the draft. Create saves it as your private Cloud Agent.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" className="rounded-xl text-[12px]" onClick={() => void generateDraft()} disabled={!canShape}>{shaping ? 'Shaping…' : 'Shape draft with Kordi'}</Button>
            <Button className="rounded-xl text-[12px]" disabled={!canCreate} onClick={() => void createAgent()}>{creating ? 'Creating…' : 'Create private Agent'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
