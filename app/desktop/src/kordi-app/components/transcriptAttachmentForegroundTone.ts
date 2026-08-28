import type { AttachmentImageForegroundTone } from './transcriptAttachmentTypes';

function linearSrgbChannel(channel: number) {
  const value = Math.min(255, Math.max(0, channel)) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function attachmentImageForegroundToneFromRgba(
  pixels: ArrayLike<number>,
): AttachmentImageForegroundTone | null {
  let weightedLuminance = 0;
  let alphaWeight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = Math.min(255, Math.max(0, pixels[index + 3] ?? 0)) / 255;
    if (alpha <= 0.02) continue;
    const luminance = (
      (0.2126 * linearSrgbChannel(pixels[index] ?? 0))
      + (0.7152 * linearSrgbChannel(pixels[index + 1] ?? 0))
      + (0.0722 * linearSrgbChannel(pixels[index + 2] ?? 0))
    );
    weightedLuminance += luminance * alpha;
    alphaWeight += alpha;
  }
  if (alphaWeight === 0) return null;
  return (weightedLuminance / alphaWeight) >= 0.179 ? 'dark' : 'light';
}

export function sampleAttachmentImageForegroundTone(
  image: HTMLImageElement,
): AttachmentImageForegroundTone | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight || typeof document === 'undefined') return null;
  const renderedWidth = image.clientWidth || naturalWidth;
  const renderedHeight = image.clientHeight || naturalHeight;
  if (!renderedWidth || !renderedHeight) return null;

  try {
    const objectFit = window.getComputedStyle(image).objectFit;
    const scale = objectFit === 'cover'
      ? Math.max(renderedWidth / naturalWidth, renderedHeight / naturalHeight)
      : Math.min(renderedWidth / naturalWidth, renderedHeight / naturalHeight);
    const objectWidth = naturalWidth * scale;
    const objectHeight = naturalHeight * scale;
    const objectLeft = (renderedWidth - objectWidth) / 2;
    const objectTop = (renderedHeight - objectHeight) / 2;
    const targetWidth = Math.min(renderedWidth, Math.max(64, renderedWidth * 0.4));
    const targetHeight = Math.min(renderedHeight, Math.max(28, renderedHeight * 0.18));
    const targetLeft = renderedWidth - targetWidth;
    const targetTop = renderedHeight - targetHeight;
    const sampleLeft = Math.max(targetLeft, objectLeft);
    const sampleTop = Math.max(targetTop, objectTop);
    const sampleRight = Math.min(renderedWidth, objectLeft + objectWidth);
    const sampleBottom = Math.min(renderedHeight, objectTop + objectHeight);
    const sampleDisplayWidth = sampleRight - sampleLeft;
    const sampleDisplayHeight = sampleBottom - sampleTop;
    if (
      sampleDisplayWidth <= 0
      || sampleDisplayHeight <= 0
      || (sampleDisplayWidth * sampleDisplayHeight) < (targetWidth * targetHeight * 0.5)
    ) return null;

    const sourceX = (sampleLeft - objectLeft) / scale;
    const sourceY = (sampleTop - objectTop) / scale;
    const sourceWidth = sampleDisplayWidth / scale;
    const sourceHeight = sampleDisplayHeight / scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.min(48, Math.round(sampleDisplayWidth)));
    canvas.height = Math.max(1, Math.min(24, Math.round(sampleDisplayHeight)));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    return attachmentImageForegroundToneFromRgba(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}
