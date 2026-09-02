import { transcriptMessageDomId } from './transcriptNavigation';

const DELETE_DURATION_MS = 800;
const DISSOLVE_WAVE_MS = 600;
const MIN_PARTICLE_SIZE = 3;
const MAX_PARTICLES = 3_200;
const REDUCED_MOTION_DURATION_MS = 180;
const REFLOW_EASING = 'cubic-bezier(0.77, 0, 0.175, 1)';

type Particle = {
  x: number;
  y: number;
  size: number;
  activation: number;
  lifetime: number;
  velocityX: number;
  velocityY: number;
};

type MessageTexture = {
  rect: DOMRect;
  width: number;
  height: number;
  raster: HTMLCanvasElement;
  stationaryTexture: HTMLCanvasElement;
  stationaryContext: CanvasRenderingContext2D;
  particles: Particle[];
};

type ParticleRenderer = {
  canvas: HTMLCanvasElement;
  draw: (elapsedMs: number) => void;
  destroy: () => void;
};

export type PreparedMessageDeleteAnimation = {
  play: () => Promise<void>;
  cancel: () => void;
};

export function messageDeleteParticleActivation(y: number, height: number, noise: number) {
  if (height <= 0) return 0;
  return Math.max(0, Math.min(DISSOLVE_WAVE_MS, y / height * DISSOLVE_WAVE_MS + noise));
}

export function messageDeleteReflowOffset(beforeTop: number, afterTop: number) {
  return beforeTop - afterTop;
}

function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = Math.imul(value ^ value >>> 15, 1 | value);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function visibleMessageRects() {
  const result = new Map<string, number>();
  document.querySelectorAll<HTMLElement>('[data-transcript-message-root="true"][id]').forEach((element) => {
    result.set(element.id, element.getBoundingClientRect().top);
  });
  return result;
}

function findVisibleMessage(messageIds: Iterable<string>) {
  for (const messageId of messageIds) {
    const target = document.getElementById(transcriptMessageDomId(messageId));
    const root = target?.closest<HTMLElement>('[data-transcript-message-root="true"]') ?? null;
    if (root) return root;
  }
  return null;
}

function particleRegions(element: HTMLElement, rootRect: DOMRect) {
  const candidates = element.querySelectorAll<HTMLElement>([
    '[data-message-context-menu-anchor="true"]',
    '[data-avatar-kind]',
    '.app-message-meta',
  ].join(','));
  const regions = [...candidates].map((candidate) => {
    const rect = candidate.getBoundingClientRect();
    const left = Math.max(rootRect.left, rect.left) - rootRect.left;
    const top = Math.max(rootRect.top, rect.top) - rootRect.top;
    const right = Math.min(rootRect.right, rect.right) - rootRect.left;
    const bottom = Math.min(rootRect.bottom, rect.bottom) - rootRect.top;
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }).filter((rect) => rect.width > 0 && rect.height > 0);
  return regions.length > 0
    ? regions
    : [{ left: 0, top: 0, width: rootRect.width, height: rootRect.height }];
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not encode the message image.'));
    }, { once: true });
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('Could not read the message image.'));
    }, { once: true });
    reader.readAsDataURL(blob);
  });
}

async function inlineImages(source: HTMLElement, clone: HTMLElement) {
  const sourceImages = [...source.querySelectorAll('img')];
  const cloneImages = [...clone.querySelectorAll('img')];
  await Promise.all(sourceImages.map(async (image, index) => {
    const cloneImage = cloneImages[index];
    if (!cloneImage) return;
    try {
      const response = await fetch(image.currentSrc || image.src);
      if (!response.ok) return;
      cloneImage.src = await blobDataUrl(await response.blob());
    } catch {
      // The decoded DOM clone remains a valid fallback when an image cannot be inlined.
    }
  }));
}

async function renderElementImage(element: HTMLElement, rect: DOMRect) {
  const clone = element.cloneNode(true) as HTMLElement;
  const sources = [element, ...element.querySelectorAll<HTMLElement>('*')];
  const clones = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  sources.forEach((source, index) => {
    const target = clones[index];
    if (!target) return;
    const computed = getComputedStyle(source);
    for (const property of computed) {
      target.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
    target.style.animation = 'none';
    target.style.transition = 'none';
  });
  clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  Object.assign(clone.style, {
    position: 'relative',
    inset: 'auto',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    maxWidth: 'none',
    margin: '0',
    transform: 'none',
    translate: 'none',
    visibility: 'visible',
  });
  await inlineImages(element, clone);

  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const markup = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createMessageTexture(
  image: HTMLImageElement,
  rect: DOMRect,
  regions: ReturnType<typeof particleRegions>,
): MessageTexture {
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const reduced = document.createElement('canvas');
  reduced.width = Math.max(1, Math.ceil(width / 2));
  reduced.height = Math.max(1, Math.ceil(height / 2));
  reduced.getContext('2d')?.drawImage(image, 0, 0, reduced.width, reduced.height);

  const raster = document.createElement('canvas');
  raster.width = width;
  raster.height = height;
  const rasterContext = raster.getContext('2d');
  if (!rasterContext) throw new Error('Message particle canvas is unavailable.');
  rasterContext.imageSmoothingEnabled = false;
  rasterContext.drawImage(reduced, 0, 0, width, height);

  const stationaryTexture = document.createElement('canvas');
  stationaryTexture.width = width;
  stationaryTexture.height = height;
  const stationaryContext = stationaryTexture.getContext('2d');
  if (!stationaryContext) throw new Error('Message particle mask is unavailable.');

  const particleArea = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  const particleSize = Math.max(MIN_PARTICLE_SIZE, Math.ceil(Math.sqrt(particleArea / MAX_PARTICLES)));
  const rand = random(width * 31 + height * 17);
  const particles: Particle[] = [];
  const occupied = new Set<string>();
  for (const region of regions) {
    const left = Math.floor(region.left / particleSize) * particleSize;
    const top = Math.floor(region.top / particleSize) * particleSize;
    const right = Math.min(width, Math.ceil((region.left + region.width) / particleSize) * particleSize);
    const bottom = Math.min(height, Math.ceil((region.top + region.height) / particleSize) * particleSize);
    for (let y = top; y < bottom; y += particleSize) {
      for (let x = left; x < right; x += particleSize) {
        const key = `${x}:${y}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        const activation = messageDeleteParticleActivation(y, height, (rand() - 0.5) * 120);
        const direction = rand() * Math.PI * 2;
        const velocity = 38 + rand() * 50;
        particles.push({
          x,
          y,
          size: Math.min(particleSize, width - x, height - y),
          activation,
          lifetime: DELETE_DURATION_MS - activation,
          velocityX: Math.cos(direction) * velocity,
          velocityY: Math.sin(direction) * velocity,
        });
      }
    }
  }
  return { rect, width, height, raster, stationaryTexture, stationaryContext, particles };
}

function createOverlayCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(window.innerWidth * ratio);
  canvas.height = Math.ceil(window.innerHeight * ratio);
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:280;pointer-events:none;contain:strict;transform:translateZ(0);';
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Message deletion overlay is unavailable.');
  context.scale(ratio, ratio);
  document.body.append(canvas);
  return { canvas, context };
}

function drawDustFrame(context: CanvasRenderingContext2D, texture: MessageTexture, elapsed: number) {
  const dissolveProgress = Math.min(1, elapsed / DISSOLVE_WAVE_MS);
  const feather = Math.min(30, texture.height * 0.34);
  const boundary = -feather + (texture.height + feather * 2) * dissolveProgress;
  const stationary = texture.stationaryContext;
  stationary.clearRect(0, 0, texture.width, texture.height);
  stationary.globalCompositeOperation = 'source-over';
  stationary.drawImage(texture.raster, 0, 0);
  const gradient = stationary.createLinearGradient(0, boundary - feather, 0, boundary + feather);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
  stationary.globalCompositeOperation = 'destination-in';
  stationary.fillStyle = gradient;
  stationary.fillRect(0, 0, texture.width, texture.height);
  context.drawImage(
    texture.stationaryTexture,
    texture.rect.left,
    texture.rect.top,
    texture.rect.width,
    texture.rect.height,
  );

  for (const particle of texture.particles) {
    const age = elapsed - particle.activation;
    if (age <= 0 || age >= particle.lifetime) continue;
    const progress = age / particle.lifetime;
    const seconds = age / 1000;
    const size = particle.size * (1 - progress * 0.58);
    const x = texture.rect.left + particle.x + particle.velocityX * seconds;
    const y = texture.rect.top + particle.y + particle.velocityY * seconds - 58 * seconds ** 2;
    context.globalAlpha = Math.min(1, age / 70) * (1 - progress ** 1.7);
    context.drawImage(
      texture.raster,
      particle.x,
      particle.y,
      particle.size,
      particle.size,
      x,
      y,
      size,
      size,
    );
  }
  context.globalAlpha = 1;
}

function createParticleRenderer(texture: MessageTexture, reduceMotion: boolean): ParticleRenderer {
  const { canvas, context } = createOverlayCanvas();
  const duration = reduceMotion ? REDUCED_MOTION_DURATION_MS : DELETE_DURATION_MS;
  return {
    canvas,
    draw(elapsedMs) {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (reduceMotion) {
        context.globalAlpha = Math.max(0, 1 - elapsedMs / duration);
        context.drawImage(
          texture.raster,
          texture.rect.left,
          texture.rect.top,
          texture.rect.width,
          texture.rect.height,
        );
        context.globalAlpha = 1;
        return;
      }
      drawDustFrame(context, texture, elapsedMs);
    },
    destroy() {
      canvas.remove();
    },
  };
}

function prepareReflow(before: Map<string, number>, duration: number) {
  const moves = [...document.querySelectorAll<HTMLElement>('[data-transcript-message-root="true"][id]')]
    .map((element) => ({
      element,
      beforeTop: before.get(element.id),
      afterTop: element.getBoundingClientRect().top,
    }))
    .filter((move): move is { element: HTMLElement; beforeTop: number; afterTop: number } => (
      move.beforeTop !== undefined
      && Math.abs(messageDeleteReflowOffset(move.beforeTop, move.afterTop)) >= 0.5
    ));
  return moves.map(({ element, beforeTop, afterTop }) => {
    const offset = messageDeleteReflowOffset(beforeTop, afterTop);
    const animation = element.animate(
      [{ transform: `translate3d(0, ${offset}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration, easing: REFLOW_EASING, fill: 'both' },
    );
    animation.pause();
    animation.currentTime = 0;
    return animation;
  });
}

export async function prepareMessageDeleteAnimation(
  messageIds: Iterable<string>,
): Promise<PreparedMessageDeleteAnimation | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const target = findVisibleMessage(messageIds);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const before = visibleMessageRects();
  const regions = particleRegions(target, rect);
  const image = await renderElementImage(target, rect);
  const texture = createMessageTexture(image, rect, regions);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const duration = reduceMotion ? REDUCED_MOTION_DURATION_MS : DELETE_DURATION_MS;
  let cancelled = false;
  let renderer: ParticleRenderer | null = null;
  let animations: Animation[] = [];

  return {
    cancel() {
      cancelled = true;
      animations.forEach((animation) => animation.cancel());
      renderer?.destroy();
      renderer = null;
    },
    async play() {
      if (cancelled) return;
      animations = prepareReflow(before, duration);
      renderer = createParticleRenderer(texture, reduceMotion);
      renderer.draw(0);
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame((startTime) => {
          if (cancelled) {
            resolve();
            return;
          }
          animations.forEach((animation) => animation.play());
          const frame = (time: number) => {
            if (cancelled) {
              resolve();
              return;
            }
            const elapsed = Math.min(duration, time - startTime);
            renderer?.draw(elapsed);
            if (elapsed < duration) window.requestAnimationFrame(frame);
            else resolve();
          };
          frame(startTime);
        });
      });
      await Promise.allSettled(animations.map((animation) => animation.finished));
      animations.forEach((animation) => animation.cancel());
      renderer?.destroy();
      renderer = null;
    },
  };
}
