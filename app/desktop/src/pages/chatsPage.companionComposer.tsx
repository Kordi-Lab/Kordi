import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { BlobEmojiComposerInput, type BlobEmojiComposerInputHandle } from '@/features/emoji/BlobEmojiComposerInput';
import { subsessionMentions } from '@/features/cloud/subsessionConversation';
import { ComposerMentionMenu } from '@/kordi-app/components/composerMentionMenu';
import { currentMentionQuery, orderedComposerMentionOptions } from '@/kordi-app/components/composerMentionOptions';
import type { ComposerMentionOption } from '@/kordi-app/components/composer';
import {
  collaborationChatRoutingControlVisibility,
  type LocalCollaborationAgentRoutingOption,
  routingSelectionForCollaborationAgent,
} from '@/features/collaboration/agentModelRouting';
import {
  ComposerModelControls,
  ComposerRuntimeStatus,
} from '@/kordi-app/components';
import {
  ComposerAttachmentAddMenu,
  ComposerAttachmentList,
} from '@/kordi-app/components/composerAttachments';
import type {
  Conversation,
  DesktopChatContextWindowStatus,
  MessageMention,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import {
  CollaborationRoutingControls,
  type CollaborationRoutingPatch,
} from '@/pages/chatsPage.collaborationRoutingControls';
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

type CompanionCollaborationRouting = {
  enabled: boolean;
  notice: string | null;
  agents: LocalCollaborationAgentRoutingOption[];
  selectedAgent: LocalCollaborationAgentRoutingOption | null;
  selection: ReturnType<typeof routingSelectionForCollaborationAgent>;
  visibility: ReturnType<typeof collaborationChatRoutingControlVisibility>;
  selectorOpen: boolean;
  setSelectedAgentId: Dispatch<SetStateAction<string | null>>;
  update: (patch: CollaborationRoutingPatch) => void;
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
  isPreparing?: boolean;
  conversation: Conversation;
  subsession?: { mentionOptions: ComposerMentionOption[]; sending: boolean; sendError: string | null; disabled: boolean };
  paneKind: 'human' | 'agent';
  draftText: string;
  attachmentError: string | null;
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
    target?: HTMLTextAreaElement | HTMLDivElement,
  ) => void;
  onSend: (conversation: Conversation, mentions?: MessageMention[]) => void;
};

export function CompanionComposer({
  isPreparing = false,
  conversation,
  subsession,
  paneKind,
  draftText,
  attachmentError,
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
    updateChatComposerAttachment,
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
  } = ui;
  const selectedAgent = collaborationRouting.selectedAgent;
  const editor = useRef<BlobEmojiComposerInputHandle>(null);
  const mentionCaret = useRef<number | null>(null);
  const selectedMentions = useRef<ComposerMentionOption[]>([]);
  const [query, setQuery] = useState<ReturnType<typeof currentMentionQuery>>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuId = useId();
  const mentionOptions = orderedComposerMentionOptions(subsession && query
    ? subsession.mentionOptions.filter(option => option.value.toLowerCase().includes(query.normalized) || option.label.toLowerCase().includes(query.normalized)) : []);
  useEffect(() => { if (!draftText) selectedMentions.current = []; }, [draftText]);
  useLayoutEffect(() => {
    if (mentionCaret.current == null) return;
    const caret = mentionCaret.current; mentionCaret.current = null;
    editor.current?.focus({ start: caret, end: caret });
  }, [draftText]);
  const acceptMention = (option: ComposerMentionOption) => {
    if (!query) return;
    selectedMentions.current = [...selectedMentions.current.filter(item => item.value !== option.value), option];
    const replacement = '@' + option.value + ' ';
    mentionCaret.current = query.start + replacement.length;
    onDraftChange(conversation.id, draftText.slice(0, query.start) + replacement + draftText.slice(query.end));
    setQuery(null);
  };
  const send = () => {
    if (isPreparing || subsession?.disabled || subsession?.sending) return;
    const selectedHandles = new Set(selectedMentions.current.map(option => option.value));
    const boundOptions = [...(subsession?.mentionOptions ?? []).filter(option => !selectedHandles.has(option.value)), ...selectedMentions.current];
    setQuery(null);
    onSend(conversation, subsession ? subsessionMentions(draftText.trim(), boundOptions) : undefined);
  };
  const error = subsession?.sendError ?? attachmentError;

  return (
    <div data-companion-composer-frame="true" className="shrink-0 px-5 pb-4 pt-3">
      <div className="app-composer-shell rounded-[26px] p-3" data-companion-composer-footer="true">
        <div className="relative">
          {mentionOptions.length > 0 ? <ComposerMentionMenu id={menuId} items={mentionOptions} peopleLabel="Members"
            selectedIndex={Math.min(selectedIndex, mentionOptions.length - 1)} onSelect={acceptMention} /> : null}
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
            <ComposerAttachmentList
              attachments={chatComposerAttachments}
              onRemove={removeChatComposerAttachment}
              onReplace={updateChatComposerAttachment}
            />
            {error ? (
              <p className="px-0.5 pb-1 text-[10.5px] leading-4 text-amber-500" role="alert">
                {error}
              </p>
            ) : null}
            <BlobEmojiComposerInput
              ref={editor}
              value={draftText}
              readOnly={subsession?.sending}
              ariaControls={mentionOptions.length ? menuId : undefined}
              ariaExpanded={mentionOptions.length > 0}
              ariaActiveDescendant={mentionOptions.length ? `${menuId}-option-${Math.min(selectedIndex, mentionOptions.length - 1)}` : undefined}
              onPointerDownCapture={(event) => event.stopPropagation()}
              onChange={(value, target) => {
                onDraftChange(conversation.id, value, target);
                if (subsession) { setQuery(currentMentionQuery(value, editor.current?.selection().start)); setSelectedIndex(0); }
              }}
              onPaste={(event) => {
                if (subsession) return;
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
                if (event.nativeEvent.isComposing) return;
                if (mentionOptions.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                  event.preventDefault(); setSelectedIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : mentionOptions.length - 1)) % mentionOptions.length); return;
                }
                if (mentionOptions.length && event.key === 'Enter') {
                  event.preventDefault(); acceptMention(mentionOptions[Math.min(selectedIndex, mentionOptions.length - 1)]); return;
                }
                if (query && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(null); return; }
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              placeholder={subsession ? 'Send a message; @mention the agent for a reply' : paneKind === 'agent' ? 'Ask the agent…' : `Message ${conversation.name}`}
            />
          </div>
        </div>
        <div data-companion-send-row="true" className="app-composer-meta mt-2 flex flex-nowrap items-center justify-between gap-3 pt-2.5">
          <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
            {!subsession ? <ComposerAttachmentAddMenu
              inputRef={attachmentInputRef}
              onChooseFiles={isNativeShell
                ? () => { void saveDesktopAttachmentPaths(); }
                : undefined}
              data-companion-attachment-control="true"
            /> : null}
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
                className="app-button-quiet rounded-[9px] px-2 py-1 text-[12px]"
                title={localRouting.loadError}
                data-companion-model-retry="true"
              >
                Retry model
              </button>
            ) : collaborationRouting.enabled && selectedAgent ? (
              <div
                className="flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible"
                data-companion-model-controls="true"
                data-companion-collaboration-model-controls="true"
              >
                <CollaborationRoutingControls
                  model={{
                    agents: collaborationRouting.agents,
                    selectedAgent,
                    selection: collaborationRouting.selection,
                    visibility: collaborationRouting.visibility,
                  }}
                  menu={{
                    openSelector,
                    agentSelectorOpen: collaborationRouting.selectorOpen,
                    compact: true,
                  }}
                  options={{
                    authLabel: composerAuthLabel,
                    authOptions: composerAuthOptions,
                    providerOptions: composerProviderOptions,
                    modelOptions: chatModelOptions,
                  }}
                  actions={{
                    toggleSelector,
                    onSelectAgent: (agentId) => {
                      collaborationRouting.setSelectedAgentId(agentId);
                      setOpenSelector(null);
                    },
                    onUpdate: collaborationRouting.update,
                    defaultThinkingForModel: collaborationRouting.defaultThinkingForModel,
                  }}
                />
              </div>
            ) : null}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={send}
              className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
              title={`Send to ${conversation.name}`}
              aria-label={`Send to ${conversation.name}`}
              disabled={isPreparing || subsession?.sending || subsession?.disabled || (!draftText.trim() && chatComposerAttachments.length === 0)}
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
