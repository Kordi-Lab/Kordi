import {
  composerImageCropPixels,
  type ComposerImageCropRect,
} from '@/features/chat/composerAttachments';

export function canvasBlob(canvas: HTMLCanvasElement, mimeType: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Kordi could not create the edited image.'));
    }, mimeType, 0.92);
  });
}

export function rotateCanvasClockwise(canvas: HTMLCanvasElement) {
  const source = copyCanvas(canvas);
  canvas.width = source.height;
  canvas.height = source.width;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Kordi could not rotate this image.');
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(Math.PI / 2);
  context.drawImage(source, -source.width / 2, -source.height / 2);
}

export function copyCanvas(canvas: HTMLCanvasElement) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  return copy;
}

export function restoreCanvas(canvas: HTMLCanvasElement, source: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
}

export function renderCropPreview(
  canvas: HTMLCanvasElement,
  source: HTMLCanvasElement,
  crop: ComposerImageCropRect,
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = composerImageCropPixels(crop, canvas.width, canvas.height);
  restoreCanvas(canvas, source);
  context.fillStyle = 'rgba(0, 0, 0, 0.52)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
  );
  const lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) * 0.002);
  context.lineWidth = lineWidth;
  context.strokeStyle = 'white';
  context.strokeRect(pixels.x, pixels.y, pixels.width, pixels.height);
  context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  context.lineWidth = Math.max(1, lineWidth / 2);
  for (const fraction of [1 / 3, 2 / 3]) {
    const x = pixels.x + pixels.width * fraction;
    const y = pixels.y + pixels.height * fraction;
    context.beginPath();
    context.moveTo(x, pixels.y);
    context.lineTo(x, pixels.y + pixels.height);
    context.moveTo(pixels.x, y);
    context.lineTo(pixels.x + pixels.width, y);
    context.stroke();
  }
  const radius = Math.max(6, Math.min(canvas.width, canvas.height) * 0.008);
  context.fillStyle = 'white';
  for (const [x, y] of [
    [pixels.x, pixels.y],
    [pixels.x + pixels.width / 2, pixels.y],
    [pixels.x + pixels.width, pixels.y],
    [pixels.x + pixels.width, pixels.y + pixels.height / 2],
    [pixels.x + pixels.width, pixels.y + pixels.height],
    [pixels.x + pixels.width / 2, pixels.y + pixels.height],
    [pixels.x, pixels.y + pixels.height],
    [pixels.x, pixels.y + pixels.height / 2],
  ]) {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
}

export function cropCanvas(canvas: HTMLCanvasElement, crop: ComposerImageCropRect) {
  const source = copyCanvas(canvas);
  const pixels = composerImageCropPixels(crop, canvas.width, canvas.height);
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  canvas.getContext('2d')?.drawImage(
    source,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
    0,
    0,
    pixels.width,
    pixels.height,
  );
}
