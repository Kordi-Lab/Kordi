// Geometry for the still Kordi bird whose wing gap shows the window behind it
// (`KordiFlyingBird cutout` in the desktop app). The gap is a hole in the body
// path instead of an SVG mask, so it does not depend on mask rendering.
//
// Run `node scripts/kordi-app-icons/flyingBirdCutout.mjs` to print the paths;
// app/desktop/tests/kordiFlyingBird.test.tsx checks the component against them.

// Shared with KordiFlyingBird.tsx and icons.mjs, in the bird's own coordinates.
export const BODY_CENTER = { x: 262, y: 292, rx: 150, ry: 136 };
export const WING_ORIGIN = { x: 296, y: 262 };
export const WING_SEGMENTS = [
  [[0, 0], [40, -34], [120, -36], [165, 0]],
  [[165, 0], [120, 30], [40, 30], [0, 0]],
];
/** The still wing tilts up from its root, at the left middle of its bounds. */
export const WING_TILT_DEG = -24;
/** Gap between the wing and the body, in bird units. */
export const WING_GAP = 14;

const SAMPLES = 96;

function cubic([p0, p1, p2, p3], t) {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
}

function wingOutline() {
  return WING_SEGMENTS.flatMap((segment) => Array.from({ length: SAMPLES }, (_, i) => cubic(segment, i / SAMPLES)));
}

/** Maps wing coordinates to bird coordinates: tilt about the wing root, then place it. */
function wingTransform() {
  const points = wingOutline();
  const ys = points.map(([, y]) => y);
  const pivot = [Math.min(...points.map(([x]) => x)), (Math.min(...ys) + Math.max(...ys)) / 2];
  const angle = (WING_TILT_DEG * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ([x, y]) => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    return [WING_ORIGIN.x + pivot[0] + dx * cos - dy * sin, WING_ORIGIN.y + pivot[1] + dx * sin + dy * cos];
  };
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Clips `subject` to the convex polygon `clip` (both counter-clockwise in math orientation). */
function clipConvex(subject, clip) {
  let output = subject;
  for (let i = 0; i < clip.length && output.length; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p) => cross(a, b, p) >= 0;
    const intersect = (p, q) => {
      const d1 = cross(a, b, p);
      const d2 = cross(a, b, q);
      const t = d1 / (d1 - d2);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      if (inside(q)) {
        if (!inside(p)) output.push(intersect(p, q));
        output.push(q);
      } else if (inside(p)) {
        output.push(intersect(p, q));
      }
    }
  }
  return output;
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  let index = 0;
  let distance = 0;
  const length = Math.hypot(last[0] - first[0], last[1] - first[1]) || 1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = Math.abs(cross(first, last, points[i])) / length;
    if (d > distance) { index = i; distance = d; }
  }
  if (distance <= tolerance) return [first, last];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

const fmt = (n) => String(Math.round(n * 10) / 10);
const pointText = ([x, y]) => `${fmt(x)},${fmt(y)}`;

/** The wing in bird coordinates, already tilted, as a path. */
export function stillWingPath() {
  const place = wingTransform();
  return WING_SEGMENTS.map((segment, i) => {
    const [p0, p1, p2, p3] = segment.map(place);
    return `${i === 0 ? `M${pointText(p0)} ` : ''}C${pointText(p1)} ${pointText(p2)} ${pointText(p3)}`;
  }).join(' ') + 'Z';
}

function closedPath(polygon) {
  if (polygon.length < 3) return '';
  // Split the ring at its farthest point from the start so each half simplifies cleanly.
  let far = 1;
  for (let i = 1; i < polygon.length; i += 1) {
    if (Math.hypot(polygon[i][0] - polygon[0][0], polygon[i][1] - polygon[0][1])
      > Math.hypot(polygon[far][0] - polygon[0][0], polygon[far][1] - polygon[0][1])) far = i;
  }
  const points = [
    ...simplify(polygon.slice(0, far + 1), 0.25).slice(0, -1),
    ...simplify([...polygon.slice(far), polygon[0]], 0.25).slice(0, -1),
  ];
  return `M${points.map(pointText).join(' ')}Z`;
}

function grownWing(gap) {
  const place = wingTransform();
  const ring = Array.from({ length: 32 }, (_, i) => [Math.cos((i / 32) * 2 * Math.PI), Math.sin((i / 32) * 2 * Math.PI)]);
  return convexHull(wingOutline().map(place).flatMap(([x, y]) => ring.map(([cx, cy]) => [x + cx * gap, y + cy * gap])));
}

const TAIL_SEGMENTS = [
  [[400, 342], [436, 322], [462, 272], [470, 204]],
  [[470, 204], [448, 236], [420, 244], [386, 218]],
];

/** The part of the body the wing gap removes, as a closed path to add with `evenodd`. */
export function wingGapBodyHolePath() {
  const { x, y, rx, ry } = BODY_CENTER;
  const body = Array.from({ length: 720 }, (_, i) => {
    const a = (i / 720) * 2 * Math.PI;
    return [x + rx * Math.cos(a), y + ry * Math.sin(a)];
  });
  return closedPath(clipConvex(convexHull(body), grownWing(WING_GAP)));
}

/** The part of the tail the wing gap removes. The still bird draws its tail without a stroke. */
export function wingGapTailHolePath() {
  const tail = TAIL_SEGMENTS.flatMap((segment) => Array.from({ length: SAMPLES }, (_, i) => cubic(segment, i / SAMPLES)));
  const counterClockwise = cross(tail[0], tail[1], tail[2]) > 0 ? tail : [...tail].reverse();
  return closedPath(clipConvex(counterClockwise, grownWing(WING_GAP)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ wing: stillWingPath(), bodyHole: wingGapBodyHolePath(), tailHole: wingGapTailHolePath() }, null, 2));
}
