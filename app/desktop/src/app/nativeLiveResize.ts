import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const NATIVE_LIVE_RESIZE_START_EVENT = 'kordi-native-live-resize-start';
export const NATIVE_LIVE_RESIZE_END_EVENT = 'kordi-native-live-resize-end';
export const NATIVE_LIVE_RESIZE_CLASS = 'kordi-native-live-resize';

export type NativeLiveResizeDirection =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type NativeLiveResizeSnapshot = {
  active: boolean;
  direction: NativeLiveResizeDirection | null;
  sequence: number;
};

type NativeLiveResizeSubscriber = (snapshot: NativeLiveResizeSnapshot) => void;

const DIRECTIONS = new Set<NativeLiveResizeDirection>([
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]);

const subscribers = new Set<NativeLiveResizeSubscriber>();
let snapshot: NativeLiveResizeSnapshot = {
  active: false,
  direction: null,
  sequence: 0,
};
let releaseFrame: number | null = null;
let releasePaintFrame: number | null = null;

function normalizeDirection(value: unknown): NativeLiveResizeDirection | null {
  return typeof value === 'string' && DIRECTIONS.has(value as NativeLiveResizeDirection)
    ? value as NativeLiveResizeDirection
    : null;
}

function notifySubscribers() {
  for (const subscriber of subscribers) subscriber(snapshot);
}

function cancelClassRelease() {
  if (typeof window === 'undefined') return;
  if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
  if (releasePaintFrame !== null) window.cancelAnimationFrame(releasePaintFrame);
  releaseFrame = null;
  releasePaintFrame = null;
}

function updateDocumentState(active: boolean, direction: NativeLiveResizeDirection | null) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(NATIVE_LIVE_RESIZE_CLASS, active);
  if (direction) {
    document.documentElement.dataset.nativeLiveResizeDirection = direction;
  } else {
    delete document.documentElement.dataset.nativeLiveResizeDirection;
  }
}

export function beginNativeLiveResize(value: unknown) {
  const direction = normalizeDirection(value);
  if (!direction) return;
  cancelClassRelease();
  snapshot = {
    active: true,
    direction,
    sequence: snapshot.sequence + 1,
  };
  updateDocumentState(true, direction);
  notifySubscribers();
}

export function endNativeLiveResize(value: unknown) {
  const direction = normalizeDirection(value) ?? snapshot.direction;
  snapshot = {
    active: false,
    direction,
    sequence: snapshot.sequence + 1,
  };
  notifySubscribers();

  if (typeof window === 'undefined') {
    updateDocumentState(false, null);
    return;
  }
  cancelClassRelease();
  releaseFrame = window.requestAnimationFrame(() => {
    releaseFrame = null;
    releasePaintFrame = window.requestAnimationFrame(() => {
      releasePaintFrame = null;
      if (!snapshot.active) updateDocumentState(false, null);
    });
  });
}

export function getNativeLiveResizeSnapshot() {
  return snapshot;
}

export function subscribeNativeLiveResize(subscriber: NativeLiveResizeSubscriber) {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function resetNativeLiveResizeState() {
  cancelClassRelease();
  snapshot = {
    active: false,
    direction: null,
    sequence: snapshot.sequence + 1,
  };
  updateDocumentState(false, null);
  notifySubscribers();
}

export async function installNativeLiveResizeBridge() {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(await listen<unknown>(NATIVE_LIVE_RESIZE_START_EVENT, ({ payload }) => {
      beginNativeLiveResize(payload);
    }));
    unlisteners.push(await listen<unknown>(NATIVE_LIVE_RESIZE_END_EVENT, ({ payload }) => {
      endNativeLiveResize(payload);
    }));
  } catch (error) {
    for (const unlisten of unlisteners) unlisten();
    throw error;
  }

  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
