import type { DesktopArtifactPreview, SessionArtifact } from '@/kordi-app/types';

import type { DocumentComment, DocumentFormat, DocumentReaction } from './documentShareTypes';

const DOCUMENT_EXTENSIONS: Record<string, DocumentFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
};

function extension(path: string) {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Markdown and HTML artifacts open in the document reader. */
export function documentFormatForPath(path: string | null | undefined): DocumentFormat | null {
  return path ? DOCUMENT_EXTENSIONS[extension(path)] ?? null : null;
}

/**
 * Markdown and HTML artifacts open in the document reader once there is
 * something to read: the file on this Mac or its cloud attachment.
 */
export function isDocumentReaderArtifact(artifact: SessionArtifact, preview: DesktopArtifactPreview | null) {
  return Boolean(documentFormatForPath(artifact.path) && (preview || artifact.attachmentId));
}

export function documentContentType(path: string) {
  return documentFormatForPath(path) === 'html' ? 'text/html' : 'text/markdown';
}

export function documentFileName(path: string) {
  return path.split('/').filter(Boolean).pop()?.trim() || path;
}

export function documentNameWithoutExtension(path: string) {
  const name = documentFileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const TITLE_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** The `<title>` of an HTML document, when it has one. */
export function htmlDocumentTitle(source: string): string | null {
  const text = /<title[^>]*>([^<]*)<\/title>/i.exec(source)?.[1] ?? '';
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => TITLE_ENTITIES[name]).replace(/\s+/g, ' ').trim() || null;
}

export function formatDocumentDate(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatCommentTime(value: string, now = Date.now()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatKordiNumber(kordiId: string | null | undefined) {
  const digits = kordiId?.replace(/\D/g, '') ?? '';
  return digits ? digits.replace(/(\d{3})(?=\d)/g, '$1 ') : null;
}

export function nameInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0] ?? '').join('').toLocaleUpperCase();
}

export type ReactionPill = { reaction: string; count: number; mine: boolean };

export function reactionPillsForBlock(reactions: DocumentReaction[], blockId: string): ReactionPill[] {
  const pills = new Map<string, ReactionPill>();
  for (const entry of reactions) {
    if (entry.blockId !== blockId) continue;
    const pill = pills.get(entry.reaction) ?? { reaction: entry.reaction, count: 0, mine: false };
    pill.count += 1;
    pill.mine ||= entry.mine;
    pills.set(entry.reaction, pill);
  }
  return [...pills.values()];
}

export function replaceBlockReactions(all: DocumentReaction[], blockId: string, next: DocumentReaction[]) {
  return [...all.filter((entry) => entry.blockId !== blockId), ...next.filter((entry) => entry.blockId === blockId)];
}

export type CommentThread = { root: DocumentComment; replies: DocumentComment[] };

/** Open threads under a block. Resolved threads leave the page. */
export function commentThreadsForBlock(comments: DocumentComment[], blockId: string): CommentThread[] {
  const byCreated = [...comments].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const roots = byCreated.filter((comment) => comment.blockId === blockId && !comment.parentCommentId && !comment.resolvedAt);
  return roots.map((root) => ({
    root,
    replies: byCreated.filter((comment) => comment.parentCommentId === root.commentId),
  }));
}

export function upsertComment(comments: DocumentComment[], next: DocumentComment) {
  return comments.some((comment) => comment.commentId === next.commentId)
    ? comments.map((comment) => (comment.commentId === next.commentId ? next : comment))
    : [...comments, next];
}

export function removeCommentThread(comments: DocumentComment[], commentId: string) {
  return comments.filter((comment) => comment.commentId !== commentId && comment.parentCommentId !== commentId);
}

export type MentionSegment = { text: string; mention: boolean };

/** Splits a comment body so `@Name` mentions of known names can be highlighted. */
export function mentionSegments(body: string, names: string[]): MentionSegment[] {
  const known = names.map((name) => name.trim()).filter(Boolean).sort((left, right) => right.length - left.length);
  if (known.length === 0) return [{ text: body, mention: false }];
  const escaped = known.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(?:${escaped.join('|')})`, 'g');
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index > cursor) segments.push({ text: body.slice(cursor, match.index), mention: false });
    segments.push({ text: match[0], mention: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), mention: false });
  return segments;
}

export function appendMention(draft: string, name: string) {
  const prefix = draft && !/\s$/.test(draft) ? `${draft} ` : draft;
  return `${prefix}@${name} `;
}

export type DocumentInsertTool = 'code' | 'table' | 'image' | 'checklist';
