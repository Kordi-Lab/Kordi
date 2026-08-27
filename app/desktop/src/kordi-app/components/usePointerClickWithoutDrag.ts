import { useRef, type MouseEvent, type PointerEvent } from 'react';

import { hasMessageSelectionDragExceededThreshold } from '@/features/chat/messageSelection';

type PointerStart = { pointerId: number; x: number; y: number; moved: boolean };

export function usePointerClickWithoutDrag(
  onClick: (event: MouseEvent<HTMLButtonElement>) => void,
) {
  const pointerRef = useRef<PointerStart | null>(null);
  const suppressClickUntilRef = useRef(0);
  const moved = (event: PointerEvent<HTMLButtonElement>, start: PointerStart) => (
    start.moved || hasMessageSelectionDragExceededThreshold(
      { x: start.x, y: start.y },
      { x: event.clientX, y: event.clientY },
    )
  );

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      suppressClickUntilRef.current = 0;
      pointerRef.current = event.button === 0
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
        : null;
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const start = pointerRef.current;
      if (!start || start.pointerId !== event.pointerId || start.moved) return;
      start.moved = moved(event, start);
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const start = pointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (moved(event, start)) suppressClickUntilRef.current = Date.now() + 500;
      pointerRef.current = null;
    },
    onPointerCancel() { pointerRef.current = null; },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (event.detail > 0 && Date.now() < suppressClickUntilRef.current) {
        suppressClickUntilRef.current = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick(event);
    },
  };
}
