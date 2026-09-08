import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';
import { digestClient } from './client';
import type { CalendarEvent, DigestResponse } from './types';

export type DigestState = {
  digest: DigestResponse | null;
  events: CalendarEvent[];
  calendarLoaded: boolean;
  digestError: string | null;
  calendarError: string | null;
};

const emptyState = (): DigestState => ({ digest: null, events: [], calendarLoaded: false, digestError: null, calendarError: null });
export const DIGEST_POLL_INTERVAL = 5_000;

// Memory only: a route disappearing must not discard an authenticated read or
// cancel the read another mount can reuse. Session changes invalidate everything.
export class DigestStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private pending: Promise<DigestResponse | null> | null = null;
  private queued: Promise<DigestResponse | null> | null = null;
  private lastCompletedAt = 0;
  private disposed = false;

  constructor(private readonly accountId: string, private readonly now = Date.now) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<DigestState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.state = emptyState();
    this.listeners.forEach(listener => listener());
  }

  refresh = (force = false): Promise<DigestResponse | null> => {
    if (this.disposed || this.controller.signal.aborted) return Promise.resolve(null);
    if (this.pending) {
      if (!force) return this.pending;
      // A mutation needs a read started AFTER it, not an older poll's response.
      this.queued ??= this.pending.catch(() => null).then(() => {
        this.queued = null;
        return this.refresh(true);
      });
      return this.queued;
    }
    if (!force && this.lastCompletedAt && this.now() - this.lastCompletedAt < DIGEST_POLL_INTERVAL) {
      return Promise.resolve(this.state.digest);
    }
    const signal = this.controller.signal;
    const report = (part: 'digest' | 'calendar', error: unknown) => {
      if (signal.aborted) return;
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403) {
        this.publish({ ...emptyState(), digestError: 'Sign in again to open your digest.' });
        this.controller.abort();
        return;
      }
      const message = part === 'digest'
        ? 'Could not refresh your digest. Retrying…'
        : 'Could not refresh your calendar. Retrying…';
      this.publish(part === 'digest' ? { digestError: message } : { calendarError: message });
    };
    const digest = digestClient.read(this.accountId, signal).then(value => {
      if (!signal.aborted) this.publish({ digest: value, digestError: null });
      return value;
    }).catch(error => { report('digest', error); throw error; });
    const calendar = digestClient.calendar(this.accountId, signal).then(value => {
      if (!signal.aborted) this.publish({ events: value.events, calendarLoaded: true, calendarError: null });
    }).catch(error => { report('calendar', error); throw error; });
    this.pending = Promise.allSettled([digest, calendar]).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return this.state.digest;
    }).finally(() => {
      this.pending = null;
      this.lastCompletedAt = this.now();
    });
    return this.pending;
  };
}

type Registry = { entries: Map<string, DigestStore> };
const registries = new WeakMap<Window, Registry>();

export function digestStoreFor(accountId: string): DigestStore {
  let registry = registries.get(window);
  if (!registry) {
    const entries = new Map<string, DigestStore>();
    registry = { entries };
    registries.set(window, registry);
    const clear = () => {
      const old = [...entries.values()];
      entries.clear();
      old.forEach(entry => entry.dispose());
    };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, clear);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
  }
  const key = JSON.stringify([cloudApiBaseUrl(), accountId, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]);
  let entry = registry.entries.get(key);
  if (!entry) {
    entry = new DigestStore(accountId);
    registry.entries.set(key, entry);
    // Bound cached source messages without writing any of them to disk.
    if (registry.entries.size > 4) {
      const oldest = registry.entries.keys().next().value!;
      registry.entries.get(oldest)?.dispose();
      registry.entries.delete(oldest);
    }
  } else {
    registry.entries.delete(key);
    registry.entries.set(key, entry);
  }
  return entry;
}
