import {
  attachmentPreviewIdentity,
  isMp4VideoAttachment,
  shouldPreviewAttachmentInline,
} from '@/features/chat/attachmentMediaGallery';
import { externalMessageLinks } from '@/kordi-app/components/messageLinks';
import type { Conversation, Message, MessageAttachment } from '@/kordi-app/types';

export type ContactProfileSharedPage = 'photos' | 'files' | 'links';

export const CONTACT_PROFILE_SHARED_PAGE_TITLES: Record<ContactProfileSharedPage, string> = {
  photos: 'Photos',
  files: 'Files',
  links: 'Links',
};

type SharedItemBase = {
  key: string;
  /** The parent message's time; attachments and links carry none of their own. */
  timestampMs: number | null;
};

export type SharedPhotoItem = SharedItemBase & { attachment: MessageAttachment; isVideo: boolean };
export type SharedFileItem = SharedItemBase & { attachment: MessageAttachment };
export type SharedLinkItem = SharedItemBase & { href: string; label: string | null; domain: string };

export type ContactProfileSharedItems = {
  photos: SharedPhotoItem[];
  files: SharedFileItem[];
  links: SharedLinkItem[];
};

export type SharedMonthGroup<T> = { key: string; label: string; items: T[] };

const EMPTY_ITEMS: ContactProfileSharedItems = { photos: [], files: [], links: [] };

function messageTimestamp(message: Message) {
  const value = message.timestampMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Photos are what the transcript shows as media: inline images and playable videos. */
export function isSharedPhotoAttachment(attachment: MessageAttachment) {
  if (attachment.subtype === 'sticker') return false;
  return shouldPreviewAttachmentInline(attachment) || isMp4VideoAttachment(attachment);
}

function linkDomain(href: string) {
  try {
    return new URL(href).hostname.replace(/^www\./iu, '').toLowerCase();
  } catch {
    return href;
  }
}

/** Shared photos, files and distinct links of a conversation, newest first. */
export function collectContactProfileSharedItems(
  messages: readonly Message[] | null | undefined,
): ContactProfileSharedItems {
  if (!messages?.length) return EMPTY_ITEMS;
  const photos: SharedPhotoItem[] = [];
  const files: SharedFileItem[] = [];
  const links: SharedLinkItem[] = [];
  const seenLinks = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const timestampMs = messageTimestamp(message);
    const messageKey = message.id ?? `message-${index}`;
    const attachments = message.attachments ?? [];
    for (let at = attachments.length - 1; at >= 0; at -= 1) {
      const attachment = attachments[at];
      if (attachment.subtype === 'sticker') continue;
      const key = `${messageKey}:${at}:${attachmentPreviewIdentity(attachment)}`;
      if (isSharedPhotoAttachment(attachment)) {
        photos.push({ key, attachment, timestampMs, isVideo: isMp4VideoAttachment(attachment) });
      } else {
        files.push({ key, attachment, timestampMs });
      }
    }
    for (const link of externalMessageLinks(message.text ?? '', Number.MAX_SAFE_INTEGER)) {
      if (seenLinks.has(link.href)) continue;
      seenLinks.add(link.href);
      links.push({
        key: link.href,
        href: link.href,
        label: link.label && link.label !== link.href ? link.label : null,
        domain: linkDomain(link.href),
        timestampMs,
      });
    }
  }
  return { photos, files, links };
}

/**
 * Whether the client holds the whole conversation, so counts from its messages are not short.
 * Rows built from a partial transcript would undercount the server's totals.
 */
export function sharedConversationIsComplete(conversation: Conversation | null | undefined) {
  if (!conversation?.messages.length) return false;
  const total = conversation.canonicalMessageCount;
  return typeof total !== 'number' || conversation.messages.length >= total;
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long' });
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
// Fixed three-letter months: some ICU versions spell September "Sept".
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "October", or "October 2025" outside the current year. */
export function sharedMonthLabel(timestampMs: number, now = new Date()) {
  const date = new Date(timestampMs);
  return date.getFullYear() === now.getFullYear()
    ? MONTH_FORMAT.format(date)
    : MONTH_YEAR_FORMAT.format(date);
}

/** "14 Oct", or "14 Oct 2025" outside the current year. */
export function sharedItemDateLabel(timestampMs: number | null, now = new Date()) {
  if (timestampMs === null) return '';
  const date = new Date(timestampMs);
  const day = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** A bare link's address without the scheme and "www.". */
export function sharedLinkDisplayUrl(href: string) {
  return href.replace(/^https?:\/\/(?:www\.)?/iu, '');
}

/** Groups newest-first items by the month of their message; undated items come last, unlabelled. */
export function groupSharedItemsByMonth<T extends SharedItemBase>(
  items: readonly T[],
  now = new Date(),
): SharedMonthGroup<T>[] {
  const groups: SharedMonthGroup<T>[] = [];
  const byKey = new Map<string, SharedMonthGroup<T>>();
  for (const item of items) {
    const date = item.timestampMs === null ? null : new Date(item.timestampMs);
    const key = date ? `${date.getFullYear()}-${date.getMonth()}` : 'undated';
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: date ? sharedMonthLabel(date.getTime(), now) : '', items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  const undated = byKey.get('undated');
  return undated ? [...groups.filter((group) => group !== undated), undated] : groups;
}
