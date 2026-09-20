import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export type HumanMessageBubbleSide = 'own' | 'peer';

type MessageBubbleShapeSize = {
  width: number;
  height: number;
};

export type MessageBubbleShapeOptions = {
  tail?: boolean;
  groupedWithPrevious?: boolean;
};

// Kordi runs a squarer corner pair than Telegram Web K's 5px/15px.
const MESSAGE_BUBBLE_RADIUS_OUTER = 6;
const MESSAGE_BUBBLE_RADIUS_INNER = 4;

// Telegram Web K's message tail (#message-tail-filled, an 11x20 symbol) expressed in
// bubble-local coordinates: it rides the bubble edge 17px up from the bottom, reaches
// 6.675px past that edge, and closes back onto the bottom edge with a 1px arc.
const MESSAGE_BUBBLE_TAIL_ATTACH = 17;
const MESSAGE_BUBBLE_TAIL_INSET = 6;
export const MESSAGE_BUBBLE_TAIL_REACH = 6.675;
const MESSAGE_BUBBLE_TAIL_ARC = { x: MESSAGE_BUBBLE_TAIL_REACH, y: 1.738 };
type MessageBubbleTailSegment = readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
// Cubic segments from the bubble edge out to the tail tip.
const MESSAGE_BUBBLE_TAIL_OUTWARD: readonly MessageBubbleTailSegment[] = [
  [[0.193, 14.16], [0.876, 11.233], [2.05, 8.218]],
  [[2.954, 5.893], [4.496, 3.733], [6.675, 1.738]],
];
// The same curve walked back from the tip to the bubble edge.
const MESSAGE_BUBBLE_TAIL_INWARD: readonly MessageBubbleTailSegment[] = [
  [[4.496, 3.733], [2.954, 5.893], [2.05, 8.218]],
  [[0.876, 11.233], [0.193, 14.16], [0, MESSAGE_BUBBLE_TAIL_ATTACH]],
];

const MESSAGE_BUBBLE_MIN_WIDTH = 52;
const MESSAGE_BUBBLE_MIN_HEIGHT = 32;
const DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE: MessageBubbleShapeSize = {
  width: 148,
  height: 44,
};

function coordinate(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function command(parts: Array<string | number>) {
  return parts.map((part) => (typeof part === 'number' ? coordinate(part) : part)).join(' ');
}

function roundedCorner(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cornerX: number,
  cornerY: number,
  radius: number,
) {
  if (radius <= 0) {
    return command(['L', toX, toY]);
  }

  return command([
    'C',
    (fromX + cornerX) / 2, (fromY + cornerY) / 2,
    (toX + cornerX) / 2, (toY + cornerY) / 2,
    toX, toY,
  ]);
}

function tailCubics(
  baseX: number,
  segments: readonly MessageBubbleTailSegment[],
  direction: -1 | 1,
  bottom: number,
) {
  return segments.map((segment) => {
    const coordinates: number[] = [];

    for (const [x, y] of segment) {
      coordinates.push(baseX + direction * x, bottom - y);
    }

    return command(['C', ...coordinates]);
  });
}

export function messageBubbleShapePath(
  side: HumanMessageBubbleSide,
  size: MessageBubbleShapeSize,
  options: MessageBubbleShapeOptions = {},
) {
  const { tail = true, groupedWithPrevious = false } = options;
  const width = Math.max(MESSAGE_BUBBLE_MIN_WIDTH, Math.round(size.width));
  const height = Math.max(MESSAGE_BUBBLE_MIN_HEIGHT, Math.round(size.height));

  const limit = Math.max(0, Math.floor(height / 2));
  const outer = Math.min(MESSAGE_BUBBLE_RADIUS_OUTER, limit);
  const inner = Math.min(MESSAGE_BUBBLE_RADIUS_INNER, limit);
  const stacked = groupedWithPrevious ? inner : outer;

  // The tail always rides the bubble's lower outer corner, so that corner squares off and
  // only the final message of a run is allowed to grow one.
  const [topLeft, topRight, bottomRight, bottomLeft] = side === 'own'
    ? [outer, stacked, tail ? 0 : inner, outer]
    : [stacked, outer, outer, tail ? 0 : inner];

  const right = width;
  const bottom = height;
  const segments = [
    command(['M', topLeft, 0]),
    command(['H', right - topRight]),
    roundedCorner(right - topRight, 0, right, topRight, right, 0, topRight),
  ];

  if (tail && side === 'own') {
    segments.push(
      command(['V', bottom - MESSAGE_BUBBLE_TAIL_ATTACH]),
      ...tailCubics(right, MESSAGE_BUBBLE_TAIL_OUTWARD, 1, bottom),
      command(['A', 1, 1, 0, 0, 0, right + MESSAGE_BUBBLE_TAIL_INSET, bottom]),
    );
  } else {
    segments.push(
      command(['V', bottom - bottomRight]),
      roundedCorner(right, bottom - bottomRight, right - bottomRight, bottom, right, bottom, bottomRight),
    );

    if (tail) {
      segments.push(
        command(['H', 0]),
        command(['L', -MESSAGE_BUBBLE_TAIL_INSET, bottom]),
        command(['A', 1, 1, 0, 0, 1, -MESSAGE_BUBBLE_TAIL_ARC.x, bottom - MESSAGE_BUBBLE_TAIL_ARC.y]),
        ...tailCubics(0, MESSAGE_BUBBLE_TAIL_INWARD, -1, bottom),
      );
    }
  }

  // An incoming tail swallows the lower-left corner; every other outline keeps it.
  if (!tail || side === 'own') {
    segments.push(
      command(['H', bottomLeft]),
      roundedCorner(bottomLeft, bottom, 0, bottom - bottomLeft, 0, bottom, bottomLeft),
    );
  }

  segments.push(
    command(['V', topLeft]),
    roundedCorner(0, topLeft, topLeft, 0, 0, 0, topLeft),
    'Z',
  );

  return segments.join(' ');
}

export function humanMessageBubbleShapeClass(side: HumanMessageBubbleSide) {
  return `app-message-bubble app-message-bubble-${side}`;
}

export const queuedMessageBubbleShapeClass = `${humanMessageBubbleShapeClass('own')} app-message-bubble-queued`;

type MessageBubbleShapeBackdropProps = {
  side: HumanMessageBubbleSide;
  tail?: boolean;
  groupedWithPrevious?: boolean;
};

export function MessageBubbleShapeBackdrop({
  side,
  tail = true,
  groupedWithPrevious = false,
}: MessageBubbleShapeBackdropProps) {
  const shapeRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState(DEFAULT_MESSAGE_BUBBLE_SHAPE_SIZE);

  useLayoutEffect(() => {
    const parent = shapeRef.current?.parentElement;

    if (!parent) {
      return;
    }

    const updateSize = () => {
      const rect = parent.getBoundingClientRect();
      const nextSize = {
        width: Math.max(MESSAGE_BUBBLE_MIN_WIDTH, Math.round(rect.width)),
        height: Math.max(MESSAGE_BUBBLE_MIN_HEIGHT, Math.round(rect.height)),
      };

      setSize((previousSize) => (
        previousSize.width === nextSize.width && previousSize.height === nextSize.height
          ? previousSize
          : nextSize
      ));
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(parent);

    return () => resizeObserver.disconnect();
  }, []);

  const path = useMemo(
    () => messageBubbleShapePath(side, size, { tail, groupedWithPrevious }),
    [groupedWithPrevious, side, size, tail],
  );

  // The canvas always reserves the tail reach on the tail's side, so the tail never has to
  // render outside the SVG viewport.
  const viewBoxX = side === 'own' ? 0 : -MESSAGE_BUBBLE_TAIL_REACH;
  const viewBoxWidth = size.width + MESSAGE_BUBBLE_TAIL_REACH;

  return (
    <svg
      ref={shapeRef}
      aria-hidden="true"
      className="app-message-bubble-shape"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`${viewBoxX} 0 ${viewBoxWidth} ${size.height}`}
    >
      <path className="app-message-bubble-shape-fill" d={path} />
    </svg>
  );
}
