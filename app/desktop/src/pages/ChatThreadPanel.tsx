import { useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import { insertEmojiAtSelection } from '@/features/emoji/emojiText';
import { ComposerExpressivePicker } from '@/features/emoji/ComposerExpressivePicker';
import type { MessageThread } from '@/features/chat/messageThreads';
import { insertMentionIntoDraft } from '@/features/chat/messageActions/mentions';
import type { Conversation, DesktopChatTurnSnapshot, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { CompactComposerModelMenu, ComposerMentionMenu, type ComposerMentionOption } from '@/kordi-app/components';
import { ComposerAttachmentAddMenu, ComposerAttachmentList } from '@/kordi-app/components/composerAttachments';
import { useVoiceComposer } from '@/pages/chatsPage.voiceComposer';
import { VoiceComposerControls, VoiceRecordingSurface } from '@/pages/chatsPage.voiceControls';
import { chatTranscriptDensityMode } from '@/pages/chatsPage.model';
import { ChatSessionPane } from '@/pages/chatsPage.sessionPane';
import type { ChatSessionPaneActions } from '@/pages/chatsPage.types';

export function ChatThreadPanel({
  conversation,
  thread,
  replyCount,
  liveTurn,
  liveTurnSender,
  actions,
  onClose,
  onSendStart,
  onSendSettled,
  onSend,
  saveAttachments,
  removeStagedAttachment,
  accountId,
  queuedMessages,
  onCancelQueuedMessage,
  width,
  onWidthChange,
  compactModelMenu,
  chatMentionTargetsForText,
}: {
  conversation: Conversation;
  thread: MessageThread;
  replyCount: number;
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnSender: string;
  actions: ChatSessionPaneActions;
  onClose: () => void;
  onSendStart: () => void;
  onSendSettled: () => void;
  onSend: (text: string, attachments?: AttachmentItem[]) => Promise<void> | void;
  saveAttachments: (files: File[]) => Promise<AttachmentItem[]>;
  removeStagedAttachment: (id: string) => void;
  accountId?: string | null;
  queuedMessages: QueuedDesktopChatMessage[];
  onCancelQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
  compactModelMenu: Omit<ComponentProps<typeof CompactComposerModelMenu>, 'scope'>;
  chatMentionTargetsForText: (text: string) => ComposerMentionOption[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const rootId = thread.root.id?.trim() || thread.root.entryId?.trim() || '';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachmentsByRoot, setAttachmentsByRoot] = useState<Record<string, AttachmentItem[]>>({});
  const [mentionIndex, setMentionIndex] = useState(0);
  const draft = drafts[rootId] ?? '';
  const attachments = attachmentsByRoot[rootId] ?? [];
  const mentionTargets = useMemo(
    () => chatMentionTargetsForText(draft),
    [chatMentionTargetsForText, draft],
  );
  const messages = useMemo(
    () => [{ ...thread.root, threadSummary: undefined }, ...thread.replies],
    [thread],
  );
  const voice = useVoiceComposer({
    conversation,
    cloudAccountId: accountId ?? null,
    onSend: (text, voiceAttachments) => sendThread(text ?? '', voiceAttachments),
    focusComposer: () => textareaRef.current?.focus(),
  });
  useEffect(() => () => resizeCleanupRef.current(), []);
  async function sendThread(text: string, nextAttachments?: AttachmentItem[]) {
    onSendStart();
    try {
      await onSend(text, nextAttachments);
    } finally {
      onSendSettled();
    }
  }
  const send = async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDrafts((current) => ({ ...current, [rootId]: '' }));
    setAttachmentsByRoot((current) => ({ ...current, [rootId]: [] }));
    try {
      await sendThread(text, attachments);
    } catch {
      setDrafts((current) => current[rootId] ? current : ({ ...current, [rootId]: draft }));
      setAttachmentsByRoot((current) => current[rootId]?.length ? current : ({ ...current, [rootId]: attachments }));
    }
  };
  const acceptMention = (value: string) => {
    const nextDraft = insertMentionIntoDraft(draft, value);
    setDrafts((current) => ({ ...current, [rootId]: nextDraft }));
    setMentionIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const addAttachments = async (files: File[]) => {
    const saved = await saveAttachments(files);
    saved.forEach((attachment) => removeStagedAttachment(attachment.id));
    setAttachmentsByRoot((current) => ({
      ...current,
      [rootId]: [...(current[rootId] ?? []), ...saved],
    }));
  };
  const editQueuedMessage = (sessionId: string, queuedMessageId: string) => {
    const queued = queuedMessages.find((message) => message.id === queuedMessageId);
    if (!queued) return;
    setDrafts((current) => ({ ...current, [rootId]: queued.text }));
    setAttachmentsByRoot((current) => ({ ...current, [rootId]: queued.attachments }));
    onCancelQueuedMessage(sessionId, queuedMessageId);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (nextEvent: PointerEvent) => {
      onWidthChange(Math.min(640, Math.max(304, startWidth + startX - nextEvent.clientX)));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      resizeCleanupRef.current = () => {};
    };
    resizeCleanupRef.current();
    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  return (
    <aside className="app-thread-panel relative flex h-full min-w-[19rem] max-w-[40rem] shrink-0 flex-col border-l border-[color:var(--app-divider)] bg-[color:var(--app-main-bg)]" style={{ width }} aria-label="Message thread">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize thread panel"
        aria-valuemin={304}
        aria-valuemax={640}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        className="group absolute inset-y-0 left-0 z-20 w-3 -translate-x-1.5 cursor-col-resize touch-none focus-visible:outline-none"
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          onWidthChange(Math.min(640, Math.max(304, width + (event.key === 'ArrowLeft' ? 16 : -16))));
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--app-divider)] transition group-hover:bg-[color:var(--app-sidebar-accent)] group-focus-visible:bg-[color:var(--app-sidebar-accent)]" aria-hidden="true" />
      </div>
      <header className="app-page-header app-chat-pane-header relative flex shrink-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="app-page-header-title-row app-chat-pane-title-row flex items-center">
            <h2 className="truncate text-[17px] font-semibold text-[color:var(--utility-foreground)]">Thread</h2>
          </div>
          <p className="text-[11px] leading-5 text-[color:var(--utility-muted-text)]">{replyCount} discussed in thread</p>
        </div>
        <button type="button" className="app-button-quiet grid h-9 w-9 place-items-center rounded-full" onClick={onClose} aria-label="Close thread">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <ChatSessionPane
        presentation={{
          liveTurn,
          liveTurnSender,
          shouldRenderLiveTurn: Boolean(liveTurn && !liveTurn.completed),
          densityMode: chatTranscriptDensityMode(conversation),
        }}
        actions={actions}
        selection={{}}
        viewport={{
          sessionKey: `${conversation.id}:thread:${rootId}`,
          messages,
          scrollRef,
          scrollClassName: 'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain px-1',
          queuedMessages,
          onEditQueuedMessage: editQueuedMessage,
          onCancelQueuedMessage,
          composer: (
            <div className="shrink-0 px-3 pb-4 pt-3">
              <div className="app-composer-shell relative rounded-[26px] p-3">
                <ComposerMentionMenu
                  items={mentionTargets}
                  selectedIndex={Math.min(mentionIndex, mentionTargets.length - 1)}
                  onSelect={acceptMention}
                />
                <div className="app-composer-input rounded-[18px] px-4 py-2.5 transition">
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length > 0) void addAttachments(files);
                      event.currentTarget.value = '';
                    }}
                  />
                  {voice.surfaceActive ? <VoiceRecordingSurface voice={voice} /> : <>
                    <ComposerAttachmentList
                      attachments={attachments}
                      onRemove={(id) => setAttachmentsByRoot((current) => ({
                        ...current,
                        [rootId]: (current[rootId] ?? []).filter((attachment) => attachment.id !== id),
                      }))}
                      onUpdate={(id, update) => setAttachmentsByRoot((current) => ({
                        ...current,
                        [rootId]: (current[rootId] ?? []).map((attachment) => (
                          attachment.id === id ? { ...attachment, ...update } : attachment
                        )),
                      }))}
                    />
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) => setDrafts((current) => ({ ...current, [rootId]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (mentionTargets.length > 0) {
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            setMentionIndex((current) => (
                              current + (event.key === 'ArrowDown' ? 1 : -1) + mentionTargets.length
                            ) % mentionTargets.length);
                            return;
                          }
                          if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                            event.preventDefault();
                            acceptMention(mentionTargets[Math.min(mentionIndex, mentionTargets.length - 1)]?.value ?? mentionTargets[0].value);
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setDrafts((current) => ({ ...current, [rootId]: draft.replace(/(^|\s)@([^\s@]*)$/, '$1') }));
                            return;
                          }
                        }
                        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        void send();
                      }}
                      rows={1}
                      className="min-h-6 max-h-40 w-full resize-none bg-transparent text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                      placeholder="Reply in thread…"
                      aria-label="Reply in thread"
                    />
                  </>}
                </div>
                <div className={voice.surfaceActive ? 'hidden' : 'app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5'}>
                  <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
                    <CompactComposerModelMenu scope="chat" {...compactModelMenu} />
                    {!voice.recording ? <ComposerAttachmentAddMenu inputRef={inputRef} /> : null}
                    {!voice.recording ? <ComposerExpressivePicker
                      accountId={accountId}
                      captureSelection={() => ({
                        start: textareaRef.current?.selectionStart ?? draft.length,
                        end: textareaRef.current?.selectionEnd ?? draft.length,
                      })}
                      onSelectText={(value, selection) => {
                        const insertion = insertEmojiAtSelection(draft, value, selection);
                        setDrafts((current) => ({ ...current, [rootId]: insertion.value }));
                        requestAnimationFrame(() => {
                          textareaRef.current?.focus();
                          textareaRef.current?.setSelectionRange(insertion.selection.start, insertion.selection.end);
                        });
                      }}
                      onSendMedia={(attachment) => { void sendThread('', [attachment]).catch(() => undefined); }}
                    /> : null}
                  </div>
                  <VoiceComposerControls
                    voice={voice}
                    hasSendableDraft={Boolean(draft.trim() || attachments.length)}
                    validationError={null}
                    activeLiveTurnIsRunning={false}
                    onSend={() => { void send(); }}
                  />
                </div>
              </div>
            </div>
          ),
        }}
      />
    </aside>
  );
}
