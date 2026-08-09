import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kordi.avatarOverrides.v1';
const CHANGE_EVENT = 'kordi-avatar-overrides-change';
const AVATAR_SIZE = 256;
const MIN_AVATAR_SIZE = 64;
const INITIAL_JPEG_QUALITY = 0.9;
const MIN_JPEG_QUALITY = 0.58;
const AVATAR_UPLOAD_TARGET_BYTES = 200 * 1024;

type AvatarOverrideMap = Record<string, string>;

function hasBrowserStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readOverrides(): AvatarOverrideMap {
  if (!hasBrowserStorage()) return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function writeOverrides(overrides: AvatarOverrideMap) {
  if (!hasBrowserStorage()) return;

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};

  window.addEventListener(CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

export function getAvatarOverride(avatarKey?: string | null) {
  const normalizedKey = avatarKey?.trim();
  if (!normalizedKey) return null;
  return readOverrides()[normalizedKey] ?? null;
}

export function setAvatarOverride(avatarKey: string, dataUrl: string) {
  const normalizedKey = avatarKey.trim();
  if (!normalizedKey) return;

  writeOverrides({
    ...readOverrides(),
    [normalizedKey]: dataUrl,
  });
}

export function removeAvatarOverride(avatarKey: string) {
  const normalizedKey = avatarKey.trim();
  if (!normalizedKey) return;

  const nextOverrides = { ...readOverrides() };
  delete nextOverrides[normalizedKey];
  writeOverrides(nextOverrides);
}

export function migrateAvatarOverride(fromAvatarKey: string, toAvatarKey: string) {
  const fromKey = fromAvatarKey.trim();
  const toKey = toAvatarKey.trim();
  if (!fromKey || !toKey || fromKey === toKey) return;
  const overrides = readOverrides();
  const existing = overrides[fromKey];
  if (!existing || overrides[toKey]) return;
  writeOverrides({
    ...overrides,
    [toKey]: existing,
  });
}

export function useAvatarOverride(avatarKey?: string | null) {
  const normalizedKey = avatarKey?.trim() || '';

  return useSyncExternalStore(
    subscribe,
    () => getAvatarOverride(normalizedKey),
    () => null,
  );
}

function loadImageFromDataUrl(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read that image.'));
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Could not read that file.'));
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function dataUrlPayloadBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const trimmed = payload.trimEnd().replace(/=+$/, '');
  return Math.floor((trimmed.length * 3) / 4);
}

export async function fileToAvatarDataUrl(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(rawDataUrl);
  const canvas = document.createElement('canvas');

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare that image.');

  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const sourceSize = Math.min(imageWidth, imageHeight);
  const sourceX = (imageWidth - sourceSize) / 2;
  const sourceY = (imageHeight - sourceSize) / 2;

  const renderSquare = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
  };

  let size = AVATAR_SIZE;
  let quality = INITIAL_JPEG_QUALITY;
  let best = '';
  while (size >= MIN_AVATAR_SIZE) {
    canvas.width = size;
    canvas.height = size;
    renderSquare();
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    best = dataUrl;
    if (dataUrlPayloadBytes(dataUrl) <= AVATAR_UPLOAD_TARGET_BYTES) return dataUrl;
    if (quality > MIN_JPEG_QUALITY) {
      quality = Math.max(MIN_JPEG_QUALITY, quality - 0.08);
    } else {
      size = Math.floor(size * 0.82);
      quality = INITIAL_JPEG_QUALITY;
    }
  }

  if (best && dataUrlPayloadBytes(best) <= AVATAR_UPLOAD_TARGET_BYTES) return best;
  throw new Error('Could not process that avatar. Try another image.');
}
