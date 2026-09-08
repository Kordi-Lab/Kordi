import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';
import { digestClient } from './client';
import type { CalendarEvent, DigestResponse } from './types';
import { feedbackState, removedEventsState } from './optimistic';

export type DigestState = {
  digest: DigestResponse | null;
  events: CalendarEvent[];
  calendarLoaded: boolean;
  digestError: string | null;
  calendarError: string | null;
  pendingMutationKeys: string[];
  mutationError: string | null;
  canRetryMutation: boolean;
};

const emptyState = (): DigestState => ({ digest: null, events: [], calendarLoaded: false, digestError: null, calendarError: null, pendingMutationKeys: [], mutationError: null, canRetryMutation: false });
export const DIGEST_POLL_INTERVAL = 5_000;

// Memory only: a route disappearing must not discard an authenticated read or
// cancel the read another mount can reuse. Session changes invalidate everything.
export class DigestStore {
  private state = emptyState();
  private base = emptyState();
  private readRevision = 0;
  private mutations = new Map<symbol, { keys: string[]; apply: (state: DigestState) => DigestState; promise: Promise<void> }>();
  private retryFailed: (() => Promise<void>) | null = null;
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
    this.base = { ...this.base, ...patch };
    let next = this.base;
    for (const mutation of this.mutations.values()) next = mutation.apply(next);
    this.state = { ...next, pendingMutationKeys: [...this.mutations.values()].flatMap(item => item.keys), canRetryMutation: !!this.retryFailed };
    this.listeners.forEach(listener => listener());
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.mutations.clear();
    this.retryFailed = null;
    this.base = emptyState();
    this.state = emptyState();
    this.listeners.forEach(listener => listener());
  }

  private mutate(keys: string[], apply: (state: DigestState) => DigestState, write: (signal: AbortSignal) => Promise<unknown>, message: string): Promise<void> {
    const signal = this.controller.signal;
    if (this.disposed || signal.aborted) return Promise.reject(new Error('Sign in again to save this change.'));
    const existing = [...this.mutations.values()].find(item => item.keys.some(key => keys.includes(key)));
    if (existing) {
      if (existing.keys.length === keys.length && existing.keys.every(key => keys.includes(key))) return existing.promise;
      const message = 'Another change to these events is saving. Review the series again after it finishes.';
      this.retryFailed = null;
      this.publish({ mutationError: message });
      return Promise.reject(new Error(message));
    }
    const id = Symbol();
    this.readRevision++;
    const promise = Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return write(signal);
    }).then(() => {
      if (this.disposed || signal.aborted) return;
      this.readRevision++;
      this.base = apply(this.base);
      this.mutations.delete(id);
      this.publish({});
      // An acknowledged write stays applied even if this reconciliation fails.
      void this.refresh(true).catch(() => {});
    }, error => {
      if (this.disposed || signal.aborted) return;
      this.readRevision++;
      this.mutations.delete(id);
      const conflict = keys.some(key => key.startsWith('event:')) && (error as { status?: number } | null)?.status === 409;
      this.retryFailed = conflict ? null : () => this.mutate(keys, apply, write, message);
      this.publish({ mutationError: conflict ? 'This event changed. Review its current details before cancelling again.' : message });
      void this.refresh(true).catch(() => {});
      throw error;
    });
    this.mutations.set(id, { keys, apply, promise });
    this.retryFailed = null;
    this.publish({ mutationError: null });
    return promise;
  }

  retryMutation = () => this.retryFailed?.() ?? Promise.resolve();

  setFeedback = (id: string, dismissed: boolean) => this.mutate(
    [`feedback:${id}`], state => feedbackState(state, id, dismissed),
    signal => digestClient.feedback(this.accountId, id, dismissed, signal),
    'Could not save dismissal. The item was restored. Try again.',
  );

  removeEvents = (events: CalendarEvent[], seriesId?: string) => events.length ? this.mutate(
    events.map(event => `event:${event.id}`), state => removedEventsState(state, events, seriesId),
    signal => seriesId ? digestClient.removeSeries(this.accountId, seriesId, events, signal)
      : digestClient.removeEvent(this.accountId, events[0], signal),
    'Could not confirm the cancellation. The event was restored. Try again.',
  ) : Promise.reject(new Error('Choose an event to cancel.'));

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
    const revision = this.readRevision;
    const report = (part: 'digest' | 'calendar', error: unknown) => {
      if (signal.aborted || revision !== this.readRevision) return;
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403) {
        this.mutations.clear();
        this.retryFailed = null;
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
      if (!signal.aborted && revision === this.readRevision) this.publish({ digest: value, digestError: null });
      return value;
    }).catch(error => { report('digest', error); throw error; });
    const calendar = digestClient.calendar(this.accountId, signal).then(value => {
      if (!signal.aborted && revision === this.readRevision) this.publish({ events: value.events, calendarLoaded: true, calendarError: null });
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
