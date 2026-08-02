import { AnimatePresence, motion } from 'framer-motion';
import { Paperclip, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextareaForNativeInput,
} from '@/features/chat/composerController.shared';
import { useImeCompositionGuard } from '@/features/chat/imeComposition';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import {
  CompactComposerModelMenu,
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  type CompactComposerModelMenuSaveInput,
} from '@/kordi-app/components';
import type {
  Conversation,
  DesktopChatContextWindowStatus,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import {
  CollaborationRoutingControls,
  type CollaborationRoutingControlsModel,
  type CollaborationRoutingPatch,
} from '@/pages/chatsPage.collaborationRoutingControls';
import {
  ComposerAttachmentList,
  ComposerQuotePreview,
  MessageSelectionBar,
} from '@/pages/chatsPage.composerPrimitives';
import { COLLABORATION_ROUTING_NOTICE_EXIT_MS } from '@/pages/chatsPage.constants';
import { shouldUseCompactModelRouteMenu } from '@/pages/chatsPage.header';
import type {
  ChatsPageComposer,
  ChatsPageRuntime,
} from '@/pages/chatsPage.types';

type MainComposerLocalRouting = {
  paneKind: 'human' | 'agent' | null;
  configTarget: ComposerConfigTargetOverride;
  contextStatus: DesktopChatContextWindowStatus | null | undefined;
  cacheText: string | null | undefined;
};

type MainComposerCollaborationRouting = {
  enabled: boolean;
  notice: string | null;
  model: CollaborationRoutingControlsModel | null;
  agentSelectorOpen: boolean;
  onSelectAgent: (agentId: string) => void;
  onUpdate: (patch: CollaborationRoutingPatch) => void;
  onSaveCompact: (input: CompactComposerModelMenuSaveInput) => void;
  defaultThinkingForModel: (
    modelValue: string | null | undefined,
    currentThinking: string | null | undefined,
  ) => string;
};

export type MainComposerProps = {
  conversation: Conversation;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
  localRouting: MainComposerLocalRouting;
  collaborationRouting: MainComposerCollaborationRouting;
  display: {
    isNativeShell: boolean;
    showCompanionPane: boolean;
    activeLiveTurnIsRunning: boolean;
    prefersReducedMotion: boolean | null;
    placeholder: string;
  };
  onSend: (draftOverride?: string) => void;
};

export function MainComposer({
  conversation,
  composer,
  runtime,
  localRouting,
  collaborationRouting,
  display,
  onSend,
}: MainComposerProps) {
  const {
    filteredChatSlashCommands,
    filteredChatMentionTargets,
    chatSlashMenuIndex,
    setChatSlashMenuIndex,
    acceptChatSlashCommand,
    acceptChatMentionTarget,
    chatAttachmentInputRef,
    chatComposerAttachments,
    saveDesktopAttachments,
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    chatComposerText,
    updateChatComposerDraft,
    setChatComposerText,
    activeChatQuote,
    onClearChatQuote,
    messageSelectionMode = false,
    selectedMessageCount = 0,
    onCancelMessageSelection,
    onCopySelectedMessages,
    onForwardSelectedMessages,
  } = composer;
  const {
    composerControlsRef,
    composerSelection,
    openComposerSelector,
    toggleComposerSelector,
    selectComposerValue,
    composerAuthLabel,
    composerAuthOptions,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    composerProviderOptions,
    chatModelOptions,
  } = runtime;
  const imeCompositionGuard = useImeCompositionGuard();
  const useCompactRouteMenu = shouldUseCompactModelRouteMenu(conversation);

  return (
    <div className="shrink-0 px-5 pb-4 pt-3">
      {messageSelectionMode && selectedMessageCount > 0 ? (
        <MessageSelectionBar
          count={selectedMessageCount}
          onCancel={onCancelMessageSelection}
          onCopy={onCopySelectedMessages}
          onForward={onForwardSelectedMessages}
        />
      ) : null}
      <AnimatePresence initial={false}>
        {collaborationRouting.enabled && collaborationRouting.notice ? (
          <motion.div
            key={collaborationRouting.notice}
            className="mb-2 flex justify-center"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: display.prefersReducedMotion ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: display.prefersReducedMotion ? 0 : -4 }}
            transition={{
              duration: display.prefersReducedMotion
                ? 0.01
                : COLLABORATION_ROUTING_NOTICE_EXIT_MS / 1000,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <div className="max-w-[min(100%,38rem)] truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-slate-300">
              Private · {collaborationRouting.notice}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="app-composer-shell rounded-[26px] p-3">
        <div className="relative">
          {filteredChatSlashCommands.length > 0 ? (
            <ComposerSlashMenu
              items={filteredChatSlashCommands}
              selectedIndex={Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)}
              onSelect={acceptChatSlashCommand}
            />
          ) : filteredChatMentionTargets.length > 0 ? (
            <ComposerMentionMenu
              items={filteredChatMentionTargets}
              selectedIndex={Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)}
              onSelect={acceptChatMentionTarget}
            />
          ) : null}
          <div
            className={cn(
              'app-composer-input rounded-[18px] transition',
              chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
            )}
          >
            <input
              ref={chatAttachmentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void saveDesktopAttachments(files);
                event.currentTarget.value = '';
              }}
            />
            {activeChatQuote ? (
              <ComposerQuotePreview quote={activeChatQuote} onClear={onClearChatQuote} />
            ) : null}
            <ComposerAttachmentList
              chatComposerAttachments={chatComposerAttachments}
              removeChatComposerAttachment={removeChatComposerAttachment}
            />
            <textarea
              rows={1}
              value={chatComposerText}
              onPointerDownCapture={() => {
                focusComposerTextareaForNativeInput(
                  CHAT_COMPOSER_TEXTAREA_SELECTOR,
                  display.isNativeShell,
                );
              }}
              onFocus={() => {
                focusComposerTextareaForNativeInput(
                  CHAT_COMPOSER_TEXTAREA_SELECTOR,
                  display.isNativeShell,
                );
              }}
              onChange={(event) => updateChatComposerDraft(event.target.value, event.target)}
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
              onCompositionStart={imeCompositionGuard.onCompositionStart}
              onCompositionEnd={imeCompositionGuard.onCompositionEnd}
              onKeyDown={(event) => {
                if (imeCompositionGuard.isComposingKeyDown(event)) return;
                if (filteredChatSlashCommands.length > 0) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setChatSlashMenuIndex((current) => (
                      current + delta + filteredChatSlashCommands.length
                    ) % filteredChatSlashCommands.length);
                    return;
                  }
                  if (
                    (event.key === 'Enter'
                      && !event.metaKey
                      && !event.ctrlKey
                      && !event.shiftKey)
                    || event.key === 'Tab'
                  ) {
                    event.preventDefault();
                    acceptChatSlashCommand(
                      filteredChatSlashCommands[
                        Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)
                      ]?.value ?? filteredChatSlashCommands[0].value,
                    );
                    return;
                  }
                }
                if (filteredChatMentionTargets.length > 0) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopPropagation();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setChatSlashMenuIndex((current) => (
                      current + delta + filteredChatMentionTargets.length
                    ) % filteredChatMentionTargets.length);
                    return;
                  }
                  if (
                    ((event.key === 'Enter'
                      && !event.metaKey
                      && !event.ctrlKey
                      && !event.shiftKey)
                      || event.key === 'Tab')
                    && !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    acceptChatMentionTarget(
                      filteredChatMentionTargets[
                        Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)
                      ]?.value ?? filteredChatMentionTargets[0].value,
                    );
                    return;
                  }
                }
                if (event.key === 'Escape' && filteredChatSlashCommands.length > 0) {
                  event.preventDefault();
                  setChatComposerText('/');
                  return;
                }
                if (event.key === 'Escape' && filteredChatMentionTargets.length > 0) {
                  event.preventDefault();
                  setChatComposerText(chatComposerText.replace(/(^|\s)@([^\s@]*)$/, '$1'));
                  return;
                }
                if (
                  event.key === 'Enter'
                  && !event.metaKey
                  && !event.ctrlKey
                  && !event.shiftKey
                ) {
                  event.preventDefault();
                  onSend(event.currentTarget.value);
                }
              }}
              className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              data-composer-scope="chat"
              placeholder={display.placeholder}
            />
          </div>
        </div>
        <div
          ref={composerControlsRef}
          className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5"
        >
          <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
            {useCompactRouteMenu ? (
              <CompactComposerModelMenu
                scope="chat"
                selection={
                  collaborationRouting.enabled && collaborationRouting.model
                    ? collaborationRouting.model.selection
                    : composerSelection
                }
                providerOptions={composerProviderOptions}
                modelOptions={chatModelOptions && chatModelOptions.length > 0
                  ? chatModelOptions
                  : undefined}
                onSave={collaborationRouting.onSaveCompact}
              />
            ) : null}
            <Button
              size="icon"
              variant="quiet"
              className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
              onClick={() => chatAttachmentInputRef.current?.click()}
              title="Add attachment"
              aria-label="Add attachment"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
          <div
            className={cn(
              'flex min-w-0 items-center overflow-visible',
              display.showCompanionPane ? 'shrink gap-2' : 'shrink-0 gap-3',
            )}
          >
            {localRouting.paneKind === 'agent'
              && !collaborationRouting.enabled
              && (display.isNativeShell || localRouting.contextStatus) ? (
                <ComposerRuntimeStatus
                  contextStatus={localRouting.contextStatus}
                  cacheText={localRouting.cacheText}
                />
              ) : null}
            {localRouting.paneKind === 'agent'
              && !collaborationRouting.enabled
              && !useCompactRouteMenu ? (
                <ComposerModelControls
                  scope="chat"
                  selection={composerSelection}
                  openSelector={openComposerSelector}
                  onToggleSelector={toggleComposerSelector}
                  onSelectValue={(scope, type, value) => {
                    void selectComposerValue(scope, type, value, localRouting.configTarget);
                  }}
                  authLabel={composerAuthLabel}
                  authOptions={composerAuthOptions}
                  onSelectAuthChoice={(scope, providerId, choice) => {
                    void selectComposerAuthChoice(
                      scope,
                      providerId,
                      choice,
                      localRouting.configTarget,
                    );
                  }}
                  onSelectProviderChoice={(scope, option) => {
                    void selectComposerProviderChoice(scope, option, localRouting.configTarget);
                  }}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0
                    ? chatModelOptions
                    : undefined}
                  compact={display.showCompanionPane}
                />
              ) : collaborationRouting.enabled
                && !useCompactRouteMenu
                && collaborationRouting.model ? (
                  <CollaborationRoutingControls
                    model={collaborationRouting.model}
                    menu={{
                      openSelector: openComposerSelector,
                      agentSelectorOpen: collaborationRouting.agentSelectorOpen,
                      compact: display.showCompanionPane,
                    }}
                    options={{
                      authLabel: composerAuthLabel,
                      authOptions: composerAuthOptions,
                      providerOptions: composerProviderOptions,
                      modelOptions: chatModelOptions,
                    }}
                    actions={{
                      toggleSelector: toggleComposerSelector,
                      onSelectAgent: collaborationRouting.onSelectAgent,
                      onUpdate: collaborationRouting.onUpdate,
                      defaultThinkingForModel: collaborationRouting.defaultThinkingForModel,
                    }}
                  />
                ) : null}
            <Button
              className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
              onClick={() => onSend()}
              disabled={false}
              title={display.activeLiveTurnIsRunning
                ? 'Queue message for this session'
                : 'Send message'}
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
