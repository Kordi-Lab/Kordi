export const STICKER_FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';
export const GIF_FILE_ACCEPT = 'image/gif,.gif';
export const EXPRESSIVE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
const EXPRESSIVE_MEDIA_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export type ExpressiveMediaKind = 'sticker' | 'gif';
export type CompressStickerFile = (file: File) => Promise<File>;

export const STICKER_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const STICKER_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);
export const GIF_MIME_TYPES = new Set(['image/gif']);
const GIF_EXTENSIONS = new Set(['gif']);

export function fileExtension(name: string) {
  return name.trim().split('.').pop()?.toLocaleLowerCase() ?? '';
}

export function expressiveMediaFileError(file: Pick<File, 'name' | 'type'>, kind: ExpressiveMediaKind) {
  const mimeType = file.type.trim().toLocaleLowerCase();
  const extension = fileExtension(file.name);
  const allowedMimeTypes = kind === 'sticker' ? STICKER_MIME_TYPES : GIF_MIME_TYPES;
  const allowedExtensions = kind === 'sticker' ? STICKER_EXTENSIONS : GIF_EXTENSIONS;
  const mimeTypeMatches = !mimeType || allowedMimeTypes.has(mimeType);
  const extensionMatches = !extension || allowedExtensions.has(extension);
  if ((mimeType || extension) && mimeTypeMatches && extensionMatches) return null;
  return kind === 'sticker'
    ? 'Choose a PNG, JPEG, WebP, or GIF image for My Stickers.'
    : 'Choose a GIF file for My GIFs.';
}

export function expressiveMediaKindForFile(file: Pick<File, 'name' | 'type'>): ExpressiveMediaKind | null {
  if (!expressiveMediaFileError(file, 'gif')) return 'gif';
  if (!expressiveMediaFileError(file, 'sticker')) return 'sticker';
  return null;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function compressStickerFile(file: File): Promise<File> {
  if (file.size > EXPRESSIVE_MEDIA_MAX_SOURCE_BYTES) throw new Error('Choose a sticker image smaller than 32 MB.');
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') {
    throw new Error('This sticker is larger than 2 MB and could not be compressed on this device.');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => resolve(null);
      nextImage.src = objectUrl;
    });
    if (!image?.naturalWidth || !image.naturalHeight) throw new Error('This sticker image could not be read. Choose another file.');
    if (Math.max(image.naturalWidth, image.naturalHeight) <= 512 && file.size <= EXPRESSIVE_MEDIA_MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This sticker could not be compressed on this device.');
    for (const [maxDimension, quality] of [[512, 0.82], [448, 0.74], [384, 0.66], [320, 0.58], [256, 0.5]] as const) {
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 'image/webp', quality);
      if (blob?.type === 'image/webp' && blob.size <= EXPRESSIVE_MEDIA_MAX_BYTES) {
        const stem = file.name.replace(/\.[^.]+$/, '').trim() || 'sticker';
        return new File([blob], `${stem}.webp`, { type: 'image/webp' });
      }
    }
    throw new Error('This sticker could not be compressed below the 2 MB upload limit.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
