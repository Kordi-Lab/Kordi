const NAVIGATION_HIGHLIGHT_MAX_ATTEMPTS = 12;

export function scheduleTranscriptNavigationReveal({
  reveal,
  onSettled,
}: {
  reveal: () => boolean | void;
  onSettled: () => void;
}) {
  let frameId: number | null = null;
  let attemptCount = 0;

  const revealMountedTarget = () => {
    frameId = null;
    attemptCount += 1;
    if (reveal() === false && attemptCount < NAVIGATION_HIGHLIGHT_MAX_ATTEMPTS) {
      frameId = window.requestAnimationFrame(revealMountedTarget);
      return;
    }
    onSettled();
  };

  frameId = window.requestAnimationFrame(revealMountedTarget);
  return () => {
    if (frameId !== null) window.cancelAnimationFrame(frameId);
  };
}
