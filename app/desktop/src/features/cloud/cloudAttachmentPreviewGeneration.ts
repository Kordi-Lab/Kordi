import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';

const COMPRESSED_IMAGE_PREVIEW_TYPES = ['image/webp', 'image/jpeg'] as const;

export async function blobToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === 'undefined') return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

async function renderCompressedPreview(blob: Blob, maxDimension: number, quality: number, signal?: AbortSignal): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  if (signal?.aborted) return null;
  const objectUrl = URL.createObjectURL(blob);
  let canvas: HTMLCanvasElement | null = null;
  let image: HTMLImageElement | null = null;
  let cancelDecode: (() => void) | null = null;
  try {
    image = await new Promise<HTMLImageElement | null>((resolve) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => resolve(null);
      image = nextImage;
      cancelDecode = () => { nextImage.removeAttribute('src'); resolve(null); };
      signal?.addEventListener('abort', cancelDecode, { once: true });
      nextImage.src = objectUrl;
    });
    if (signal?.aborted || !image?.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const type of COMPRESSED_IMAGE_PREVIEW_TYPES) {
      const previewBlob = await canvasToBlob(canvas, type, quality);
      if (signal?.aborted) return null;
      if (!previewBlob) continue;
      const safe = safeCloudAttachmentPreviewUrl(await blobToDataUrl(previewBlob));
      if (safe) return safe;
    }
    return null;
  } finally {
    if (cancelDecode) signal?.removeEventListener('abort', cancelDecode);
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    URL.revokeObjectURL(objectUrl);
  }
}

export async function createCompressedImagePreviewDataUrl(blob: Blob, signal?: AbortSignal): Promise<string | null> {
  if (!blob.type.startsWith('image/')) return null;
  return await renderCompressedPreview(blob, 960, 0.72, signal)
    ?? await renderCompressedPreview(blob, 640, 0.58, signal);
}
