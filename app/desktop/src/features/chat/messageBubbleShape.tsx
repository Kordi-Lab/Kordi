import { useLayoutEffect, useRef } from 'react';

import { createNativeLiveResizeRectGate } from '@/app/nativeLiveResizeRect';
import {
  getNativeLiveResizeSnapshot,
  subscribeNativeLiveResize,
} from '@/app/nativeLiveResize';

export type HumanMessageBubbleSide = 'own' | 'peer';

type MessageBubbleShapeSize = {
  width: number;
  height: number;
};

const MESSAGE_BUBBLE_TAIL_WIDTH = 8;
const MESSAGE_BUBBLE_TAIL_HEIGHT = 14;
const MESSAGE_BUBBLE_RADIUS = 8;
const MESSAGE_BUBBLE_MIN_WIDTH = 52;
const MESSAGE_BUBBLE_MIN_HEIGHT = 32;
const DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE: MessageBubbleShapeSize = {
  width: 148 + MESSAGE_BUBBLE_TAIL_WIDTH,
  height: 44,
};

function coordinate(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/\.0+$/, '').replace(/0+$/, '');
}

function command(parts: Array<string | number>) {
  return parts.map((part) => (typeof part === 'number' ? coordinate(part) : part)).join(' ');
}

export function messageBubbleShapePath(side: HumanMessageBubbleSide, size: MessageBubbleShapeSize) {
  const width = Math.max(MESSAGE_BUBBLE_MIN_WIDTH, Math.round(size.width));
  const height = Math.max(MESSAGE_BUBBLE_MIN_HEIGHT, Math.round(size.height));
  const radius = Math.min(MESSAGE_BUBBLE_RADIUS, Math.floor((height - 2) / 2));
  const tailHeight = Math.min(MESSAGE_BUBBLE_TAIL_HEIGHT, Math.max(10, Math.round(height * 0.34)));
  const sideTailStartY = height - tailHeight;

  if (side === 'own') {
    const bodyLeft = 0;
    const bodyRight = width - MESSAGE_BUBBLE_TAIL_WIDTH;
    const tailReturnX = Math.max(bodyLeft + radius, bodyRight - 18);

    return [
      command(['M', bodyLeft + radius, 0]),
      command(['H', bodyRight - radius]),
      command(['C', bodyRight - radius / 2, 0, bodyRight, radius / 2, bodyRight, radius]),
      command(['V', sideTailStartY]),
      command(['C', bodyRight, height - 7, bodyRight + 3, height - 1, width, height]),
      command(['C', bodyRight + 1, height, bodyRight - 7, height, tailReturnX, height]),
      command(['H', bodyLeft + radius]),
      command(['C', bodyLeft + radius / 2, height, bodyLeft, height - radius / 2, bodyLeft, height - radius]),
      command(['V', radius]),
      command(['C', bodyLeft, radius / 2, bodyLeft + radius / 2, 0, bodyLeft + radius, 0]),
      'Z',
    ].join(' ');
  }

  const bodyLeft = MESSAGE_BUBBLE_TAIL_WIDTH;
  const bodyRight = width;
  const tailReturnX = Math.min(bodyRight - radius, bodyLeft + 18);

  return [
    command(['M', bodyRight - radius, 0]),
    command(['H', bodyLeft + radius]),
    command(['C', bodyLeft + radius / 2, 0, bodyLeft, radius / 2, bodyLeft, radius]),
    command(['V', sideTailStartY]),
    command(['C', bodyLeft, height - 7, bodyLeft - 3, height - 1, 0, height]),
    command(['C', bodyLeft - 1, height, bodyLeft + 7, height, tailReturnX, height]),
    command(['H', bodyRight - radius]),
    command(['C', bodyRight - radius / 2, height, bodyRight, height - radius / 2, bodyRight, height - radius]),
    command(['V', radius]),
    command(['C', bodyRight, radius / 2, bodyRight - radius / 2, 0, bodyRight - radius, 0]),
    'Z',
  ].join(' ');
}

export function humanMessageBubbleShapeClass(side: HumanMessageBubbleSide) {
  return `app-message-bubble app-message-bubble-${side}`;
}

export const queuedMessageBubbleShapeClass = `${humanMessageBubbleShapeClass('own')} app-message-bubble-queued`;

type MessageBubbleShapeBackdropProps = {
  side: HumanMessageBubbleSide;
};

export function MessageBubbleShapeBackdrop({ side }: MessageBubbleShapeBackdropProps) {
  const shapeRef = useRef<SVGSVGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);

  useLayoutEffect(() => {
    const shape = shapeRef.current;
    const path = pathRef.current;
    const parent = shape?.parentElement;

    if (!shape || !path || !parent) return undefined;

    const readSize = () => {
      const rect = parent.getBoundingClientRect();
      return {
        width: Math.max(MESSAGE_BUBBLE_MIN_WIDTH, Math.round(rect.width) + MESSAGE_BUBBLE_TAIL_WIDTH),
        height: Math.max(MESSAGE_BUBBLE_MIN_HEIGHT, Math.round(rect.height)),
      };
    };
    const applySize = (size: MessageBubbleShapeSize) => {
      shape.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
      path.setAttribute('d', messageBubbleShapePath(side, size));
    };
    const gate = createNativeLiveResizeRectGate(applySize, {
      schedule: (run) => window.requestAnimationFrame(run),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    });

    gate.receive(readSize(), getNativeLiveResizeSnapshot());

    if (typeof ResizeObserver === 'undefined') {
      return () => gate.dispose();
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.borderBoxSize?.[0];
      const size = box
        ? {
            width: Math.max(MESSAGE_BUBBLE_MIN_WIDTH, Math.round(box.inlineSize) + MESSAGE_BUBBLE_TAIL_WIDTH),
            height: Math.max(MESSAGE_BUBBLE_MIN_HEIGHT, Math.round(box.blockSize)),
          }
        : readSize();
      gate.receive(size, getNativeLiveResizeSnapshot());
    });
    resizeObserver.observe(parent);
    const unsubscribe = subscribeNativeLiveResize((state) => {
      if (!state.active) gate.finish(readSize());
    });

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      gate.dispose();
    };
  }, [side]);

  return (
    <svg
      ref={shapeRef}
      aria-hidden="true"
      className="app-message-bubble-shape"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE.width} ${DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE.height}`}
    >
      <path
        ref={pathRef}
        className="app-message-bubble-shape-fill"
        d={messageBubbleShapePath(side, DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE)}
      />
    </svg>
  );
}
