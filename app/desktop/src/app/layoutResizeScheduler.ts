export const NATIVE_LAYOUT_RESIZE_SETTLE_MS = 120;

type LayoutResizeSchedulerOptions = {
  onResizeStart: () => void;
  onResizeFrame: () => void;
  onResizeEnd: () => void;
  scheduleFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  scheduleTimeout: (callback: () => void, delayMs: number) => number;
  cancelTimeout: (handle: number) => void;
  settleDelayMs?: number;
};

export function createLayoutResizeScheduler({
  onResizeStart,
  onResizeFrame,
  onResizeEnd,
  scheduleFrame,
  cancelFrame,
  scheduleTimeout,
  cancelTimeout,
  settleDelayMs = NATIVE_LAYOUT_RESIZE_SETTLE_MS,
}: LayoutResizeSchedulerOptions) {
  let active = false;
  let frameHandle: number | null = null;
  let settleHandle: number | null = null;

  const finish = () => {
    settleHandle = null;
    if (!active) return;

    // WebKit can throttle animation frames while macOS is in a native live
    // resize loop. Flush the last measurement before ending resize mode so a
    // stale frame cannot land afterwards and animate the final geometry.
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
      onResizeFrame();
    }

    active = false;
    onResizeEnd();
  };

  return {
    notifyResize() {
      if (!active) {
        active = true;
        onResizeStart();
      }

      if (frameHandle === null) {
        frameHandle = scheduleFrame(() => {
          frameHandle = null;
          if (!active) return;
          onResizeFrame();
        });
      }

      if (settleHandle !== null) cancelTimeout(settleHandle);
      settleHandle = scheduleTimeout(finish, settleDelayMs);
    },

    dispose() {
      if (frameHandle !== null) cancelFrame(frameHandle);
      if (settleHandle !== null) cancelTimeout(settleHandle);
      frameHandle = null;
      settleHandle = null;
      if (!active) return;
      active = false;
      onResizeEnd();
    },
  };
}
