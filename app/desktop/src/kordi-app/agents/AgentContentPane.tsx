import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { handleDocumentCopySurfaceKeyDown } from '@/features/contentSelection';
import { cn } from '@/lib/utils';
import type { Agent } from '../types';
import { getAgentConfigPath, type AgentConfigDraft, type AgentSaveFeedback } from './model';
import { promptDisplayText } from './promptDisplay';

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
      <section className="app-agent-content-pane flex min-h-0 min-w-0 flex-col">
        <div className="app-agent-empty-state flex h-full items-center justify-center px-6 text-center text-[13px] leading-5">
          Select an item to preview or edit.
        </div>
      </section>
    );
  }

  if (activeDetail.kind === 'prompt') {
    const activeConfigPath = getAgentConfigPath(activeAgent);
    const isEditable = Boolean(activeConfigPath);
    const displayedSystemPrompt = promptDisplayText(activeAgentConfig.systemPrompt);

    return (
      <section className="app-agent-content-pane flex min-h-0 min-w-0 flex-col">
        <div className="app-agent-panel-header px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="app-agent-panel-subtitle text-[12px] font-medium">System prompt</div>
              <div className="app-agent-content-title mt-1 truncate text-[18px] font-semibold tracking-[-0.02em]">{activeAgent.name}</div>
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
                    <Button variant="quiet" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onCancelPromptEditing(activeAgent)}>
                      Cancel
                    </Button>
                    <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onSavePrompt(activeAgent)}>
                      Save prompt
                    </Button>
                  </>
                ) : (
                  <Button variant="quiet" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onStartPromptEditing(activeAgent.id)}>
                    Edit prompt
                  </Button>
                )
              ) : null}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-5 py-5">
          <div className="app-agent-code-panel flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border">
            <div className="app-agent-code-toolbar px-4 py-2 text-[11px]">
              {isEditable && activeEditingSection === 'prompt' ? 'Editing prompt' : 'Prompt'}
            </div>
            {isEditable && activeEditingSection === 'prompt' ? (
              <textarea
                rows={20}
                value={activeAgentConfig.systemPrompt}
                onChange={(event) => onPromptChange(activeAgent.id, event.target.value)}
                className="app-agent-code-text h-full min-h-0 w-full resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-6 outline-none"
                spellCheck={false}
              />
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <pre className="app-agent-code-text px-4 py-4 font-mono text-[12px] leading-6 whitespace-pre-wrap break-words" data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown}>{displayedSystemPrompt || 'No prompt available.'}</pre>
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
    <section className="app-agent-content-pane flex min-h-0 min-w-0 flex-col">
      <div className="app-agent-panel-header px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="app-agent-panel-subtitle text-[12px] font-medium">File</div>
            <div className="app-agent-content-title mt-1 truncate text-[18px] font-semibold tracking-[-0.02em]">{parts[parts.length - 1] ?? filePath}</div>
            <div className="app-agent-row-meta mt-1 break-words text-[12px]">{filePath}</div>
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
                  <Button variant="quiet" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onCancelFileEditing}>
                    Cancel
                  </Button>
                  <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onSaveFile}>
                    Save file
                  </Button>
                </>
              ) : (
                <Button variant="quiet" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={onStartFileEditing} disabled={activeFilePreview.status === 'loading'}>
                  Edit file
                </Button>
              )
            ) : (
              <div className="app-agent-row-meta text-[11px]">Read only</div>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 py-5">
        <div className="app-agent-code-panel flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border">
          <div className="app-agent-code-toolbar px-4 py-2 text-[11px]">
            {activeFilePreview.status === 'loading'
              ? 'Loading…'
              : activeFilePreview.status === 'error'
                ? activeFilePreview.error ?? 'Unable to read file'
                : activeFileCanEdit
                  ? activeFileIsEditing
                    ? 'Editing'
                    : 'Preview'
                  : 'Preview'}
          </div>

          {activeFileIsEditing ? (
            <textarea
              value={activeFileDraft}
              onChange={(event) => onFileDraftChange(event.target.value)}
              spellCheck={false}
              className="app-agent-code-text h-full min-h-0 w-full resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-6 outline-none"
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <pre className="app-agent-code-text px-4 py-4 font-mono text-[12px] leading-6 whitespace-pre-wrap break-words" data-kordi-copy-surface="document" tabIndex={0} onKeyDown={handleDocumentCopySurfaceKeyDown}>{activeFileDraft}</pre>
            </ScrollArea>
          )}
        </div>
      </div>
    </section>
  );
}
