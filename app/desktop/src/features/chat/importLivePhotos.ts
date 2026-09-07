import { invoke } from '@tauri-apps/api/core';
import type { AttachmentItem } from './composerController.types';

/** PhotoKit validates actual pairing metadata; basenames are never used to match resources. */
export async function importLivePhotos(paths: string[]): Promise<{ photos: AttachmentItem[]; remaining: string[] }> {
  if (!paths.some((path) => /\.(heic|heif|jpe?g)$/i.test(path)) || !paths.some((path) => /\.mov$/i.test(path))) {
    return { photos: [], remaining: paths };
  }
  const prepared = await invoke<Array<AttachmentItem & { sourcePhotoPath: string; sourceVideoPath: string }>>(
    'desktop_chat_prepare_live_photos', { paths },
  );
  const used = new Set(prepared.flatMap((photo) => [photo.sourcePhotoPath, photo.sourceVideoPath]));
  return {
    photos: prepared.map(({ sourcePhotoPath: _photo, sourceVideoPath: _video, ...attachment }) => ({
      ...attachment, id: attachment.path, localPath: attachment.path, formatLabel: 'LIVE',
    })),
    remaining: paths.filter((path) => !used.has(path)),
  };
}
