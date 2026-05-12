import { useSyncExternalStore } from 'react';

import { kvDelete, kvGet, kvSet, scratchStorageKey } from './storage/indexedDb';
import type { ScratchKind, ScratchMetadata } from './types';

const EMPTY: readonly ScratchMetadata[] = Object.freeze([]);

const scratchListBySession = new Map<string, ScratchMetadata[]>();
const activeScratchBySession = new Map<string, string | null>();
const sessionLoadStarted = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function scratchListStorageKey(sessionId: string): string {
  return `scratch_list:${sessionId}`;
}

function generateMockList(): ScratchMetadata[] {
  const now = Date.now();
  return [
    {
      id: `scratch_${uuid()}`,
      kind: 'canvas',
      name: 'Architecture sketch',
      createdAt: now - 1000 * 60 * 30,
      updatedAt: now - 1000 * 60 * 2,
    },
    {
      id: `scratch_${uuid()}`,
      kind: 'doc',
      name: 'Meeting notes',
      createdAt: now - 1000 * 60 * 60 * 3,
      updatedAt: now - 1000 * 60 * 60,
    },
    {
      id: `scratch_${uuid()}`,
      kind: 'doc',
      name: 'API draft',
      createdAt: now - 1000 * 60 * 60 * 36,
      updatedAt: now - 1000 * 60 * 60 * 24,
    },
  ];
}

function persistList(sessionId: string) {
  if (!sessionId) return;
  const list = scratchListBySession.get(sessionId);
  if (!list) return;
  void kvSet(scratchListStorageKey(sessionId), list);
}

function ensureSessionHydrated(sessionId: string) {
  if (!sessionId || sessionLoadStarted.has(sessionId)) return;
  sessionLoadStarted.add(sessionId);
  void kvGet<ScratchMetadata[]>(scratchListStorageKey(sessionId))
    .then((stored) => {
      const existing = scratchListBySession.get(sessionId) ?? [];
      if (Array.isArray(stored) && stored.length > 0) {
        if (existing.length === 0) {
          scratchListBySession.set(sessionId, stored);
        } else {
          // Merge: anything created locally during the async load wins by id
          const seen = new Set(existing.map((s) => s.id));
          const merged = [...existing, ...stored.filter((s) => !seen.has(s.id))];
          scratchListBySession.set(sessionId, merged);
          void kvSet(scratchListStorageKey(sessionId), merged);
        }
        notify();
      } else if (existing.length === 0) {
        const mocks = generateMockList();
        scratchListBySession.set(sessionId, mocks);
        void kvSet(scratchListStorageKey(sessionId), mocks);
        notify();
      }
    })
    .catch(() => {
      if (!scratchListBySession.has(sessionId)) {
        scratchListBySession.set(sessionId, generateMockList());
        notify();
      }
    });
}

export function useScratchList(sessionId: string): readonly ScratchMetadata[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureSessionHydrated(sessionId);
      return scratchListBySession.get(sessionId) ?? EMPTY;
    },
    () => EMPTY,
  );
}

export function useActiveScratchId(sessionId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => activeScratchBySession.get(sessionId) ?? null,
    () => null,
  );
}

export function setActiveScratchId(sessionId: string, scratchId: string | null) {
  if (!sessionId) return;
  activeScratchBySession.set(sessionId, scratchId);
  notify();
}

export function deleteScratch(sessionId: string, scratchId: string) {
  if (!sessionId || !scratchId) return;
  const list = scratchListBySession.get(sessionId);
  if (!list || !list.some((s) => s.id === scratchId)) return;
  scratchListBySession.set(sessionId, list.filter((s) => s.id !== scratchId));
  if (activeScratchBySession.get(sessionId) === scratchId) {
    activeScratchBySession.set(sessionId, null);
  }
  notify();
  persistList(sessionId);
  void kvDelete(scratchStorageKey(sessionId, scratchId));
}

export function duplicateScratch(sessionId: string, scratchId: string): ScratchMetadata | null {
  if (!sessionId || !scratchId) return null;
  const list = scratchListBySession.get(sessionId);
  if (!list) return null;
  const source = list.find((s) => s.id === scratchId);
  if (!source) return null;
  const now = Date.now();
  const meta: ScratchMetadata = {
    id: `scratch_${uuid()}`,
    kind: source.kind,
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  scratchListBySession.set(sessionId, [meta, ...list]);
  notify();
  persistList(sessionId);
  // Copy content asynchronously; missing source content is fine (new scratch is empty)
  void (async () => {
    try {
      const content = await kvGet<unknown>(scratchStorageKey(sessionId, scratchId));
      if (content !== null && content !== undefined) {
        await kvSet(scratchStorageKey(sessionId, meta.id), content);
      }
    } catch {
      // ignore: duplicate proceeds with empty content
    }
  })();
  return meta;
}

export function renameScratch(sessionId: string, scratchId: string, name: string) {
  if (!sessionId || !scratchId) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = scratchListBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((s) => s.id === scratchId);
  if (idx < 0 || list[idx].name === trimmed) return;
  const next = list.slice();
  next[idx] = { ...list[idx], name: trimmed };
  scratchListBySession.set(sessionId, next);
  notify();
  persistList(sessionId);
}

export function touchScratch(sessionId: string, scratchId: string) {
  if (!sessionId || !scratchId) return;
  const list = scratchListBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((s) => s.id === scratchId);
  if (idx < 0) return;
  const updated: ScratchMetadata = { ...list[idx], updatedAt: Date.now() };
  const next = list.filter((_, i) => i !== idx);
  next.unshift(updated);
  scratchListBySession.set(sessionId, next);
  notify();
  persistList(sessionId);
}

export function createScratch(sessionId: string, kind: ScratchKind): ScratchMetadata {
  const now = Date.now();
  const meta: ScratchMetadata = {
    id: `scratch_${uuid()}`,
    kind,
    name: kind === 'canvas' ? 'Untitled canvas' : 'Untitled doc',
    createdAt: now,
    updatedAt: now,
  };
  if (!sessionId) return meta;
  const list = scratchListBySession.get(sessionId) ?? [];
  scratchListBySession.set(sessionId, [meta, ...list]);
  activeScratchBySession.set(sessionId, meta.id);
  notify();
  persistList(sessionId);
  return meta;
}

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}w ago`;
  const month = Math.floor(day / 30);
  return `${month}mo ago`;
}
