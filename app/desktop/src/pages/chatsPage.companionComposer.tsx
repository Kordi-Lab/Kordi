import type { Dispatch, RefObject, SetStateAction } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Send,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import {
  collaborationChatRoutingControlVisibility,
  type LocalCollaborationAgentRoutingOption,
  routingSelectionForCollaborationAgent,
} from '@/features/collaboration/agentModelRouting';
import {
  ComposerModelControls,
  ComposerRuntimeStatus,
} from '@/kordi-app/components';
import type {
  Conversation,
  DesktopCollaborationAgentRouting,
  DesktopChatContextWindowStatus,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import {
  COLLABORATION_ROUTING_NOTICE_EXIT_MS,
} from '@/pages/chatsPage.constants';
import {
  authChoiceFromProviderOption,
  firstModelForProvider,
} from '@/pages/chatsPage.model';
import type {
  ChatsPageComposer,
  ChatsPageRuntime,
} from '@/pages/chatsPage.types';

type ComposerSelector = ChatsPageRuntime['openComposerSelector'];

type CompanionLocalRouting = {
  enabled: boolean;
  selection: ChatsPageRuntime['composerSelection'] | null;
  configTarget: ComposerConfigTargetOverride;
  authLabel: string;
  authOptions: ChatsPageRuntime['composerAuthOptions'];
  isLoading: boolean;
  loadError: string | null;
  retry: () => void;
  runtimeContextStatus: DesktopChatContextWindowStatus | null;
  runtimeCacheText: string | null;
};

export type CompanionCollaborationRoutingPatch =
  DesktopCollaborationAgentRouting & {
    selectorType?: 'provider' | 'model' | 'thinking';
  };

type CompanionCollaborationRouting = {
  enabled: boolean;
  notice: string | null;
  agents: LocalCollaborationAgentRoutingOption[];
  selectedAgent: LocalCollaborationAgentRoutingOption | null;
  selection: ReturnType<typeof routingSelectionForCollaborationAgent>;
  visibility: ReturnType<typeof collaborationChatRoutingControlVisibility>;
  selectorOpen: boolean;
  setSelectedAgentId: Dispatch<SetStateAction<string | null>>;
  update: (patch: CompanionCollaborationRoutingPatch) => void;
  defaultThinkingForModel: (
    modelValue: string | null | undefined,
    currentThinking: string | null | undefined,
  ) => string;
};

type CompanionComposerUi = {
  openSelector: ComposerSelector;
  setOpenSelector: Dispatch<SetStateAction<ComposerSelector>>;
  toggleSelector: ChatsPageRuntime['toggleComposerSelector'];
  prefersReducedMotion: boolean | null;
};

export type CompanionComposerProps = {
  conversation: Conversation;
  paneKind: 'human' | 'agent';
  draftText: string;
  isNativeShell: boolean;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
  localRouting: CompanionLocalRouting;
  collaborationRouting: CompanionCollaborationRouting;
  ui: CompanionComposerUi;
  onDraftChange: (
    conversationId: string,
    value: string,
    target?: HTMLTextAreaElement,
  ) => void;
  onSend: (conversation: Conversation) => void;
};

export function CompanionComposer({
  conversation,
  paneKind,
  draftText,
  isNativeShell,
  attachmentInputRef,
  composer,
  runtime,
  localRouting,
  collaborationRouting,
  ui,
  onDraftChange,
  onSend,
}: CompanionComposerProps) {
  const {
    chatComposerAttachments,
    saveDesktopAttachments,
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
  } = composer;
  const {
    composerProviderOptions,
    chatModelOptions,
    composerAuthLabel,
    composerAuthOptions,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
  } = runtime;
  const {
    openSelector,
    setOpenSelector,
    toggleSelector,
    prefersReducedMotion,
  } = ui;
  const selectedAgent = collaborationRouting.selectedAgent;

  return (
    <div data-companion-composer-frame="true" className="shrink-0 px-5 pb-4 pt-3">
      <div className="app-composer-shell rounded-[26px] p-3" data-companion-composer-footer="true">
        <div className="relative">
          <div
            className={cn(
              'app-composer-input rounded-[18px] transition',
              chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
            )}
          >
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void saveDesktopAttachments(files);
                event.currentTarget.value = '';
              }}
            />
            {chatComposerAttachments.length > 0 ? (
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                {chatComposerAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                  >
                    {attachment.kind === 'image'
                      ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                      : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                    <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                    <button
                      type="button"
                      onClick={() => removeChatComposerAttachment(attachment.id)}
                      className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              rows={1}
              value={draftText}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => onDraftChange(conversation.id, event.target.value, event.target)}
              onPaste={(event) => {
                const files = extractClipboardFiles(event.clipboardData);
                if (files.length > 0) {
                  event.preventDefault();
                  void saveDesktopAttachments(files);
                  return;
                }
                const pastedPaths = extractPastedLocalFilePaths(
                  event.clipboardData.getData('text/plain'),
                  event.clipboardData.getData('text/uri-list'),
                );
                if (pastedPaths.length > 0) {
                  event.preventDefault();
                  void saveDesktopAttachmentPaths(pastedPaths);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                  event.preventDefault();
                  onSend(conversation);
                }
              }}
              className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              placeholder={paneKind === 'agent' ? 'Ask the agent…' : `Message ${conversation.name}`}
              data-composer-scope="chat"
            />
          </div>
        </div>
        <AnimatePresence initial={false}>
          {collaborationRouting.enabled && collaborationRouting.notice ? (
            <motion.div
              key={collaborationRouting.notice}
              className="mb-2 flex justify-center"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
              transition={{
                duration: prefersReducedMotion ? 0.01 : COLLABORATION_ROUTING_NOTICE_EXIT_MS / 1000,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <div className="max-w-[min(100%,38rem)] truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-slate-300">
                Private · {collaborationRouting.notice}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div data-companion-send-row="true" className="app-composer-meta mt-2 flex flex-nowrap items-center justify-between gap-3 pt-2.5">
          <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
            <Button
              size="icon"
              variant="secondary"
              className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
              onClick={() => attachmentInputRef.current?.click()}
              title="Add attachment"
              aria-label="Add attachment"
              data-companion-attachment-control="true"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-visible">
            {localRouting.enabled && localRouting.selection && localRouting.configTarget ? (
              <div className="flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible" data-companion-model-controls="true">
                {isNativeShell || localRouting.runtimeContextStatus ? (
                  <ComposerRuntimeStatus
                    contextStatus={localRouting.runtimeContextStatus}
                    cacheText={localRouting.runtimeCacheText}
                  />
                ) : null}
                <div className="min-w-0 max-w-full overflow-visible">
                  <ComposerModelControls
                    scope="chat"
                    selection={localRouting.selection}
                    openSelector={openSelector}
                    onToggleSelector={toggleSelector}
                    onSelectValue={(scope, type, value) => {
                      setOpenSelector(null);
                      void selectComposerValue(scope, type, value, localRouting.configTarget);
                    }}
                    authLabel={localRouting.authLabel}
                    authOptions={localRouting.authOptions}
                    onSelectAuthChoice={(scope, providerId, choice) => {
                      setOpenSelector(null);
                      void selectComposerAuthChoice(scope, providerId, choice, localRouting.configTarget);
                    }}
                    onSelectProviderChoice={(scope, option) => {
                      setOpenSelector(null);
                      void selectComposerProviderChoice(scope, option, localRouting.configTarget);
                    }}
                    providerOptions={composerProviderOptions}
                    modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                    compact={true}
                  />
                </div>
              </div>
            ) : localRouting.enabled && localRouting.isLoading ? (
              <span className="text-[12px] text-[color:var(--utility-muted-text)]" data-companion-model-loading="true">
                Loading model…
              </span>
            ) : localRouting.enabled && localRouting.loadError ? (
              <button
                type="button"
                onClick={localRouting.retry}
                className="text-[12px] text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                title={localRouting.loadError}
                data-companion-model-retry="true"
              >
                Retry model
              </button>
            ) : collaborationRouting.enabled && selectedAgent ? (
              <div className="relative flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible" data-companion-model-controls="true" data-companion-collaboration-model-controls="true">
                {collaborationRouting.visibility.showAgentSelector ? (
                  <button
                    type="button"
                    onClick={() => toggleSelector('chat', 'mode')}
                    className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
                    title="Choose which owned agent these session settings apply to"
                  >
                    <span className="truncate">{selectedAgent.label}</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', collaborationRouting.selectorOpen ? 'rotate-180 text-slate-300' : '')} />
                  </button>
                ) : null}
                {collaborationRouting.selectorOpen ? (
                  <div className="app-transient-surface app-transient-scroll absolute bottom-full right-0 z-30 mb-2 max-h-[min(22rem,50vh)] w-[260px] overflow-y-auto rounded-[16px] border px-3 py-3 text-[12px]">
                    <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">My agent</div>
                    <div className="space-y-1">
                      {collaborationRouting.agents.map((agent) => (
                        <button
                          key={`${agent.hostId}:${agent.id}`}
                          type="button"
                          onClick={() => {
                            collaborationRouting.setSelectedAgentId(agent.id);
                            setOpenSelector(null);
                          }}
                          className={cn(
                            'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                            selectedAgent.id === agent.id ? 'app-composer-popover-item-active' : '',
                          )}
                        >
                          <span className="truncate">{agent.label}</span>
                          <span className="shrink-0 text-[11px] text-[color:var(--utility-muted-text)]">{agent.isDefault ? 'Default' : 'Owned'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <ComposerModelControls
                  scope="chat"
                  selection={collaborationRouting.selection}
                  openSelector={openSelector}
                  onToggleSelector={toggleSelector}
                  onSelectValue={(_scope, type, value) => {
                    if (type === 'model') {
                      collaborationRouting.update({
                        defaultModel: value,
                        defaultAuthProvider: selectedAgent.defaultAuthProvider ?? null,
                        defaultAuthChoice: selectedAgent.defaultAuthChoice ?? null,
                        fallbackModel: selectedAgent.fallbackModel ?? null,
                        fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
                        fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
                        thinking: collaborationRouting.defaultThinkingForModel(value, selectedAgent.thinking),
                        selectorType: 'model',
                      });
                    } else if (type === 'thinking') {
                      collaborationRouting.update({
                        defaultModel: selectedAgent.defaultModel ?? null,
                        defaultAuthProvider: selectedAgent.defaultAuthProvider ?? null,
                        defaultAuthChoice: selectedAgent.defaultAuthChoice ?? null,
                        fallbackModel: selectedAgent.fallbackModel ?? null,
                        fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
                        fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
                        thinking: value,
                        selectorType: 'thinking',
                      });
                    }
                  }}
                  authLabel={composerAuthLabel}
                  authOptions={composerAuthOptions}
                  onSelectAuthChoice={() => {}}
                  onSelectProviderChoice={(_scope, option) => {
                    const nextModel = firstModelForProvider(option.providerId, chatModelOptions);
                    if (!nextModel) return;
                    collaborationRouting.update({
                      defaultModel: nextModel,
                      defaultAuthProvider: option.providerId,
                      defaultAuthChoice: authChoiceFromProviderOption(option),
                      fallbackModel: selectedAgent.fallbackModel ?? null,
                      fallbackAuthProvider: selectedAgent.fallbackAuthProvider ?? null,
                      fallbackAuthChoice: selectedAgent.fallbackAuthChoice ?? null,
                      thinking: collaborationRouting.defaultThinkingForModel(nextModel, selectedAgent.thinking),
                      selectorType: 'provider',
                    });
                  }}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                  compact={true}
                />
              </div>
            ) : null}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={() => onSend(conversation)}
              className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
              title={`Send to ${conversation.name}`}
              aria-label={`Send to ${conversation.name}`}
              disabled={!draftText.trim() && chatComposerAttachments.length === 0}
              data-companion-send-control="true"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
