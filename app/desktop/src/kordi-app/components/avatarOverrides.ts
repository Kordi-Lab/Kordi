import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kordi.avatarOverrides.v1';
const CHANGE_EVENT = 'kordi-avatar-overrides-change';
const AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.9;

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

export async function fileToAvatarDataUrl(file: File) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file.');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(rawDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare that image.');

  const sourceSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const sourceX = ((image.naturalWidth || image.width) - sourceSize) / 2;
  const sourceY = ((image.naturalHeight || image.height) - sourceSize) / 2;

  context.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
