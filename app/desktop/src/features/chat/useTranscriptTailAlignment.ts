import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { transcriptLayoutMaxScrollTop } from './virtualTranscriptLayout';
import { alignAndRevealMeasuredTranscriptRows, cancelTranscriptRowLift, captureTranscriptRowLayoutTops } from './virtualTranscriptMotion';

type TailAlignmentOptions = {
  internalScrollRef: MutableRefObject<HTMLDivElement | null>;
  viewportWasAtTailRef: MutableRefObject<boolean>;
  tailAlignmentActiveRef: MutableRefObject<boolean>;
  tailAlignmentTargetRef: MutableRefObject<number | null>;
  tailLiftRowsRef: MutableRefObject<HTMLElement[]>;
  sizeContainerRef: MutableRefObject<HTMLDivElement | null>;
  virtualizer: Parameters<typeof alignAndRevealMeasuredTranscriptRows>[0]['virtualizer'];
  gap: number;
  animateTailResize?: boolean;
  hasItems?: boolean;
  suspendTailResize?: boolean;
  setIsAtTail: (value: boolean) => void;
  onTailChange?: (value: boolean) => void;
};

/** Own measurement, tail alignment, and presentation motion as one operation. */
export function useTranscriptTailAlignment({
  internalScrollRef, viewportWasAtTailRef, tailAlignmentActiveRef, tailAlignmentTargetRef,
  tailLiftRowsRef, sizeContainerRef, virtualizer, gap, setIsAtTail, onTailChange, animateTailResize = false, hasItems = true, suspendTailResize = false,
}: TailAlignmentOptions) {
  const tailAlignmentFrameRef = useRef<number | null>(null);
  const rowLayoutTopsRef = useRef(new Map<HTMLElement, number>());

  const cancelTailLiftAnimation = useCallback(() => {
    cancelTranscriptRowLift(tailLiftRowsRef.current);
    tailLiftRowsRef.current = [];
  }, [tailLiftRowsRef]);

  const cancelTailAlignment = useCallback(() => {
    cancelTailLiftAnimation();
    tailAlignmentActiveRef.current = false;
    tailAlignmentTargetRef.current = null;
    if (tailAlignmentFrameRef.current !== null) {
      window.cancelAnimationFrame(tailAlignmentFrameRef.current);
      tailAlignmentFrameRef.current = null;
    }
  }, [cancelTailLiftAnimation, tailAlignmentActiveRef, tailAlignmentTargetRef]);

  const alignViewportToTail = useCallback(() => {
    const element = internalScrollRef.current;
    if (!element) return;
    const target = transcriptLayoutMaxScrollTop(element);
    tailAlignmentTargetRef.current = target;
    element.scrollTop = target;
    viewportWasAtTailRef.current = true;
    setIsAtTail(true);
    onTailChange?.(true);
  }, [internalScrollRef, tailAlignmentTargetRef, viewportWasAtTailRef, setIsAtTail, onTailChange]);

  const handleUserWheel = useCallback((event: { deltaY: number }) => {
    cancelTailAlignment();
    if (event.deltaY < 0) {
      // Record reading intent before the browser delivers its scroll event;
      // an intervening layout must not re-arm the four-frame tail correction.
      viewportWasAtTailRef.current = false;
      setIsAtTail(false);
      onTailChange?.(false);
    }
  }, [cancelTailAlignment, onTailChange, setIsAtTail, viewportWasAtTailRef]);

  const scheduleTailAlignment = useCallback((revealFromIndex?: number) => {
    if (tailAlignmentFrameRef.current !== null) {
      window.cancelAnimationFrame(tailAlignmentFrameRef.current);
    }
    tailAlignmentActiveRef.current = true;
    const liftedRows = alignAndRevealMeasuredTranscriptRows({
      alignToTail: alignViewportToTail,
      gap,
      reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      revealFromIndex,
      previousRowTops: rowLayoutTopsRef.current,
      progressMotion: animateTailResize,
      sizeContainer: sizeContainerRef.current,
      virtualizer,
    });
    if (revealFromIndex !== undefined) tailLiftRowsRef.current = liftedRows;
    rowLayoutTopsRef.current = captureTranscriptRowLayoutTops(sizeContainerRef.current);
    let framesRemaining = 4;
    const settle = () => {
      tailAlignmentFrameRef.current = null;
      if (!tailAlignmentActiveRef.current) return;
      alignViewportToTail();
      framesRemaining -= 1;
      if (framesRemaining > 0) {
        tailAlignmentFrameRef.current = window.requestAnimationFrame(settle);
      }
    };
    tailAlignmentFrameRef.current = window.requestAnimationFrame(settle);
  }, [alignViewportToTail, animateTailResize, gap, virtualizer, tailAlignmentActiveRef, tailLiftRowsRef, sizeContainerRef]);

  useLayoutEffect(() => {
    const container = sizeContainerRef.current;
    if (!hasItems || suspendTailResize || !container || typeof MutationObserver === 'undefined') return;
    let lastHeight = container.style.height;
    // The virtualizer can adjust scrollTop before publishing a larger extent;
    // the browser clamps that write against the old height. Repair the tail
    // in this mutation microtask, before paint, for Human and Agent histories.
    // A later animation frame exposes the moved rows for one frame first.
    const observer = new MutationObserver(() => {
      const height = container.style.height;
      if (height === lastHeight) return;
      lastHeight = height;
      if (!viewportWasAtTailRef.current && !tailAlignmentActiveRef.current) return;
      if (animateTailResize) scheduleTailAlignment(Number.MAX_SAFE_INTEGER);
      else alignViewportToTail();
    });
    observer.observe(container, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [alignViewportToTail, animateTailResize, hasItems, scheduleTailAlignment, sizeContainerRef, suspendTailResize, tailAlignmentActiveRef, viewportWasAtTailRef]);

  return { cancelTailLiftAnimation, cancelTailAlignment, handleUserWheel, scheduleTailAlignment };
}
