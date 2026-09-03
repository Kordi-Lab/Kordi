import { useId, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { useImeCompositionGuard } from '@/features/chat/imeComposition';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { ComposerExpressivePicker } from '@/features/emoji/ComposerExpressivePicker';
import {
  BlobEmojiComposerInput,
  type BlobEmojiComposerInputHandle,
} from '@/features/emoji/BlobEmojiComposerInput';
import { blobEmojiComposerValue } from '@/features/emoji/blobEmojiComposerDom';
import { insertEmojiAtSelection } from '@/features/emoji/emojiText';
import { memeAttachmentDraftError } from '@/features/chat/memeAttachments';
import {
  CompactComposerModelMenu,
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
} from '@/kordi-app/components';
import { ComposerAttachmentAddMenu, ComposerAttachmentList } from '@/kordi-app/components/composerAttachments';
import { cn } from '@/lib/utils';
import { ComposerDropSurface } from './chatsPage.composerDropSurface';
import { CollaborationRoutingControls } from '@/pages/chatsPage.collaborationRoutingControls';
import {
  ComposerQuotePreview,
  ComposerEditPreview,
  MessageSelectionBar,
} from '@/pages/chatsPage.composerPrimitives';
import {
  canConfigureConversationModelRoute,
  shouldUseCompactModelRouteMenu,
} from '@/pages/chatsPage.header';
import { useVoiceComposer } from './chatsPage.voiceComposer';
import { VoiceComposerControls, VoiceRecordingSurface } from './chatsPage.voiceControls';
import { useVideoMessageRecorder } from '@/features/chat/useVideoMessageRecorder';
import {
  VideoAttachmentReviewSurface,
  VideoRecordingSurface,
} from './chatsPage.videoComposer';
import { useAttachedVideoReviews } from './chatsPage.videoAttachmentReviews';
import { useComposerMentionMenu } from './useComposerReferenceOptions';
import type { MainComposerProps } from './chatsPage.mainComposer.types';

export type { MainComposerProps } from './chatsPage.mainComposer.types';

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
    chatMentionTargetsForText,
    chatSlashMenuIndex,
    setChatSlashMenuIndex,
    acceptChatSlashCommand,
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
    activeMessageEdit, messageEditBusy = false, messageEditError,
    updateMessageEditText, cancelMessageEdit, saveMessageEdit,
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
  const composerInputRef = useRef<BlobEmojiComposerInputHandle | null>(null);
  const [pastedImageEditId, setPastedImageEditId] = useState<string | null>(null);
  const memeValidationMessageId = useId();
  const editErrorMessageId = useId();
  const memeValidationError = memeAttachmentDraftError(chatComposerAttachments);
  const editingMessage = Boolean(activeMessageEdit);
  const composerText = activeMessageEdit?.text ?? chatComposerText;
  const {
    menuId: mentionMenuId,
    items: filteredChatMentionTargets,
    activeIndex: chatMentionIndex,
    activeDescendant: chatMentionActiveDescendant,
    change: updateMentionCursor,
    select: acceptMentionTarget,
    handleKeyDown: handleMentionKeyDown,
  } = useComposerMentionMenu({
    text: composerText,
    resetKey: conversation.id,
    enabled: !editingMessage,
    isNativeShell: display.isNativeShell,
    rootPath: conversation.localSessionCwd,
    targetsForText: chatMentionTargetsForText,
    onTextChange: setChatComposerText,
    onPickFile: () => chatAttachmentInputRef.current?.click(),
    onAttachPath: (path) => { void saveDesktopAttachmentPaths([path]); },
    onFocus: (cursor) => composerInputRef.current?.focus({ start: cursor, end: cursor }),
    selectedIndex: chatSlashMenuIndex,
    setSelectedIndex: setChatSlashMenuIndex,
  });
  const hasSendableDraft = Boolean(composerText.trim() || (!editingMessage && chatComposerAttachments.length > 0));
  const canSaveEdit = Boolean(
    activeMessageEdit
    && activeMessageEdit.text.trim()
    && activeMessageEdit.text !== activeMessageEdit.originalText
    && !messageEditBusy,
  );
  const canConfigureModelRoute = canConfigureConversationModelRoute(conversation);
  const useCompactRouteMenu = canConfigureModelRoute
    && shouldUseCompactModelRouteMenu(conversation);
  const voice = useVoiceComposer({
    conversation,
    cloudAccountId,
    onSend,
    focusComposer: () => composerInputRef.current?.focus(),
  });
  const voiceSurfaceActive = voice.surfaceActive;
  const video = useVideoMessageRecorder({
    conversationId: conversation.id,
    onSend,
    focusComposer: () => composerInputRef.current?.focus(),
  });
  const videoReviews = useAttachedVideoReviews({
    onSend,
    onRemoveAttachment: removeChatComposerAttachment,
  });
  const attachedVideoReview = videoReviews.current;
  const mediaSurfaceActive = voiceSurfaceActive || video.surfaceActive || Boolean(attachedVideoReview);

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
      <ComposerDropSurface disabled={editingMessage} saveDesktopAttachments={(files) => (
        videoReviews.stage(saveDesktopAttachments(files))
      )}>
        <div className="relative">
          {!editingMessage && filteredChatSlashCommands.length > 0 ? (
            <ComposerSlashMenu
              items={filteredChatSlashCommands}
              selectedIndex={Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)}
              onSelect={acceptChatSlashCommand}
            />
          ) : !editingMessage && filteredChatMentionTargets.length > 0 ? (
            <ComposerMentionMenu
              id={mentionMenuId}
              items={filteredChatMentionTargets}
              selectedIndex={chatMentionIndex}
              onSelect={acceptMentionTarget}
            />
          ) : null}
          <div
            className={cn(
              'app-composer-input rounded-[18px] transition',
              !editingMessage && chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
            )}
          >
            <input
              ref={chatAttachmentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void videoReviews.stage(saveDesktopAttachments(files));
                event.currentTarget.value = '';
              }}
            />
            {activeMessageEdit ? (
              <ComposerEditPreview text={activeMessageEdit.originalText} onCancel={cancelMessageEdit} />
            ) : activeChatQuote ? (
              <ComposerQuotePreview quote={activeChatQuote} onClear={onClearChatQuote} />
            ) : null}
            {!editingMessage ? <ComposerAttachmentList
              attachments={chatComposerAttachments}
              onRemove={removeChatComposerAttachment}
              onUpdate={updateChatComposerAttachment}
              onReplace={updateChatComposerAttachment}
              requestedEditAttachmentId={pastedImageEditId}
              onRequestedEditClosed={() => setPastedImageEditId(null)}
            /> : null}
            {!editingMessage && memeValidationError ? (
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
                onCancel={videoReviews.cancel}
                onSend={videoReviews.send}
              />
            ) : video.surfaceActive ? (
              <VideoRecordingSurface video={video} />
            ) : voiceSurfaceActive ? (
              <VoiceRecordingSurface voice={voice} />
            ) : <div className="flex min-w-0">
              <BlobEmojiComposerInput
                ref={composerInputRef}
                value={composerText}
                readOnly={editingMessage && messageEditBusy}
                ariaBusy={editingMessage && messageEditBusy}
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
                onChange={(value, target) => {
                  updateMentionCursor(composerInputRef.current?.selection().end ?? value.length);
                  if (editingMessage) updateMessageEditText?.(value);
                  else updateChatComposerDraft(value, target);
                }}
                onPaste={(event) => {
                  if (editingMessage) return;
                  const files = extractClipboardFiles(event.clipboardData);
                  if (files.length > 0) {
                    event.preventDefault();
                    openPastedImageEditor(videoReviews.stage(saveDesktopAttachments(files)));
                    return;
                  }
                  const pastedPaths = extractPastedLocalFilePaths(
                    event.clipboardData.getData('text/plain'),
                    event.clipboardData.getData('text/uri-list'),
                  );
                  if (pastedPaths.length > 0) {
                    event.preventDefault();
                    openPastedImageEditor(videoReviews.stage(saveDesktopAttachmentPaths(pastedPaths)));
                  }
                }}
                onCompositionStart={imeCompositionGuard.onCompositionStart}
                onCompositionEnd={imeCompositionGuard.onCompositionEnd}
                onKeyDown={(event) => {
                  if (imeCompositionGuard.isComposingKeyDown(event)) return;
                  if (event.key === 'Escape' && editingMessage) {
                    event.preventDefault();
                    cancelMessageEdit?.();
                    return;
                  }
                  if (!editingMessage && filteredChatSlashCommands.length > 0) {
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
                  if (!editingMessage && handleMentionKeyDown(event)) return;
                  if (!editingMessage && event.key === 'Escape' && filteredChatSlashCommands.length > 0) {
                    event.preventDefault();
                    setChatComposerText('/');
                    return;
                  }
                  if (
                    event.key === 'Enter'
                    && !event.metaKey
                    && !event.ctrlKey
                    && !event.shiftKey
                  ) {
                    event.preventDefault();
                    if (editingMessage) void saveMessageEdit?.();
                    else void onSend(blobEmojiComposerValue(event.currentTarget));
                  }
                }}
                className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                ariaDescribedBy={messageEditError ? editErrorMessageId : memeValidationError ? memeValidationMessageId : undefined}
                ariaControls={filteredChatMentionTargets.length > 0 ? mentionMenuId : undefined}
                ariaExpanded={filteredChatMentionTargets.length > 0}
                ariaActiveDescendant={chatMentionActiveDescendant}
                placeholder={editingMessage ? 'Edit message' : display.placeholder}
              />
            </div>}
            {messageEditError ? (
              <p id={editErrorMessageId} className="app-error-text mt-1 text-[11px] leading-4 text-rose-500" role="alert">
                {messageEditError}
              </p>
            ) : null}
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
            {!editingMessage && useCompactRouteMenu ? (
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
            {!editingMessage && !voiceSurfaceActive ? <ComposerAttachmentAddMenu
              inputRef={chatAttachmentInputRef}
              onRecordVideo={() => { void video.start(); }}
              disabled={voice.recording}
            /> : null}
            {!editingMessage && !voiceSurfaceActive ? <ComposerExpressivePicker
              key={cloudAccountId?.trim() || 'local'}
              accountId={cloudAccountId}
              captureSelection={() => composerInputRef.current?.selection() ?? ({
                start: chatComposerText.length,
                end: chatComposerText.length,
              })}
              onSelectText={(value, selection) => {
                const insertion = insertEmojiAtSelection(chatComposerText, value, selection);
                setChatComposerText(insertion.value);
                window.requestAnimationFrame(() => {
                  composerInputRef.current?.focus(insertion.selection);
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
            {!editingMessage && !voiceSurfaceActive && localRouting.paneKind === 'agent'
              && !collaborationRouting.enabled
              && (display.isNativeShell || localRouting.contextStatus) ? (
                <ComposerRuntimeStatus
                  contextStatus={localRouting.contextStatus}
                  cacheText={localRouting.cacheText}
                />
              ) : null}
            {!editingMessage && !voiceSurfaceActive && canConfigureModelRoute
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
              ) : !editingMessage && !voiceSurfaceActive && canConfigureModelRoute
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
            {editingMessage ? (
              <Button
                className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                onClick={() => { void saveMessageEdit?.(); }}
                disabled={!canSaveEdit}
                aria-label="Save message edit"
                title="Save message edit"
              >
                {messageEditBusy
                  ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <Check className="h-4 w-4" aria-hidden="true" />}
              </Button>
            ) : <VoiceComposerControls
              voice={voice}
              hasSendableDraft={hasSendableDraft}
              validationError={memeValidationError}
              activeLiveTurnIsRunning={display.activeLiveTurnIsRunning}
              onSend={() => { void onSend(); }}
            />}
          </div>
        </div>
      </ComposerDropSurface>
    </div>
  );
}
