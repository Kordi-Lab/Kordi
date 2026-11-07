import {refreshThreadAttention} from '@/features/cloud/threadAttention';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import { insertEmojiAtSelection } from '@/features/emoji/emojiText';
import { ComposerExpressivePicker } from '@/features/emoji/ComposerExpressivePicker';
import type { MessageThread } from '@/features/chat/messageThreads';
import {threadReadKey, threadUnreadMarkerMessageId} from '@/features/chat/threadReadState';
import type { Conversation, DesktopChatTurnSnapshot, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { CompactComposerModelMenu, ComposerMentionMenu, type ComposerMentionOption } from '@/kordi-app/components';
import { ComposerAttachmentAddMenu, ComposerAttachmentList } from '@/kordi-app/components/composerAttachments';
import { useVoiceComposer } from '@/pages/chatsPage.voiceComposer';
import { VoiceComposerControls } from '@/pages/chatsPage.voiceControls';
import { chatTranscriptDensityMode } from '@/pages/chatsPage.model';
import { ChatSessionPane } from '@/pages/chatsPage.sessionPane';
import type { ChatSessionPaneActions } from '@/pages/chatsPage.types';
import { useComposerMentionMenu } from '@/pages/useComposerReferenceOptions';

/** The open message discussion, shown as the side panel's Discussion tab. The
 * tab strip supplies its title, close control and width. */
export function ChatThreadPanel({
  conversation,
  thread,
  navigationMessageId,firstUnreadMessageId,nextAfterSequence,onLoadMore,
  liveTurn,
  liveTurnSender,
  actions,
  onSendStart,
  onSendSettled,
  onSend,
  saveAttachments,
  saveAttachmentPaths,
  removeStagedAttachment,
  isNativeShell,
  accountId,
  queuedMessages,
  onCancelQueuedMessage,
  compactModelMenu,
  chatMentionTargetsForText,
  readCursors,
  onMarkRead,
}: {
  conversation: Conversation;
  thread: MessageThread;
  navigationMessageId?:string|null; firstUnreadMessageId?:string|null; nextAfterSequence?:number|null; onLoadMore?:()=>void;
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnSender: string;
  actions: ChatSessionPaneActions;
  onSendStart: () => void;
  onSendSettled: () => void;
  onSend: (text: string, attachments?: AttachmentItem[]) => Promise<void> | void;
  saveAttachments: (files: File[]) => Promise<AttachmentItem[]>;
  saveAttachmentPaths: (paths?: string[]) => Promise<AttachmentItem[]>;
  removeStagedAttachment: (id: string) => void;
  isNativeShell: boolean;
  accountId?: string | null;
  queuedMessages: QueuedDesktopChatMessage[];
  onCancelQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  compactModelMenu: Omit<ComponentProps<typeof CompactComposerModelMenu>, 'scope'>;
  chatMentionTargetsForText: (text: string, cursor?: number) => ComposerMentionOption[];
  readCursors?: Record<string,number> | null;
  onMarkRead?: (rootId:string, sequence:number) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootId = thread.root.id?.trim() || thread.root.entryId?.trim() || '';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachmentsByRoot, setAttachmentsByRoot] = useState<Record<string, AttachmentItem[]>>({});
  const [mentionIndex, setMentionIndex] = useState(0);
  const draft = drafts[rootId] ?? '';
  const attachments = attachmentsByRoot[rootId] ?? [];
  const {
    menuId: mentionMenuId,
    items: mentionTargets,
    activeIndex: activeMentionIndex,
    activeDescendant: mentionActiveDescendant,
    change: updateMentionCursor,
    select: acceptMention,
    handleKeyDown: handleMentionKeyDown,
  } = useComposerMentionMenu({
    text: draft,
    resetKey: rootId,
    isNativeShell,
    rootPath: conversation.localSessionCwd,
    targetsForText: chatMentionTargetsForText,
    onTextChange: (value) => setDrafts((current) => ({ ...current, [rootId]: value })),
    onPickFile: () => inputRef.current?.click(),
    onAttachPath: (path) => { void addAttachmentPaths([path]); },
    onFocus: (cursor) => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    },
    selectedIndex: mentionIndex,
    setSelectedIndex: setMentionIndex,
  });
  const messages = useMemo(
    () => [{ ...thread.root, threadSummary: undefined }, ...thread.replies],
    [thread],
  );
  const readKey = threadReadKey(thread.root);
  const latestSequence = Math.max(0, ...thread.replies.map(message => message.conversationSequence ?? 0));
  const readSequence = readKey ? readCursors?.[readKey] ?? 0 : 0;
  useEffect(() => {
    if (!readKey || !readCursors || !onMarkRead || latestSequence <= readSequence) return;
    let pending = false;
    const markVisibleRead = () => {
      const scroll = scrollRef.current;
      if (pending || document.visibilityState !== 'visible' || !document.hasFocus() || !scroll) return;
      const viewport=scroll.getBoundingClientRect();
      const sequence=Math.max(readSequence,...Array.from(scroll.querySelectorAll<HTMLElement>('[data-incoming-sequence]')).flatMap(row=>{const box=row.getBoundingClientRect();return box.bottom>viewport.top && box.bottom<=viewport.bottom+1?[Number(row.dataset.incomingSequence)]:[];}));
      if(sequence<=readSequence)return;
      pending = true;
      void onMarkRead(readKey, sequence).then(refreshThreadAttention).catch(() => { pending = false; });
    };
    const timer = setInterval(markVisibleRead, 1000);
    return () => clearInterval(timer);
  }, [latestSequence, onMarkRead, readCursors, readKey, readSequence]);
  const voice = useVoiceComposer({
    conversation,
    cloudAccountId: accountId ?? null,
    onSend: (text, voiceAttachments) => sendThread(text ?? '', voiceAttachments),
    focusComposer: () => textareaRef.current?.focus(),
  });
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
  const addAttachments = async (files: File[]) => {
    const saved = await saveAttachments(files);
    saved.forEach((attachment) => removeStagedAttachment(attachment.id));
    setAttachmentsByRoot((current) => ({
      ...current,
      [rootId]: [...(current[rootId] ?? []), ...saved],
    }));
  };
  const addAttachmentPaths = async (paths: string[]) => {
    const saved = await saveAttachmentPaths(paths);
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
  return (
    <aside data-thread-root-id={readKey??undefined} data-thread-root-client-id={thread.root.clientMessageId} className="app-thread-panel flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--app-main-bg)]" aria-label="Message discussion">
      <ChatSessionPane
        presentation={{
          firstUnreadMessageId: threadUnreadMarkerMessageId(thread, firstUnreadMessageId, readCursors),
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
          navigationRequest:navigationMessageId?{id:navigationMessageId,nonce:0,sessionKey:`${conversation.id}:thread:${rootId}`}:null,
          scrollRef,
          scrollClassName: 'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain',
          queuedMessages,
          onEditQueuedMessage: editQueuedMessage,
          onCancelQueuedMessage,
          composer: (
            <div data-companion-composer-frame="true" className="shrink-0 px-5 pb-4 pt-3">
              {nextAfterSequence!=null?<button type="button" onClick={onLoadMore} className="app-button-quiet mb-2 w-full rounded-lg p-2 text-xs">Load more replies</button>:null}
              <div className="app-composer-shell relative rounded-[26px] p-3" data-companion-composer-footer="true">
                <ComposerMentionMenu
                  id={mentionMenuId}
                  items={mentionTargets}
                  selectedIndex={activeMentionIndex}
                  onSelect={acceptMention}
                />
                <div className={attachments.length > 0 ? 'app-composer-input rounded-[18px] px-3 pb-1.5 pt-1 transition' : 'app-composer-input rounded-[18px] px-4 py-2.5 transition'}>
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
                  <ComposerAttachmentList
                    attachments={attachments}
                    onRemove={(id) => setAttachmentsByRoot((current) => ({
                      ...current,
                      [rootId]: (current[rootId] ?? []).filter((attachment) => attachment.id !== id),
                    }))}
                  />
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(event) => {
                      updateMentionCursor(event.target.selectionStart);
                      setDrafts((current) => ({ ...current, [rootId]: event.target.value }));
                    }}
                    onKeyDown={(event) => {
                      if (handleMentionKeyDown(event)) return;
                      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      void send();
                    }}
                    rows={1}
                    className="min-h-6 max-h-40 w-full resize-none bg-transparent text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                    placeholder="Add to discussion…"
                    aria-label="Add to discussion"
                    aria-autocomplete="list"
                    aria-controls={mentionTargets.length > 0 ? mentionMenuId : undefined}
                    aria-expanded={mentionTargets.length > 0}
                    aria-activedescendant={mentionActiveDescendant}
                  />
                </div>
                <div data-companion-send-row="true" className="app-composer-meta mt-2 flex flex-nowrap items-center justify-between gap-3 pt-2.5">
                  <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
                    {!voice.surfaceActive ? <ComposerAttachmentAddMenu inputRef={inputRef} /> : null}
                    {!voice.surfaceActive ? <ComposerExpressivePicker
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
                  <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-visible">
                    <CompactComposerModelMenu scope="chat" {...compactModelMenu} />
                    <VoiceComposerControls
                      voice={voice}
                      hasSendableDraft={Boolean(draft.trim() || attachments.length)}
                      activeLiveTurnIsRunning={false}
                      onSend={() => { void send(); }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ),
        }}
      />
    </aside>
  );
}
