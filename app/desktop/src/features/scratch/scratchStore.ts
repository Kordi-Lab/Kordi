import { useSyncExternalStore } from 'react';

import type { ScratchKind, ScratchMetadata } from './types';

const EMPTY: readonly ScratchMetadata[] = Object.freeze([]);

const scratchListBySession = new Map<string, ScratchMetadata[]>();
const activeScratchBySession = new Map<string, string | null>();
const seededSessions = new Set<string>();
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

function ensureSeeded(sessionId: string) {
  if (!sessionId || seededSessions.has(sessionId)) return;
  seededSessions.add(sessionId);
  if (scratchListBySession.has(sessionId)) return;
  const now = Date.now();
  const mock: ScratchMetadata[] = [
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
  scratchListBySession.set(sessionId, mock);
}

export function useScratchList(sessionId: string): readonly ScratchMetadata[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureSeeded(sessionId);
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

export function createScratch(sessionId: string, kind: ScratchKind): ScratchMetadata {
  ensureSeeded(sessionId);
  const now = Date.now();
  const meta: ScratchMetadata = {
    id: `scratch_${uuid()}`,
    kind,
    name: kind === 'canvas' ? 'Untitled canvas' : 'Untitled doc',
    createdAt: now,
    updatedAt: now,
  };
  const list = scratchListBySession.get(sessionId) ?? [];
  scratchListBySession.set(sessionId, [meta, ...list]);
  activeScratchBySession.set(sessionId, meta.id);
  notify();
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
