import type { CSSProperties } from 'react';
import manifest from '../../assets/noto-thumbnails/manifest.json';

// Keep literal URLs so Vite fingerprints and bundles every sheet. No CDN or
// native IPC is involved in rendering the picker, including its first open.
export const notoThumbnailSheets = [
  new URL('../../assets/noto-thumbnails/atlas-0.webp', import.meta.url).href,
  new URL('../../assets/noto-thumbnails/atlas-1.webp', import.meta.url).href,
  new URL('../../assets/noto-thumbnails/atlas-2.webp', import.meta.url).href,
  new URL('../../assets/noto-thumbnails/atlas-3.webp', import.meta.url).href,
];
const thumbnailIndex = new Map(manifest.ids.map((id, index) => [id, index]));

export function notoThumbnailStyle(id: string): CSSProperties {
  const index = thumbnailIndex.get(id);
  if (index === undefined) throw new Error('Noto thumbnail must belong to the bundled catalog.');
  const sheet = Math.floor(index / manifest.perSheet);
  const cell = index % manifest.perSheet;
  const column = cell % manifest.columns;
  const row = Math.floor(cell / manifest.columns);
  const rows = manifest.sheets[sheet].rows;
  return {
    backgroundImage: `url("${notoThumbnailSheets[sheet]}")`,
    backgroundSize: `${manifest.columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${column * 100 / (manifest.columns - 1)}% ${rows === 1 ? 0 : row * 100 / (rows - 1)}%`,
  };
}

// Retain the four decoded sources for subsequent picker mounts. This starts
// with the app, rather than waiting for the user to open a conversation picker.
const decodedSheets: HTMLImageElement[] = [];
let preload: Promise<void> | undefined;
export function preloadNotoEmojiThumbnails(): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  if (!preload && typeof document !== 'undefined') {
    // Keep CSS image resources alive too: some engines release background
    // resources when their last picker element unmounts, despite warm <img>s.
    const retainedBackgrounds = document.createElement('span');
    retainedBackgrounds.setAttribute('aria-hidden', 'true');
    retainedBackgrounds.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    retainedBackgrounds.style.backgroundImage = notoThumbnailSheets.map(source => `url("${source}")`).join(',');
    document.body.append(retainedBackgrounds);
  }
  preload ??= Promise.all(notoThumbnailSheets.map(async source => {
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    decodedSheets.push(image);
    try { await image.decode(); } catch { /* A mounted background can retry the bundled asset. */ }
  })).then(() => {});
  return preload;
}
