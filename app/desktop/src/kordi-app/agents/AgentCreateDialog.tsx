import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CreateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import type { Agent } from '../types';
import { parseShapeResources, type ShapeAgentDraft } from './shapeAgentDraft';
import { buildShapeAgentDraftPrompt } from './shapeAgentPrompts';
import { draftShapeAgentWithDesktopRuntime } from './shapeAgentRuntime';

type AgentCreateDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreateCloudAgent?: (input: CreateCloudAgentInput) => Promise<Agent>;
  onCreated?: (agent: Agent) => void;
};

function resourcesForPayload(resources: ReturnType<typeof parseShapeResources>) {
  return resources.map((resource) => ({
    kind: resource.kind,
    value: resource.value,
    title: null,
    summary: null,
  }));
}

function skillsForPayload(draft: ShapeAgentDraft) {
  return draft.skills.map((skill) => ({ name: skill.name, description: skill.description }));
}

export function AgentCreateDialog({ open, onClose, onCreateCloudAgent, onCreated }: AgentCreateDialogProps) {
  const [resourcesText, setResourcesText] = useState('');
  const [identity, setIdentity] = useState('');
  const [draft, setDraft] = useState<ShapeAgentDraft | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'idle' | 'info' | 'error' | 'success'; text: string }>({ tone: 'idle', text: '' });
  const [creating, setCreating] = useState(false);
  const [shaping, setShaping] = useState(false);

  const resources = useMemo(() => parseShapeResources(resourcesText), [resourcesText]);
  const shapePrompt = useMemo(() => buildShapeAgentDraftPrompt({ resources, identity }), [identity, resources]);
  const canCreate = Boolean(onCreateCloudAgent && draft && !creating);

  if (!open) return null;

  const generateDraft = async () => {
    setShaping(true);
    setFeedback({ tone: 'info', text: 'Shaping draft with the local Agent runtime…' });
    try {
      const result = await draftShapeAgentWithDesktopRuntime({ resources, identity });
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
        resources: resourcesForPayload(resources),
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
    <div className="fixed inset-0 z-[2147482500] flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="agent-create-title">
      <div className="app-agent-create-dialog max-h-full w-full max-w-3xl overflow-hidden rounded-[24px] border bg-[var(--app-modal-bg)] shadow-[var(--app-shadow-float)]">
        <div className="app-agent-panel-header flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <div id="agent-create-title" className="app-agent-panel-title text-[16px] font-semibold">Create Cloud Agent</div>
            <div className="app-agent-panel-subtitle mt-1 text-[12px] leading-5">Shape a private Agent from resources, then sync it to your Cloud account.</div>
          </div>
          <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onClose}>Close</Button>
        </div>

        <div className="grid max-h-[min(78vh,46rem)] gap-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4 border-r border-[color:var(--app-divider)] px-5 py-5">
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
            <Button className="rounded-xl text-[12px]" onClick={() => void generateDraft()} disabled={shaping}>{shaping ? 'Shaping…' : 'Shape draft'}</Button>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="app-agent-row-title text-[13px] font-medium">Draft</div>
                <div className="app-agent-row-meta mt-1 text-[11px]">Output follows the Cloud Agent definition schema.</div>
              </div>
              <Button className="rounded-xl text-[12px]" disabled={!canCreate} onClick={() => void createAgent()}>{creating ? 'Creating…' : 'Create private Agent'}</Button>
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
              <div className="app-agent-empty-state rounded-[18px] border border-dashed px-4 py-10 text-center text-[13px] leading-5">Add resources and identity, then click Shape draft.</div>
            )}
            {feedback.text ? <div className={cn('text-[12px]', feedback.tone === 'error' ? 'text-rose-300' : feedback.tone === 'success' ? 'text-emerald-300' : 'text-slate-400')}>{feedback.text}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
