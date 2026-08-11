import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  defaultCloudAuthClient,
  type CloudCustomEmoji,
  type CloudSyncEvent,
} from '@/features/cloud/authClient';
import type { StructuredMessageContent } from '@/kordi-app/types';
import { loadSession } from '@/features/cloud/session';
import { giphySelectionForText } from './giphyProvider';

type CustomEmojiSnapshot = {
  byId: Record<string, CloudCustomEmoji>;
  idsByScope: Record<string, string[]>;
  assetUrlsById: Record<string, string>;
  canManageByScope: Record<string, boolean>;
};

let snapshot: CustomEmojiSnapshot = { byId: {}, idsByScope: {}, assetUrlsById: {}, canManageByScope: {} };
const listeners = new Set<() => void>();
const pendingScopes = new Map<string, Promise<void>>();
const pendingAssets = new Map<string, Promise<void>>();

function emit(next: CustomEmojiSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): CustomEmojiSnapshot {
  return snapshot;
}

function upsertEmoji(emoji: CloudCustomEmoji): void {
  const scopeKey = emoji.scopeId ?? 'global';
  const currentScopeIds = snapshot.idsByScope[scopeKey] ?? [];
  const nextScopeIds = currentScopeIds.includes(emoji.emojiId)
    ? currentScopeIds
    : [...currentScopeIds, emoji.emojiId];
  emit({
    ...snapshot,
    byId: { ...snapshot.byId, [emoji.emojiId]: emoji },
    idsByScope: { ...snapshot.idsByScope, [scopeKey]: nextScopeIds },
  });
}

export async function loadCloudCustomEmojis(scopeId: string, includePending = true): Promise<void> {
  const normalizedScopeId = scopeId.trim();
  if (!normalizedScopeId) return;
  const key = `${normalizedScopeId}:${includePending}`;
  const existing = pendingScopes.get(key);
  if (existing) return existing;
  const request = (async () => {
    const session = await loadSession();
    if (!session?.token) return;
    const response = await defaultCloudAuthClient().listCustomEmojis(session.token, normalizedScopeId, includePending);
    const emojis = response.emojis;
    const byId = { ...snapshot.byId };
    emojis.forEach((emoji) => { byId[emoji.emojiId] = emoji; });
    emit({
      ...snapshot,
      byId,
      idsByScope: { ...snapshot.idsByScope, [normalizedScopeId]: emojis.map((emoji) => emoji.emojiId) },
      canManageByScope: { ...snapshot.canManageByScope, [normalizedScopeId]: response.canManage },
    });
  })().finally(() => pendingScopes.delete(key));
  pendingScopes.set(key, request);
  return request;
}

export async function loadCloudCustomEmojiAsset(emojiId: string): Promise<void> {
  const normalizedEmojiId = emojiId.trim();
  if (!normalizedEmojiId || snapshot.assetUrlsById[normalizedEmojiId]) return;
  const existing = pendingAssets.get(normalizedEmojiId);
  if (existing) return existing;
  const request = (async () => {
    const session = await loadSession();
    if (!session?.token) return;
    const blob = await defaultCloudAuthClient().downloadCustomEmojiContent(session.token, normalizedEmojiId);
    const url = URL.createObjectURL(blob);
    const previous = snapshot.assetUrlsById[normalizedEmojiId];
    if (previous) URL.revokeObjectURL(previous);
    emit({
      ...snapshot,
      assetUrlsById: { ...snapshot.assetUrlsById, [normalizedEmojiId]: url },
    });
  })().finally(() => pendingAssets.delete(normalizedEmojiId));
  pendingAssets.set(normalizedEmojiId, request);
  return request;
}

export async function submitCloudCustomEmoji(scopeId: string, name: string, file: File): Promise<CloudCustomEmoji> {
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  if (file.size > 1024 * 1024) throw new Error('Emoji uploads must be 1 MB or smaller.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Use a PNG, JPEG, or WebP image.');
  }
  const attachment = await defaultCloudAuthClient().uploadAttachment(session.token, file);
  const emoji = await defaultCloudAuthClient().createCustomEmoji(session.token, {
    scopeId,
    name,
    attachmentId: attachment.attachmentId,
  });
  upsertEmoji(emoji);
  await loadCloudCustomEmojiAsset(emoji.emojiId);
  return emoji;
}

export async function updateCloudCustomEmojiStatus(
  emojiId: string,
  status: 'active' | 'rejected' | 'disabled',
): Promise<CloudCustomEmoji> {
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  const emoji = await defaultCloudAuthClient().updateCustomEmoji(session.token, emojiId, { status });
  upsertEmoji(emoji);
  return emoji;
}

export async function renameCloudCustomEmoji(emojiId: string, name: string): Promise<CloudCustomEmoji> {
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  const emoji = await defaultCloudAuthClient().updateCustomEmoji(session.token, emojiId, { name });
  upsertEmoji(emoji);
  return emoji;
}

export async function addCloudCustomEmojiAlias(
  emojiId: string,
  alias: string,
): Promise<CloudCustomEmoji> {
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  const emoji = await defaultCloudAuthClient().addCustomEmojiAlias(session.token, emojiId, alias);
  upsertEmoji(emoji);
  return emoji;
}

export function applyCloudCustomEmojiSyncEvents(events: CloudSyncEvent[]): void {
  events.forEach((event) => {
    if (!['custom_emoji.created', 'custom_emoji.updated', 'custom_emoji.disabled'].includes(event.eventType)) return;
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as { emoji?: CloudCustomEmoji }
      : null;
    const emoji = payload?.emoji;
    if (!emoji?.emojiId) return;
    upsertEmoji(emoji);
  });
}

export function customEmojiContentForText(text: string, scopeId: string | null | undefined) {
  const normalizedScopeId = scopeId?.trim() ?? '';
  if (!normalizedScopeId || !text.includes(':')) return null;
  const emojiIds = [
    ...(snapshot.idsByScope.global ?? []),
    ...(snapshot.idsByScope[normalizedScopeId] ?? []),
  ];
  const byShortcode = new Map<string, CloudCustomEmoji>();
  emojiIds.forEach((emojiId) => {
    const emoji = snapshot.byId[emojiId];
    if (!emoji || emoji.status !== 'active') return;
    byShortcode.set(emoji.name, emoji);
    emoji.aliases.forEach((alias) => byShortcode.set(alias, emoji));
  });
  const pattern = /:([a-z0-9][a-z0-9_-]{1,31}):/g;
  const children: Array<
    | { type: 'text'; text: string }
    | { type: 'custom_emoji'; emojiId: string; fallback: string }
  > = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const emoji = byShortcode.get(match[1]);
    if (!emoji) continue;
    if (index > cursor) children.push({ type: 'text', text: text.slice(cursor, index) });
    children.push({ type: 'custom_emoji', emojiId: emoji.emojiId, fallback: `:${emoji.name}:` });
    cursor = index + match[0].length;
  }
  if (children.length === 0) return null;
  if (cursor < text.length) children.push({ type: 'text', text: text.slice(cursor) });
  return { schema: 1 as const, blocks: [{ type: 'paragraph' as const, children }] };
}

export function structuredMessageContentForText(
  text: string,
  scopeId: string | null | undefined,
): StructuredMessageContent | null {
  const providerMedia = giphySelectionForText(text);
  if (providerMedia) {
    return {
      schema: 1,
      blocks: [{
        type: 'provider_media',
        provider: 'giphy',
        providerMediaId: providerMedia.providerMediaId,
        mediaKind: providerMedia.mediaKind,
        title: providerMedia.title,
        altText: providerMedia.altText,
        width: providerMedia.width,
        height: providerMedia.height,
        rating: providerMedia.rating,
      }],
    };
  }
  return customEmojiContentForText(text, scopeId);
}

export function useCloudCustomEmojis(scopeId: string | null | undefined) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const normalizedScopeId = scopeId?.trim() ?? '';
  useEffect(() => {
    if (!normalizedScopeId) return;
    void loadCloudCustomEmojis(normalizedScopeId).catch(() => {});
  }, [normalizedScopeId]);
  const emojis = useMemo(() => {
    const ids = [
      ...(current.idsByScope.global ?? []),
      ...(current.idsByScope[normalizedScopeId] ?? []),
    ];
    return [...new Set(ids)].map((id) => current.byId[id]).filter(Boolean);
  }, [current.byId, current.idsByScope, normalizedScopeId]);
  return {
    emojis,
    canManage: Boolean(current.canManageByScope[normalizedScopeId]),
  };
}

export function useCloudCustomEmojiAsset(emojiId: string) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadCloudCustomEmojiAsset(emojiId).catch(() => {});
  }, [emojiId]);
  return current.assetUrlsById[emojiId] ?? null;
}

export function __setCloudCustomEmojiSnapshotForTests(emojis: CloudCustomEmoji[]): void {
  const byId = Object.fromEntries(emojis.map((emoji) => [emoji.emojiId, emoji]));
  const idsByScope: Record<string, string[]> = {};
  emojis.forEach((emoji) => {
    const scope = emoji.scopeId ?? 'global';
    idsByScope[scope] = [...(idsByScope[scope] ?? []), emoji.emojiId];
  });
  emit({ byId, idsByScope, assetUrlsById: {}, canManageByScope: {} });
}
