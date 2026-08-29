import { useId, useRef, useState } from 'react';
import type { AttachmentItem, ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { useImeCompositionGuard } from '@/features/chat/imeComposition';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { ComposerExpressivePicker } from '@/features/emoji/ComposerExpressivePicker';
import { insertEmojiAtSelection } from '@/features/emoji/emojiText';
import { MEME_IMAGE_ACCEPT, memeAttachmentDraftError } from '@/features/chat/memeAttachments';
import {
  CompactComposerModelMenu,
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  type CompactComposerModelMenuSaveInput,
} from '@/kordi-app/components';
import { ComposerAttachmentAddMenu, ComposerAttachmentList } from '@/kordi-app/components/composerAttachments';
import type { Conversation, DesktopChatContextWindowStatus } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { ComposerDropSurface } from './chatsPage.composerDropSurface';
import {
  CollaborationRoutingControls,
  type CollaborationRoutingControlsModel,
  type CollaborationRoutingPatch,
} from '@/pages/chatsPage.collaborationRoutingControls';
import {
  ComposerQuotePreview,
  MessageSelectionBar,
} from '@/pages/chatsPage.composerPrimitives';
import {
  canConfigureConversationModelRoute,
  shouldUseCompactModelRouteMenu,
} from '@/pages/chatsPage.header';
import type {
  ChatsPageComposer,
  ChatsPageRuntime,
} from '@/pages/chatsPage.types';
import { useVoiceComposer } from './chatsPage.voiceComposer';
import { VoiceComposerControls, VoiceRecordingSurface } from './chatsPage.voiceControls';
import { useVideoMessageRecorder } from '@/features/chat/useVideoMessageRecorder';
import { isMp4VideoAttachment } from '@/features/chat/attachmentMediaGallery';
import { discardDesktopChatAttachment } from '@/lib/desktopAttachmentStream';
import {
  VideoAttachmentReviewSurface,
  VideoRecordingSurface,
} from './chatsPage.videoComposer';

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
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  cloudAccountId?: string | null;
};

export function MainComposer({
  conversation,
  composer,
  runtime,
  localRouting,
  collaborationRouting,
  display,
  onSend,
  cloudAccountId = null,
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
    updateChatComposerAttachment,
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const memeAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [pastedImageEditId, setPastedImageEditId] = useState<string | null>(null);
  const [attachedVideoReviewQueue, setAttachedVideoReviewQueue] = useState<AttachmentItem[]>([]);
  const memeValidationMessageId = useId();
  const memeValidationError = memeAttachmentDraftError(chatComposerAttachments);
  const hasSendableDraft = Boolean(chatComposerText.trim() || chatComposerAttachments.length > 0);
  const canConfigureModelRoute = canConfigureConversationModelRoute(conversation);
  const useCompactRouteMenu = canConfigureModelRoute
    && shouldUseCompactModelRouteMenu(conversation);
  const voice = useVoiceComposer({
    conversation,
    cloudAccountId,
    onSend,
    focusComposer: () => textareaRef.current?.focus(),
  });
  const voiceSurfaceActive = voice.surfaceActive;
  const video = useVideoMessageRecorder({
    conversationId: conversation.id,
    onSend,
    focusComposer: () => textareaRef.current?.focus(),
  });
  const attachedVideoReview = attachedVideoReviewQueue[0] ?? null;
  const mediaSurfaceActive = voiceSurfaceActive || video.surfaceActive || Boolean(attachedVideoReview);

  function stageVideoReviews(pendingAttachments: Promise<AttachmentItem[]>) {
    void pendingAttachments.then((saved) => {
      const videos = saved.filter(isMp4VideoAttachment);
      for (const attachment of videos) removeChatComposerAttachment(attachment.id);
      if (videos.length > 0) {
        setAttachedVideoReviewQueue((current) => {
          const paths = new Set(current.map((attachment) => attachment.path));
          return [...current, ...videos.filter((attachment) => !paths.has(attachment.path))];
        });
      }
    });
    return pendingAttachments;
  }

  function cancelAttachedVideoReview() {
    if (!attachedVideoReview) return;
    setAttachedVideoReviewQueue((current) => current.slice(1));
    void discardDesktopChatAttachment(attachedVideoReview.path).catch(() => undefined);
  }

  function sendAttachedVideoReview(preparedAttachment: AttachmentItem, caption: string) {
    if (!attachedVideoReview) return;
    try {
      const result = onSend(caption, [preparedAttachment]);
      setAttachedVideoReviewQueue((current) => current.slice(1));
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Keep the review open when sending could not start.
    }
  }

  function openPastedImageEditor(pendingAttachments: Promise<AttachmentItem[]>) {
    void pendingAttachments.then((saved) => {
      const image = saved.find((attachment) => attachment.kind === 'image');
      if (image) setPastedImageEditId(image.id);
    });
  }

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
      <ComposerDropSurface saveDesktopAttachments={(files) => (
        stageVideoReviews(saveDesktopAttachments(files))
      )}>
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
                if (files.length > 0) void stageVideoReviews(saveDesktopAttachments(files));
                event.currentTarget.value = '';
              }}
            />
            <input
              ref={memeAttachmentInputRef}
              type="file"
              multiple
              accept={MEME_IMAGE_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void saveDesktopAttachments(files, { subtype: 'meme' });
                event.currentTarget.value = '';
              }}
            />
            {activeChatQuote ? (
              <ComposerQuotePreview quote={activeChatQuote} onClear={onClearChatQuote} />
            ) : null}
            <ComposerAttachmentList
              attachments={chatComposerAttachments}
              onRemove={removeChatComposerAttachment}
              onUpdate={updateChatComposerAttachment}
              onReplace={updateChatComposerAttachment}
              requestedEditAttachmentId={pastedImageEditId}
              onRequestedEditClosed={() => setPastedImageEditId(null)}
            />
            {memeValidationError ? (
              <p
                id={memeValidationMessageId}
                className="px-0.5 pb-1 text-[10.5px] leading-4 text-amber-500"
                role="status"
              >
                {memeValidationError}
              </p>
            ) : null}
            {attachedVideoReview ? (
              <VideoAttachmentReviewSurface
                attachment={attachedVideoReview}
                onCancel={cancelAttachedVideoReview}
                onSend={sendAttachedVideoReview}
              />
            ) : video.surfaceActive ? (
              <VideoRecordingSurface video={video} />
            ) : voiceSurfaceActive ? (
              <VoiceRecordingSurface voice={voice} />
            ) : <div className="flex min-w-0">
              <textarea
                ref={textareaRef}
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
                    openPastedImageEditor(stageVideoReviews(saveDesktopAttachments(files)));
                    return;
                  }
                  const pastedPaths = extractPastedLocalFilePaths(
                    event.clipboardData.getData('text/plain'),
                    event.clipboardData.getData('text/uri-list'),
                  );
                  if (pastedPaths.length > 0) {
                    event.preventDefault();
                    openPastedImageEditor(stageVideoReviews(saveDesktopAttachmentPaths(pastedPaths)));
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
                    void onSend(event.currentTarget.value);
                  }
                }}
                className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                data-composer-scope="chat"
                aria-describedby={memeValidationError ? memeValidationMessageId : undefined}
                placeholder={display.placeholder}
              />
            </div>}
          </div>
        </div>
        <div
          ref={composerControlsRef}
          className={cn(
            'app-composer-meta mt-2 items-center justify-between gap-4 pt-2.5',
            mediaSurfaceActive ? 'hidden' : 'flex',
          )}
        >
          <div
            className="flex shrink-0 items-center gap-2 overflow-visible pr-1"
            data-composer-left-actions="true"
          >
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
            {!voiceSurfaceActive ? <ComposerAttachmentAddMenu
              inputRef={chatAttachmentInputRef}
              memeInputRef={memeAttachmentInputRef}
              onChooseFiles={display.isNativeShell
                ? () => { void stageVideoReviews(saveDesktopAttachmentPaths()); }
                : undefined}
              onRecordVideo={() => { void video.start(); }}
              disabled={voice.recording}
            /> : null}
            {!voiceSurfaceActive ? <ComposerExpressivePicker
              key={cloudAccountId?.trim() || 'local'}
              accountId={cloudAccountId}
              captureSelection={() => ({
                start: textareaRef.current?.selectionStart ?? chatComposerText.length,
                end: textareaRef.current?.selectionEnd ?? chatComposerText.length,
              })}
              onSelectText={(value, selection) => {
                const insertion = insertEmojiAtSelection(chatComposerText, value, selection);
                setChatComposerText(insertion.value);
                window.requestAnimationFrame(() => {
                  const textarea = textareaRef.current;
                  if (!textarea) return;
                  textarea.focus();
                  textarea.setSelectionRange(
                    insertion.selection.start,
                    insertion.selection.end,
                  );
                });
              }}
              onSendMedia={(attachment) => onSend('', [attachment])}
            /> : null}
          </div>
          <div
            className={cn(
              'flex min-w-0 items-center overflow-visible',
              display.showCompanionPane ? 'shrink gap-2' : 'shrink-0 gap-3',
            )}
          >
            {!voiceSurfaceActive && localRouting.paneKind === 'agent'
              && !collaborationRouting.enabled
              && (display.isNativeShell || localRouting.contextStatus) ? (
                <ComposerRuntimeStatus
                  contextStatus={localRouting.contextStatus}
                  cacheText={localRouting.cacheText}
                />
              ) : null}
            {!voiceSurfaceActive && canConfigureModelRoute
              && localRouting.paneKind === 'agent'
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
              ) : !voiceSurfaceActive && canConfigureModelRoute
                && collaborationRouting.enabled
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
            <VoiceComposerControls
              voice={voice}
              hasSendableDraft={hasSendableDraft}
              validationError={memeValidationError}
              activeLiveTurnIsRunning={display.activeLiveTurnIsRunning}
              onSend={() => { void onSend(); }}
            />
          </div>
        </div>
      </ComposerDropSurface>
    </div>
  );
}
