import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';

const COMPRESSED_IMAGE_PREVIEW_TYPES = ['image/webp', 'image/jpeg'] as const;

async function blobToDataUrl(blob: Blob): Promise<string | null> {
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

async function renderCompressedPreview(blob: Blob, maxDimension: number, quality: number): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => resolve(null);
      nextImage.src = objectUrl;
    });
    if (!image?.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const type of COMPRESSED_IMAGE_PREVIEW_TYPES) {
      const previewBlob = await canvasToBlob(canvas, type, quality);
      if (!previewBlob) continue;
      const safe = safeCloudAttachmentPreviewUrl(await blobToDataUrl(previewBlob));
      if (safe) return safe;
    }
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function createCompressedImagePreviewDataUrl(blob: Blob): Promise<string | null> {
  if (!blob.type.startsWith('image/')) return null;
  return await renderCompressedPreview(blob, 960, 0.72)
    ?? await renderCompressedPreview(blob, 640, 0.58);
}
