import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/index.css';
import { saveSession } from '../../src/features/cloud/session';
import { AttachmentImageLightbox } from '../../src/kordi-app/components/transcriptAttachmentLightbox';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message, MessageAttachment } from '../../src/kordi-app/types';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light'
  ? 'light'
  : 'dark';
const requestedIndex = Number(params.get('index') ?? 0);
const requestedSurface = params.get('surface');
const surface = requestedSurface === 'transcript'
    || requestedSurface === 'remote-transcript'
    || requestedSurface === 'retry-transcript'
    || requestedSurface === 'link-preview'
  ? requestedSurface
  : 'lightbox';

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

const remoteTranscriptMessage: Message = {
  role: 'user',
  sender: 'Me',
  senderType: 'human',
  isOwnMessage: true,
  text: '',
  time: '14:38',
  attachments: [{
    kind: 'image',
    name: 'Synced landscape.png',
    attachmentId: 'visual-remote-original',
    previewAttachmentId: 'visual-remote-preview',
    previewUrl: null,
    mimeType: 'image/png',
  }],
};

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

function RemoteTranscriptGallery() {
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    void saveSession({
      token: 'visual-token',
      accountId: 'visual-account',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).then(() => setSessionReady(true));
  }, []);

  return sessionReady ? (
    <main className="transcript-image-visual-shell">
      <section aria-label="Remote transcript image">
        <MessageBubble msg={remoteTranscriptMessage} />
      </section>
    </main>
  ) : null;
}

function RetryTranscriptGallery() {
  const failedMessage: Message = {
    ...transcriptMessages[1]!,
    statusChips: ['failed'],
  };

  return (
    <main className="transcript-image-visual-shell">
      <section aria-label="Failed transcript image">
        <MessageBubble
          msg={failedMessage}
          onRetryMessage={() => new Promise<void>(() => {})}
        />
      </section>
    </main>
  );
}

function LinkPreviewGallery() {
  const longUrl = 'https://www.xiaohongshu.com/discovery/item/6a90259d000000001f003421?app_platform=ios&xsec_token=redacted&share_id=redacted';
  const messages: Message[] = [
    {
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      isOwnMessage: true,
      text: longUrl,
      time: '15:06',
    },
    {
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      isOwnMessage: false,
      text: '[UI design reference](https://refero.design/)',
      time: '15:07',
    },
  ];

  return (
    <main className={`kordi-app theme-${theme} transcript-image-visual-shell`}>
      {messages.map((message, index) => (
        <section key={message.time} aria-label={`Link preview message ${index + 1}`}>
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
  surface === 'transcript'
    ? <TranscriptImageGallery />
    : surface === 'remote-transcript'
      ? <RemoteTranscriptGallery />
      : surface === 'retry-transcript'
        ? <RetryTranscriptGallery />
        : surface === 'link-preview'
          ? <LinkPreviewGallery />
        : <MediaLightboxGallery />,
);
document.body.dataset.visualReady = 'true';
