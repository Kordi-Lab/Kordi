import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp } from 'lucide-react';
import { AppDialog, AppDialogTitle, AppDialogDescription } from '@/components/ui/dialog';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { subsessionMentionOptions, subsessionMentions, subsessionTranscript } from '@/features/cloud/subsessionConversation';
import { BlobEmojiComposerInput, type BlobEmojiComposerInputHandle } from '@/features/emoji/BlobEmojiComposerInput';
import { QueuedMessageBubble } from '@/pages/chatsPage.queuedMessage';
import { ComposerMentionMenu } from './composerMentionMenu';
import { orderedComposerMentionOptions } from './composerMentionOptions';
import type { ComposerMentionOption } from './composer';
import type { MessageMention } from '@/kordi-app/types';

// The transcript renders task cards too; load it lazily to avoid a module cycle.
const MessageBubble = lazy(() => import('./transcript').then(module => ({ default: module.MessageBubble })));

export function AgentSubsessionDialog({ sessionId, onClose }: {
  sessionId: string; parentSessionId?: string; parentRequestId?: string | null; agentName?: string | null; onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const menuId = useId();
  const { snapshot, error, reload } = useAgentSubsession(sessionId, true);
  const [accountId, setAccountId] = useState('');
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const [menuQuery, setMenuQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedTargets, setSelectedTargets] = useState<ComposerMentionOption[]>([]);
  const input = useRef<BlobEmojiComposerInputHandle>(null);
  const mentionCaret = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const attempt = useRef<{ id: string; text: string; mentions: MessageMention[] } | null>(null);
  useEffect(() => {
    let active = true;
    void loadSession().then(session => { if (active) setAccountId(session?.accountId ?? ''); });
    const changed = () => { setDraft(''); setAccountId(''); onClose(); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, changed);
    return () => { active = false; window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, changed); };
  }, [onClose]);
  useEffect(() => {
    if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [snapshot]);
  const options = snapshot ? subsessionMentionOptions(snapshot, accountId) : [];
  useLayoutEffect(() => {
    if (mentionCaret.current == null) return;
    const caret = mentionCaret.current;
    mentionCaret.current = null;
    input.current?.focus({ start: caret, end: caret });
  }, [draft]);
  const menu = orderedComposerMentionOptions(menuQuery ? options.filter(option =>
    option.value.toLowerCase().includes(menuQuery.text.toLowerCase()) || option.label.toLowerCase().includes(menuQuery.text.toLowerCase())) : []);
  const selectMention = (option: ComposerMentionOption) => {
    if (!menuQuery) return;
    const text = draft.slice(0, menuQuery.start) + '@' + option.value + ' ' + draft.slice(menuQuery.end);
    const caret = menuQuery.start + option.value.length + 2;
    mentionCaret.current = caret;
    setSelectedTargets(previous => [...previous.filter(target => target.value !== option.value), option]);
    setDraft(text); setMenuQuery(null);
  };
  const send = async () => {
    if (sending || !draft.trim() || !snapshot) return;
    const text = draft.trim();
    const selectedHandles = new Set(selectedTargets.map(option => option.value));
    const boundOptions = [...options.filter(option => !selectedHandles.has(option.value)), ...selectedTargets];
    const request = attempt.current?.text === text ? attempt.current : { id: crypto.randomUUID(), text, mentions: subsessionMentions(text, boundOptions) };
    attempt.current = request;
    setSending(true); setSendError(''); setMenuQuery(null);
    try {
      const session = await loadSession();
      if (!session || session.accountId !== accountId) throw Error('Account changed');
      await new CloudAuthClient().sendAgentSubsessionMessage(session.token, sessionId, request.id, text, request.mentions);
      if ((await loadSession())?.accountId !== accountId) return;
      setDraft(''); setSelectedTargets([]); attempt.current = null; atBottom.current = true; reload();
    } catch { setSendError('Could not send. Your message is kept below; try again.'); }
    finally { setSending(false); }
  };
  const rows = snapshot ? subsessionTranscript(snapshot, accountId) : [];
  const queued = new Set(snapshot?.messages.filter(row => row.role === 'user' && row.requestState === 'queued').map(row => row.id));
  return <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={onClose}
    contentClassName="flex min-h-0 flex-1 flex-col"
    className="flex h-[calc(100dvh-3rem)] w-[min(80rem,96vw)] max-w-none flex-col overflow-hidden p-0">
    <header className="flex shrink-0 items-center gap-3 border-b p-4">
      <button type="button" className="app-button-quiet rounded-full p-3" onClick={onClose} aria-label="Back to conversation"><ArrowLeft className="h-5 w-5" /></button>
      <div className="min-w-0">
        <AppDialogTitle id={titleId}>{snapshot?.title ?? 'Agent session'}</AppDialogTitle>
        <AppDialogDescription id={descriptionId}>{snapshot
          ? `${snapshot.agentDisplayName} · Owner · ${snapshot.ownerAccountId === accountId ? 'You' : snapshot.ownerDisplayName}`
          : 'Loading conversation…'}</AppDialogDescription>
      </div>
    </header>
    {error ? <div role="alert" className="p-3">{error} <button type="button" onClick={reload}>Try again</button></div> : null}
    <div ref={scroller} className="app-chat-wallpaper min-h-0 flex-1 overflow-y-auto p-5" data-agent-subsession={sessionId}
      onScroll={event => { const node = event.currentTarget; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      {!snapshot && !error ? <p role="status">Loading conversation…</p> : null}
      <Suspense fallback={<p role="status">Loading messages…</p>}>
        {rows.map(row => queued.has(row.id!) ? <QueuedMessageBubble key={row.id}
          message={{ id: row.id!, sessionId, text: row.text, time: row.time, attachments: [] }}
          own={row.isOwnMessage} sender={row.sender} isCompressionActive={false} />
          : <MessageBubble key={row.id} msg={row} />)}
      </Suspense>
    </div>
    <div className="shrink-0 border-t p-4">
      {sendError ? <p role="alert" className="mb-2 text-sm">{sendError}</p> : null}
      <div className="relative flex items-end gap-3 rounded-3xl border p-3">
        {menu.length ? <ComposerMentionMenu id={menuId} items={menu} selectedIndex={Math.min(selectedIndex, menu.length - 1)} onSelect={selectMention} /> : null}
        <BlobEmojiComposerInput ref={input} value={draft} placeholder="Send a message; @mention the agent for a reply"
          className="max-h-40 min-h-12 flex-1 overflow-y-auto p-2" readOnly={sending || !snapshot || !!error}
          ariaControls={menu.length ? menuId : undefined} ariaExpanded={menu.length > 0}
          ariaActiveDescendant={menu.length ? `${menuId}-option-${Math.min(selectedIndex, menu.length - 1)}` : undefined}
          onChange={value => {
            setDraft(value);
            const caret = input.current?.selection().start ?? value.length;
            const match = /(?:^|\s)@([\p{L}\p{N}]*)$/u.exec(value.slice(0, caret));
            setMenuQuery(match ? { start: caret - match[1].length - 1, end: caret, text: match[1] } : null); setSelectedIndex(0);
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (menu.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault(); setSelectedIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
            } else if (menu.length && event.key === 'Enter') { event.preventDefault(); selectMention(menu[Math.min(selectedIndex, menu.length - 1)]); }
            else if (event.key === 'Escape' && menuQuery) { event.preventDefault(); event.stopPropagation(); setMenuQuery(null); }
            else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          }} />
        <button type="button" onClick={() => { void send(); }} disabled={sending || !draft.trim() || !snapshot || !!error}
          aria-label="Send message" className="app-button-primary rounded-full p-3 disabled:opacity-50"><ArrowUp className="h-5 w-5" /></button>
      </div>
    </div>
  </AppDialog>;
}
