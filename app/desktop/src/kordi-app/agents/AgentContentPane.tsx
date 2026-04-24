import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Agent } from '../types';
import { getAgentConfigPath, type AgentConfigDraft, type AgentSaveFeedback } from './model';

type FilePreviewState = { status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string };
type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

export function AgentContentPane({
  activeAgent,
  activeDetail,
  activeAgentConfig,
  activeEditingSection,
  activeSaveFeedback,
  activeFilePreview,
  activeFileDraft,
  activeFileCanEdit,
  activeFileIsEditing,
  activeFileSaveFeedback,
  onStartPromptEditing,
  onSavePrompt,
  onCancelPromptEditing,
  onPromptChange,
  onStartFileEditing,
  onCancelFileEditing,
  onSaveFile,
  onFileDraftChange,
}: {
  activeAgent?: Agent;
  activeDetail: DetailTarget;
  activeAgentConfig: AgentConfigDraft | null;
  activeEditingSection: 'prompt' | 'skills' | null;
  activeSaveFeedback: AgentSaveFeedback | null;
  activeFilePreview: FilePreviewState;
  activeFileDraft: string;
  activeFileCanEdit: boolean;
  activeFileIsEditing: boolean;
  activeFileSaveFeedback: AgentSaveFeedback | null;
  onStartPromptEditing: (agentId: string) => void;
  onSavePrompt: (agent: Agent) => void;
  onCancelPromptEditing: (agent: Agent) => void;
  onPromptChange: (agentId: string, value: string) => void;
  onStartFileEditing: () => void;
  onCancelFileEditing: () => void;
  onSaveFile: () => void;
  onFileDraftChange: (value: string) => void;
}) {
  if (!activeAgent || !activeAgentConfig || !activeDetail) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col border-l border-white/6 bg-[rgba(16,17,20,0.72)] text-white">
        <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
          Select an item in the middle panel to preview or edit it here.
        </div>
      </section>
    );
  }

  if (activeDetail.kind === 'prompt') {
    const activeConfigPath = getAgentConfigPath(activeAgent);
    const isEditable = Boolean(activeConfigPath);
    const hasRuntimePrompt = activeAgentConfig.systemPrompt.trim().length > 0;

    return (
      <section className="flex min-h-0 min-w-0 flex-col border-l border-white/6 bg-[rgba(16,17,20,0.72)] text-white">
        <div className="border-b border-white/6 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-slate-400">System prompt</div>
              <div className="mt-1 truncate text-[18px] font-semibold tracking-[-0.02em] text-white">{activeAgent.name}</div>
              <div className="mt-1 text-[12px] text-slate-500">{activeConfigPath ?? (hasRuntimePrompt ? 'Exact current runtime prompt' : 'Not exposed by bridge agent')}</div>
              {activeSaveFeedback ? (
                <div
                  className={cn(
                    'mt-2 text-[12px]',
                    activeSaveFeedback.tone === 'success'
                      ? 'text-emerald-300'
                      : activeSaveFeedback.tone === 'error'
                        ? 'text-rose-300'
                        : 'text-slate-400',
                  )}
                >
                  {activeSaveFeedback.text}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {isEditable ? (
                activeEditingSection === 'prompt' ? (
                  <>
                    <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onCancelPromptEditing(activeAgent)}>
                      Cancel
                    </Button>
                    <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onSavePrompt(activeAgent)}>
                      Save prompt
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onStartPromptEditing(activeAgent.id)}>
                    Edit prompt
                  </Button>
                )
              ) : (
                <div className="text-[11px] text-slate-500">Runtime-managed</div>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-5 py-5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-white/8 bg-black/20">
            <div className="border-b border-white/6 px-4 py-2 text-[11px] text-slate-500">
              {isEditable && activeEditingSection === 'prompt' ? 'Editing saved prompt' : hasRuntimePrompt ? 'Full prompt detail' : 'No exposed prompt'}
            </div>
            {isEditable && activeEditingSection === 'prompt' ? (
              <textarea
                rows={20}
                value={activeAgentConfig.systemPrompt}
                onChange={(event) => onPromptChange(activeAgent.id, event.target.value)}
                className="h-full min-h-0 w-full resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-6 text-slate-200 outline-none"
                spellCheck={false}
              />
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <pre className="px-4 py-4 font-mono text-[12px] leading-6 text-slate-300 whitespace-pre-wrap break-words">{activeAgentConfig.systemPrompt || 'No real prompt payload is exposed for this identity.'}</pre>
              </ScrollArea>
            )}
          </div>
        </div>
      </section>
    );
  }

  const filePath = activeDetail.path;
  const parts = filePath.split('/');

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-l border-white/6 bg-[rgba(16,17,20,0.72)] text-white">
      <div className="border-b border-white/6 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-slate-400">Markdown / config detail</div>
            <div className="mt-1 truncate text-[18px] font-semibold tracking-[-0.02em] text-white">{parts[parts.length - 1] ?? filePath}</div>
            <div className="mt-1 text-[12px] text-slate-500">{filePath}</div>
            {activeFileSaveFeedback ? (
              <div
                className={cn(
                  'mt-2 text-[12px]',
                  activeFileSaveFeedback.tone === 'success'
                    ? 'text-emerald-300'
                    : activeFileSaveFeedback.tone === 'error'
                      ? 'text-rose-300'
                      : 'text-slate-400',
                )}
              >
                {activeFileSaveFeedback.text}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {activeFileCanEdit ? (
              activeFileIsEditing ? (
                <>
                  <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onCancelFileEditing}>
                    Cancel
                  </Button>
                  <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onSaveFile}>
                    Save file
                  </Button>
                </>
              ) : (
                <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onStartFileEditing} disabled={activeFilePreview.status === 'loading'}>
                  Edit file
                </Button>
              )
            ) : (
              <div className="text-[11px] text-slate-500">Read only</div>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-white/6 px-5 py-4">
        <div className="grid gap-2">
          {[
            ['Name', parts[parts.length - 1] ?? filePath],
            ['Folder', parts.slice(0, -1).join('/') || 'Workspace root'],
            ['Source', 'Repo-relative workspace file'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-3 text-[12px]">
              <div className="text-slate-500">{label}</div>
              <div className="max-w-[70%] text-right text-slate-200">{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 py-5">
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-white/8 bg-black/20">
          <div className="border-b border-white/6 px-4 py-2 text-[11px] text-slate-500">
            {activeFilePreview.status === 'loading'
              ? 'Loading real file…'
              : activeFilePreview.status === 'error'
                ? `Preview fallback • ${activeFilePreview.error ?? 'Unable to read file'}`
                : activeFileCanEdit
                  ? activeFileIsEditing
                    ? 'Editing repo-relative file'
                    : 'Previewing repo-relative file'
                  : 'Preview'}
          </div>

          {activeFileIsEditing ? (
            <textarea
              value={activeFileDraft}
              onChange={(event) => onFileDraftChange(event.target.value)}
              spellCheck={false}
              className="h-full min-h-0 w-full resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-6 text-slate-200 outline-none"
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <pre className="px-4 py-4 font-mono text-[12px] leading-6 text-slate-300 whitespace-pre-wrap break-words">{activeFileDraft}</pre>
            </ScrollArea>
          )}
        </div>
      </div>
    </section>
  );
}
