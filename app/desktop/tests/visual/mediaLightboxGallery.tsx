import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/index.css';
import { AttachmentImageLightbox } from '../../src/kordi-app/components/transcriptAttachmentLightbox';
import type { MessageAttachment } from '../../src/kordi-app/types';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light'
  ? 'light'
  : 'dark';
const requestedIndex = Number(new URLSearchParams(window.location.search).get('index') ?? 0);

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
  const image = images[index]!;

  return (
    <main className={`kordi-app theme-${theme} media-lightbox-visual-shell`}>
      <aside aria-hidden="true">
        <div className="media-lightbox-visual-brand">kordi</div>
        <i /><i /><i />
      </aside>
      <section aria-hidden="true">
        <header>Design review</header>
        <div className="media-lightbox-visual-message media-lightbox-visual-message-peer" />
        <div className="media-lightbox-visual-message media-lightbox-visual-message-own" />
        <div className="media-lightbox-visual-message media-lightbox-visual-message-peer" />
      </section>
      <AttachmentImageLightbox
        attachment={image}
        previewUrl={image.previewUrl}
        onClose={() => undefined}
        canGoPrevious={index > 0}
        canGoNext={index < images.length - 1}
        onPrevious={() => setIndex((current) => Math.max(0, current - 1))}
        onNext={() => setIndex((current) => Math.min(images.length - 1, current + 1))}
      />
    </main>
  );
}

document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;
createRoot(document.querySelector('#root')!).render(<MediaLightboxGallery />);
document.body.dataset.visualReady = 'true';
