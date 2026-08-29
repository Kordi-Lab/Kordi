const VIDEO_POSTER_MAX_WIDTH = 480;
const VIDEO_POSTER_TIMEOUT_MS = 5_000;

type VideoPreview = {
  previewUrl: string;
  widthPixels: number;
  heightPixels: number;
};

export function captureVideoPreview(video: HTMLVideoElement | null): VideoPreview | null {
  if (!video?.videoWidth || !video.videoHeight) return null;
  try {
    const width = Math.min(VIDEO_POSTER_MAX_WIDTH, video.videoWidth);
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    return {
      previewUrl: canvas.toDataURL('image/jpeg', 0.68),
      widthPixels: video.videoWidth,
      heightPixels: video.videoHeight,
    };
  } catch {
    return null;
  }
}

export function captureVideoPosterDataUrl(video: HTMLVideoElement | null) {
  return captureVideoPreview(video)?.previewUrl ?? null;
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadeddata' | 'loadedmetadata' | 'seeked') {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('Video poster timed out.')), VIDEO_POSTER_TIMEOUT_MS);
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener('error', handleError);
      if (error) reject(error);
      else resolve();
    };
    const handleSuccess = () => finish();
    const handleError = () => finish(new Error('Video poster could not load.'));
    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener('error', handleError, { once: true });
  });
}

export async function videoPreviewFromSource(source: string) {
  if (typeof document === 'undefined') return null;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata');
    video.src = source;
    await metadataReady;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(video, 'loadeddata');
    }
    const firstFrame = captureVideoPreview(video);
    const seekTime = Number.isFinite(video.duration) && video.duration > 0.1
      ? Math.min(0.5, video.duration / 2)
      : 0;
    if (seekTime <= 0) return firstFrame;
    try {
      const frameReady = waitForVideoEvent(video, 'seeked');
      video.currentTime = seekTime;
      await frameReady;
      return captureVideoPreview(video) ?? firstFrame;
    } catch {
      return firstFrame;
    }
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export async function videoPosterDataUrlFromSource(source: string) {
  return (await videoPreviewFromSource(source))?.previewUrl ?? null;
}
