import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/index.css';
import { AttachmentImageLightbox } from '../../src/kordi-app/components/transcriptAttachmentLightbox';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message, MessageAttachment } from '../../src/kordi-app/types';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light'
  ? 'light'
  : 'dark';
const requestedIndex = Number(params.get('index') ?? 0);
const surface = params.get('surface') === 'transcript' ? 'transcript' : 'lightbox';

function geometricImage(width: number, height: number, palette: [string, string, string, string]) {
  const [canvas, block, signal, line] = palette;
  const source = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="${canvas}"/>
      <rect x="${width * 0.08}" y="${height * 0.10}" width="${width * 0.38}" height="${height * 0.64}" rx="${Math.min(width, height) * 0.025}" fill="${block}"/>
      <circle cx="${width * 0.72}" cy="${height * 0.34}" r="${Math.min(width, height) * 0.16}" fill="${signal}"/>
      <path d="M ${width * 0.55} ${height * 0.72} H ${width * 0.89}" stroke="${line}" stroke-width="${Math.min(width, height) * 0.035}" stroke-linecap="round"/>
      <path d="M ${width * 0.55} ${height * 0.82} H ${width * 0.76}" stroke="${line}" stroke-width="${Math.min(width, height) * 0.035}" stroke-linecap="round" opacity="0.58"/>
    </svg>
  `;
  return `data:image/svg+xml,${encodeURIComponent(source)}`;
}

const images: Array<MessageAttachment & { previewUrl: string }> = [
  {
    kind: 'image',
    name: 'Quiet signal landscape.png',
    attachmentId: 'visual-landscape',
    previewUrl: geometricImage(1440, 900, ['#172131', '#26364D', '#80A9E8', '#D7E3F4']),
  },
  {
    kind: 'image',
    name: 'Quiet signal portrait.png',
    attachmentId: 'visual-portrait',
    previewUrl: geometricImage(840, 1260, ['#201E2B', '#343046', '#A89BD8', '#E5E1F1']),
  },
  {
    kind: 'image',
    name: 'Quiet signal square.png',
    attachmentId: 'visual-square',
    previewUrl: geometricImage(900, 900, ['#172724', '#29413A', '#7BC7B2', '#D7EEE8']),
  },
];

function MediaLightboxGallery() {
  const [index, setIndex] = useState(Math.min(images.length - 1, Math.max(0, requestedIndex)));
  const [zoom, setZoom] = useState(1);
  const image = images[index]!;

  return (
    <main className="media-lightbox-visual-shell">
      <AttachmentImageLightbox
        attachment={image}
        previewUrl={image.previewUrl}
        onClose={() => undefined}
        canGoPrevious={index > 0}
        canGoNext={index < images.length - 1}
        onPrevious={() => setIndex((current) => Math.max(0, current - 1))}
        onNext={() => setIndex((current) => Math.min(images.length - 1, current + 1))}
        positionLabel={`${index + 1} of ${images.length}`}
        zoom={zoom}
        onZoomIn={() => setZoom((current) => Math.min(4, current + 0.25))}
        onZoomOut={() => setZoom((current) => Math.max(0.25, current - 0.25))}
        onZoomReset={() => setZoom(1)}
      />
    </main>
  );
}

const transcriptMessages: Message[] = [
  {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Outgoing message edge',
    time: '14:34',
  },
  {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '',
    time: '14:35',
    attachments: [images[0]!],
  },
  {
    role: 'person',
    sender: 'Shu Yang',
    senderType: 'human',
    isOwnMessage: false,
    text: 'Incoming message edge',
    time: '14:35',
  },
  {
    role: 'person',
    sender: 'Shu Yang',
    senderType: 'human',
    isOwnMessage: false,
    text: '',
    time: '14:36',
    attachments: [images[1]!],
  },
  {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '',
    time: '14:37',
    attachments: images,
  },
];

function TranscriptImageGallery() {
  return (
    <main className="transcript-image-visual-shell">
      {transcriptMessages.map((message, index) => (
        <section key={`${message.time}-${index}`} aria-label={`Transcript message ${index + 1}`}>
          <MessageBubble msg={message} />
        </section>
      ))}
    </main>
  );
}

document.body.classList.add(`theme-${theme}`);
if (surface === 'lightbox') {
  document.body.classList.add('app-attachment-media-window-root');
  document.documentElement.classList.add('app-attachment-media-window-root');
  document.documentElement.dataset.attachmentMediaTheme = theme;
}
document.documentElement.style.colorScheme = theme;
createRoot(document.querySelector('#root')!).render(
  surface === 'transcript' ? <TranscriptImageGallery /> : <MediaLightboxGallery />,
);
document.body.dataset.visualReady = 'true';
