export type ImagePixelDimensions = {
  widthPixels: number;
  heightPixels: number;
};

export const MAX_IMAGE_PIXEL_DIMENSION = 100_000;

export function normalizedImagePixelDimensions(
  widthPixels: unknown,
  heightPixels: unknown,
): ImagePixelDimensions | null {
  if (
    typeof widthPixels !== 'number'
    || typeof heightPixels !== 'number'
    || !Number.isSafeInteger(widthPixels)
    || !Number.isSafeInteger(heightPixels)
    || widthPixels <= 0
    || heightPixels <= 0
    || widthPixels > MAX_IMAGE_PIXEL_DIMENSION
    || heightPixels > MAX_IMAGE_PIXEL_DIMENSION
  ) return null;
  return { widthPixels, heightPixels };
}

export async function imagePixelDimensionsFromUrl(
  source: string | null | undefined,
): Promise<ImagePixelDimensions | null> {
  if (!source || typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(normalizedImagePixelDimensions(image.naturalWidth, image.naturalHeight));
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

export async function imagePixelDimensionsFromBlob(blob: Blob) {
  if (typeof URL === 'undefined') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await imagePixelDimensionsFromUrl(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function fittedImageDisplaySize(
  dimensions: ImagePixelDimensions,
  maximumWidth: number,
  maximumHeight: number,
) {
  const scale = Math.min(
    1,
    maximumWidth / dimensions.widthPixels,
    maximumHeight / dimensions.heightPixels,
  );
  return {
    width: Math.max(1, Math.round(dimensions.widthPixels * scale)),
    height: Math.max(1, Math.round(dimensions.heightPixels * scale)),
  };
}
