import {
  loadRemoteImageThroughNativeProxy,
  shouldLoadRemoteImageThroughNativeProxy,
} from '@/kordi-app/components/remoteAvatarImage';
import { blobEmojiAssetUrl, type BlobEmoji } from './blobEmoji';
import { isEmojiImageReady, markEmojiImageReady } from './emojiImageReadiness';

function setBlobEmojiSource(
  media: HTMLImageElement | HTMLCanvasElement,
  source: string,
  readinessKey: string,
) {
  media.dataset.ready = isEmojiImageReady(readinessKey) ? 'true' : 'false';
  if (media.tagName === 'IMG') {
    const image = media as HTMLImageElement;
    image.onload = () => {
      markEmojiImageReady(readinessKey);
      image.dataset.ready = 'true';
    };
    image.src = source;
    return;
  }
  const canvas = media as HTMLCanvasElement;
  const image = new Image();
  image.onload = () => {
    if (!canvas.isConnected) return;
    canvas.width = image.naturalWidth || 128;
    canvas.height = image.naturalHeight || 128;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    markEmojiImageReady(readinessKey);
    canvas.dataset.ready = 'true';
  };
  image.src = source;
}

export function blobEmojiComposerNode(emoji: BlobEmoji, token: string) {
  const wrapper = document.createElement('span');
  wrapper.contentEditable = 'false';
  wrapper.dataset.blobEmojiToken = token;
  wrapper.className = 'app-composer-blob-emoji';

  const reduceMotion = emoji.animated
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const media = reduceMotion
    ? document.createElement('canvas')
    : document.createElement('img');
  media.className = 'app-blob-emoji-image object-contain';
  media.setAttribute('role', 'img');
  media.setAttribute('aria-label', emoji.id);
  if (media.tagName === 'IMG') {
    const image = media as HTMLImageElement;
    image.alt = emoji.id;
    image.decoding = 'async';
    image.draggable = false;
  }
  wrapper.append(media);

  const remoteUrl = blobEmojiAssetUrl(emoji);
  const readinessKey = `blob:${emoji.sha256}:${reduceMotion ? 'still' : 'animated'}`;
  if (shouldLoadRemoteImageThroughNativeProxy(remoteUrl, undefined, true)) {
    void loadRemoteImageThroughNativeProxy(remoteUrl, {
      command: 'desktop_fetch_blob_emoji_data_url',
      expectedSha256: emoji.sha256,
    }).then((source) => {
      if (wrapper.isConnected) setBlobEmojiSource(media, source, readinessKey);
    }).catch(() => {
      if (wrapper.isConnected) setBlobEmojiSource(media, remoteUrl, readinessKey);
    });
  } else {
    setBlobEmojiSource(media, remoteUrl, readinessKey);
  }
  return wrapper;
}
