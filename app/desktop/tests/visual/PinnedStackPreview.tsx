import { useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, Hash, MessageCircle, MoreHorizontal, Moon, Paperclip, Pin, Plus, Search, Sun, Users } from 'lucide-react';
import { PinnedMessageBar } from '@/pages/chatsPage.pins';
import type { PinnedMessageItem } from '@/pages/chatsPage.pinModel';
import type { Message } from '@/kordi-app/types';
import './pinned-stack-preview.css';

const MAX_PINS = 5;
const messages: Message[] = [
  { id: 'sample-1', role: 'user', sender: 'Maya', text: 'Design review is Thursday at 10:00. Bring the latest screens.', time: '9:41' },
  { id: 'sample-2', role: 'user', sender: 'Alex', text: 'The updated prototype is ready. I kept the chat header simple and gave the messages more room.', time: '9:42' },
  { id: 'sample-3', role: 'user', sender: 'Maya', text: 'Preview link: design.kordi.example/chat', time: '9:43' },
  { id: 'sample-4', role: 'user', sender: 'You', text: 'Looks good. Let’s keep the important details pinned so they are easy to find.', time: '9:44' },
  { id: 'sample-5', role: 'user', sender: 'Alex', text: 'Release checklist: review the copy, check mobile, then share the build.', time: '9:45' },
  { id: 'sample-6', role: 'user', sender: 'Maya', text: 'I’ll take the mobile pass. The pinned strip should feel like part of the conversation.', time: '9:46' },
  { id: 'sample-7', role: 'user', sender: 'You', text: 'Agreed. One message at a time, with the rest neatly stacked behind it.', time: '9:47' },
  { id: 'sample-8', role: 'user', sender: 'Alex', text: 'Next check-in: Friday at 14:00.', time: '9:48' },
];
const initialPins: PinnedMessageItem[] = [0, 2, 4].map((index) => ({ message: messages[index], scope: 'shared' }));

export function PinnedStackPreview() {
  const [platform, setPlatform] = useState<'desktop' | 'ios'>('desktop');
  const [dark, setDark] = useState(false);
  const [pins, setPins] = useState(initialPins);
  const [notice, setNotice] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [messageMenu, setMessageMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuActionRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStart = useRef<{ x: number; y: number } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinIds = new Set(pins.map((item) => item.message.id));

  function showNotice(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  }
  function addPin(message: Message) {
    if (pinIds.has(message.id)) return;
    if (pins.length >= MAX_PINS) {
      showNotice('You can pin up to 5 messages. Unpin one to add another.');
      return;
    }
    setPins((current) => [...current, { message, scope: 'shared' }]);
    setNotice('');
  }
  function openMessage(message: Message) {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightedId(message.id ?? null);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`preview-${message.id}`)?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'center' });
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 1800);
  }
  function unpin(item: PinnedMessageItem) {
    setPins((current) => current.filter((pin) => pin.message.id !== item.message.id));
    setNotice('');
  }
  function cancelHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdStart.current = null;
  }
  function openMessageMenu(message: Message, x: number, y: number) {
    cancelHold();
    setMessageMenu({ message, x: Math.max(12, Math.min(x, window.innerWidth - 192)), y: Math.max(12, Math.min(y, window.innerHeight - 64)) });
    menuRef.current?.showPopover();
    requestAnimationFrame(() => menuActionRef.current?.focus());
  }
  function reset() {
    cancelHold();
    menuRef.current?.hidePopover();
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setPins(initialPins);
    setNotice('');
    setHighlightedId(null);
    setResetKey((current) => current + 1);
  }

  return <main className={`pin-proposal ${dark ? 'is-dark' : ''}`} data-platform={platform}>
    <header className="proposal-header">
      <a className="proposal-brand" href="/pinned-stack-preview.html" aria-label="Reset Kordi preview"><span className="kordi-mark">k</span><span>Kordi<span className="proposal-label">Design proposal</span></span></a>
      <div className="proposal-platforms" role="group" aria-label="Preview platform">
        <button type="button" aria-pressed={platform === 'desktop'} onClick={() => { menuRef.current?.hidePopover(); setPlatform('desktop'); }}>Desktop</button>
        <button type="button" aria-pressed={platform === 'ios'} onClick={() => { menuRef.current?.hidePopover(); setPlatform('ios'); }}>iOS</button>
      </div>
      <button type="button" className="theme-toggle" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setDark((current) => !current)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
    </header>
    <section className="proposal-intro">
      <div><h1>Pinned, without the clutter.</h1><p>One compact strip. Tap to move through the stack.</p></div>
      <div className="proposal-controls"><span className="pin-count">{pins.length} / 5 pinned</span><button type="button" className="add-pin" onClick={() => {
        const candidate = messages.find((message) => !pinIds.has(message.id));
        if (candidate) addPin(candidate);
      }}><Plus size={15} />Add a pin</button><button type="button" className="reset-preview" onClick={reset}>Reset</button></div>
    </section>
    <div className="proposal-stage">
      <div className={`chat-window ${platform === 'ios' ? 'phone-window' : ''}`}>
        {platform === 'desktop' ? <aside className="chat-sidebar" aria-label="Sample chat sidebar">
          <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
          <div className="sidebar-heading">Chats<span><Plus size={17} /></span></div>
          <div className="sidebar-search"><Search size={14} />Search conversations</div>
          <div className="sidebar-section">Workspace</div>
          <div className="sidebar-conversation selected"><div className="group-avatar"><Hash size={21} /></div><div><strong>Design team</strong><p>One message at a time…</p></div><span className="sidebar-time">9:47</span></div>
          <div className="sidebar-conversation"><div className="group-avatar alternate"><Users size={19} /></div><div><strong>General</strong><p>See you tomorrow!</p></div></div>
          <div className="sidebar-section">Direct messages</div>
          <div className="sidebar-conversation"><div className="avatar maya">M</div><div><strong>Maya Chen</strong><p>I’ll check the mobile view.</p></div></div>
          <div className="sidebar-conversation"><div className="avatar alex">A</div><div><strong>Alex Morgan</strong><p>Shared the prototype.</p></div></div>
          <div className="sidebar-bottom"><div className="avatar you">Y</div><span>You<small>Available</small></span><MoreHorizontal size={18} /></div>
        </aside> : <div className="ios-status" aria-hidden="true"><strong>9:41</strong><span className="dynamic-island" /><span className="ios-status-icons">▮▮▮ <span>◔</span><i /></span></div>}
        <section className="chat-main" aria-label="Sample design team conversation">
          <header className="chat-header">
            {platform === 'ios' ? <span className="ios-back" aria-hidden="true"><ChevronLeft size={27} />Chats</span> : <div className="group-avatar"><Hash size={21} /></div>}
            <div className="chat-title"><strong>Design team</strong><span>3 members</span></div>
            {platform === 'ios' ? <div className="group-avatar"><Hash size={20} /></div> : <span className="chat-header-icons" aria-hidden="true"><Search size={18} /><MoreHorizontal size={22} /></span>}
          </header>
          <PinnedMessageBar key={`${platform}-${resetKey}`} items={pins} onOpenMessage={openMessage} onRequestUnpin={unpin} />
          <div className="chat-transcript" onScroll={() => { cancelHold(); menuRef.current?.hidePopover(); }}>
            <div className="chat-date">Today</div>
            {messages.map((message) => <article id={`preview-${message.id}`} key={message.id} className={`chat-message ${message.sender === 'You' ? 'is-own' : ''} ${highlightedId === message.id ? 'is-highlighted' : ''}`}>
              {message.sender !== 'You' ? <div className={`avatar ${message.sender === 'Maya' ? 'maya' : 'alex'}`}>{message.sender?.slice(0, 1)}</div> : null}
              <div className="message-column">
                {message.sender !== 'You' ? <span className="message-sender">{message.sender}</span> : null}
                <div className="message-bubble" tabIndex={0} aria-haspopup="menu"
                  onContextMenu={(event) => { event.preventDefault(); openMessageMenu(message, event.clientX, event.clientY); }}
                  onKeyDown={(event) => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openMessageMenu(message, rect.left + 16, rect.bottom);
                    }
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || (event.pointerType === 'mouse' && platform !== 'ios')) return;
                    cancelHold();
                    const { clientX: x, clientY: y } = event;
                    holdStart.current = { x, y };
                    holdTimer.current = setTimeout(() => openMessageMenu(message, x, y), 500);
                  }}
                  onPointerMove={(event) => {
                    if (holdStart.current && Math.hypot(event.clientX - holdStart.current.x, event.clientY - holdStart.current.y) > 10) cancelHold();
                  }}
                  onPointerUp={cancelHold} onPointerCancel={cancelHold}>
                  {message.text}<span className="message-meta">{pinIds.has(message.id) ? <Pin size={10} aria-label="Pinned" /> : null}{message.time}{message.sender === 'You' ? <span className="read-checks">✓✓</span> : null}</span>
                </div>
              </div>
            </article>)}
          </div>
          <div className="preview-notice" role="status" aria-live="polite">{notice ? <span>{notice}</span> : null}</div>
          <footer className="chat-composer" aria-label="Sample message composer"><span aria-hidden="true">{platform === 'ios' ? <Plus size={24} /> : <Paperclip size={20} />}</span><div>Message<span aria-hidden="true">☺</span></div><span className="send-icon" aria-hidden="true"><ArrowUp size={19} /></span></footer>
          {platform === 'ios' ? <div className="home-indicator" aria-hidden="true" /> : null}
        </section>
      </div>
    </div>
    <div ref={menuRef} popover="auto" role="menu" aria-label="Message actions" className="preview-message-menu" style={{ left: messageMenu?.x ?? 12, top: messageMenu?.y ?? 12 }}>
      <button ref={menuActionRef} type="button" role="menuitem" onClick={() => {
        menuRef.current?.hidePopover();
        if (!messageMenu) return;
        const pin = pins.find((item) => item.message.id === messageMenu.message.id);
        if (pin) unpin(pin); else addPin(messageMenu.message);
      }}><Pin size={16} aria-hidden="true" />{messageMenu && pinIds.has(messageMenu.message.id) ? 'Unpin message' : 'Pin message'}</button>
    </div>
    <footer className="proposal-notes"><span><MessageCircle size={15} />Click the strip to cycle · Pin + list opens all pins · {platform === 'ios' ? 'Hold a message for pin actions' : 'Right-click a message for pin actions'}</span><p>{platform === 'ios' ? 'iOS layout mockup · The app uses native SwiftUI controls.' : 'Interactive preview · Sample messages'}</p></footer>
  </main>;
}
