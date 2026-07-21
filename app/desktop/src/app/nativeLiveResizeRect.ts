import {
  observeElementRect,
  type Rect,
} from '@tanstack/react-virtual';

import {
  getNativeLiveResizeSnapshot,
  subscribeNativeLiveResize,
  type NativeLiveResizeSnapshot,
} from '@/app/nativeLiveResize';

type FrameScheduler = {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

function isVerticalOnlyResize(snapshot: NativeLiveResizeSnapshot) {
  return snapshot.direction === 'top' || snapshot.direction === 'bottom';
}

function sameRect(left: Rect | null, right: Rect) {
  return left?.width === right.width && left.height === right.height;
}

export function createNativeLiveResizeRectGate(
  emit: (rect: Rect) => void,
  scheduler: FrameScheduler,
) {
  let pendingRect: Rect | null = null;
  let emittedRect: Rect | null = null;
  let frameHandle: number | null = null;

  const cancelFrame = () => {
    if (frameHandle === null) return;
    scheduler.cancel(frameHandle);
    frameHandle = null;
  };

  const flush = () => {
    frameHandle = null;
    const rect = pendingRect;
    if (!rect || sameRect(emittedRect, rect)) return;
    emittedRect = rect;
    emit(rect);
  };

  return {
    receive(rect: Rect, state: NativeLiveResizeSnapshot) {
      pendingRect = rect;
      if (!state.active) {
        cancelFrame();
        flush();
        return;
      }
      if (isVerticalOnlyResize(state) || frameHandle !== null) return;
      frameHandle = scheduler.schedule(flush);
    },
    finish(rect?: Rect) {
      if (rect) pendingRect = rect;
      cancelFrame();
      flush();
    },
    dispose() {
      cancelFrame();
      pendingRect = null;
    },
  };
}

export const observeElementRectWithNativeResize: typeof observeElementRect = (
  instance,
  callback,
) => {
  const targetWindow = instance.targetWindow;
  const element = instance.scrollElement as HTMLElement | null;
  if (!targetWindow || !element) return undefined;

  const readCurrentRect = (): Rect => ({
    width: Math.round(element.offsetWidth),
    height: Math.round(element.offsetHeight),
  });
  const gate = createNativeLiveResizeRectGate(callback, {
    schedule: (run) => targetWindow.requestAnimationFrame(run),
    cancel: (handle) => targetWindow.cancelAnimationFrame(handle),
  });
  const receive = (rect: Rect) => gate.receive({
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }, getNativeLiveResizeSnapshot());
  receive(readCurrentRect());

  const observer = targetWindow.ResizeObserver
    ? new targetWindow.ResizeObserver((entries) => {
        const entry = entries[0];
        const box = entry?.borderBoxSize?.[0];
        receive(box
          ? { width: box.inlineSize, height: box.blockSize }
          : readCurrentRect());
      })
    : null;
  observer?.observe(element, { box: 'border-box' });
  const unsubscribe = subscribeNativeLiveResize((state) => {
    if (!state.active) gate.finish(readCurrentRect());
  });

  return () => {
    unsubscribe();
    observer?.unobserve(element);
    gate.dispose();
  };
};
