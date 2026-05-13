// CloudPeerChatPanel — a self-contained 1:1 chat surface for a cloud
// contact pair. Renders as an overlay over the Contacts page so we
// don't have to plumb cloud peer messages through the full local
// chat-session graph (which has agents, projects, transcripts,
// attachments — none of which apply to peer DMs yet).
//
// Visual styling matches the rest of the desktop chat surface: dark
// surface, frosted card, right-aligned outgoing bubbles, left-aligned
// incoming bubbles. The composer is a minimal textarea + send (the
// full composer with attachments / model picker is reserved for the
// agent chat path).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { AttachmentPreview } from '@/kordi-app/components/transcriptAttachments';
import type { Contact, Message } from '@/kordi-app/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { useCloudConversation } from './useCloudConversation';
import type { CloudAccount } from './authClient';

type CloudPeerChatPanelProps = {
  account: CloudAccount;
  contact: Contact;
  onClose: () => void;
};

export function CloudPeerChatPanel({ account, contact, onClose }: CloudPeerChatPanelProps) {
  const peerAccountId = contact.bridgePeerNodeId ?? null;
  const conversation = useCloudConversation(account, peerAccountId);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stick the scroll to the bottom whenever new messages arrive.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.messages.length]);

  // Autofocus composer on open.
  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const peerLabel = contact.name?.trim() || peerAccountId || 'Cloud peer';
  const avatarSeed = contact.avatarSeed ?? cloudAvatarSeedForAccount(peerAccountId ?? contact.id, contact.profileImageUrl);

  const submit = async () => {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || conversation.sending) return;
    const stagedAttachments = attachments;
    setDraft('');
    setAttachments([]);
    await conversation.send(body, stagedAttachments);
  };

  const messages = useMemo(() => conversation.messages, [conversation.messages]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Chat with ${peerLabel}`}
      className="fixed inset-0 z-[200] grid place-items-center bg-black/60 px-4 py-6 backdrop-blur-sm"
    >
      <div className="app-frosted-popover flex h-[min(720px,calc(100vh-3rem))] w-[min(560px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[20px] border border-white/10 bg-slate-950/95 shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <IdentityAvatar
              kind="human"
              seed={avatarSeed}
              name={peerLabel}
              imageUrl={cloudAvatarImageUrl(contact.profileImageUrl)}
              avatarKey={`cloud-chat:${peerAccountId ?? contact.id}`}
              className="h-9 w-9 shrink-0 overflow-hidden rounded-full"
            />
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold leading-5 text-white">{peerLabel}</div>
              <div className="truncate text-[10.5px] leading-4 text-slate-400">{peerAccountId}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          {conversation.loading && messages.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500">Loading conversation…</div>
          ) : messages.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500">
              No messages yet — say hi to {peerLabel}.
            </div>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {messages.map((msg) => {
                const mine = msg.direction === 'outgoing';
                return (
                  <li
                    key={msg.messageId}
                    className={cn('flex w-full', mine ? 'justify-end' : 'justify-start')}
                  >
                    <div
                      className={cn(
                        'max-w-[78%] rounded-[16px] px-3.5 py-2 text-[12.5px] leading-5 shadow-sm',
                        mine
                          ? 'bg-indigo-500/85 text-white'
                          : 'border border-white/10 bg-white/5 text-slate-100',
                      )}
                    >
                      {msg.body.trim() ? <div className="whitespace-pre-wrap break-words">{msg.body}</div> : null}
                      {msg.attachments?.length ? (
                        <div className={msg.body.trim() ? 'mt-2' : ''}>
                          <AttachmentPreview msg={cloudAttachmentPreviewMessage(msg, mine)} />
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          'mt-1 text-[9.5px] uppercase tracking-[0.08em]',
                          mine ? 'text-indigo-50/80' : 'text-slate-500',
                        )}
                      >
                        {formatTime(msg.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-white/10 bg-slate-950/80 px-3 py-3">
          {conversation.error ? (
            <div className="mb-2 rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">
              {conversation.error}
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment, index) => (
                <button
                  key={`${attachment.name}-${attachment.lastModified}-${index}`}
                  type="button"
                  onClick={() => setAttachments((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10.5px] text-slate-200 hover:bg-white/10"
                >
                  {attachment.name} <span className="text-slate-500">×</span>
                </button>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="flex items-end gap-2"
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const selected = Array.from(event.currentTarget.files ?? []);
                if (selected.length > 0) setAttachments((current) => [...current, ...selected]);
                event.currentTarget.value = '';
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={conversation.sending}
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9 shrink-0 rounded-[12px] border-white/10 bg-white/5 p-0 text-slate-200 hover:bg-white/10"
              aria-label="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Type a message…"
              rows={1}
              className="app-input-shell max-h-32 flex-1 resize-none rounded-[14px] px-3 py-2 text-[12.5px] leading-5 outline-none placeholder:text-slate-500"
            />
            <Button
              type="submit"
              disabled={(!draft.trim() && attachments.length === 0) || conversation.sending}
              className="h-9 w-9 shrink-0 rounded-[12px] p-0"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

function cloudAttachmentPreviewMessage(
  msg: { attachments?: Array<{ attachmentId?: string | null; kind: 'image' | 'file'; name: string; mimeType?: string | null; sizeBytes?: number | null; previewUrl?: string | null; downloadUrl?: string | null }> },
  mine: boolean,
): Message {
  return {
    role: mine ? 'user' : 'person',
    text: '',
    time: '',
    attachments: (msg.attachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      previewUrl: attachment.previewUrl ?? attachment.downloadUrl ?? null,
      downloadUrl: attachment.downloadUrl ?? null,
      localPath: null,
      attachmentId: attachment.attachmentId ?? null,
    })),
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
