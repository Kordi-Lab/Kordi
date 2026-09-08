import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LivePhotoPlayback } from '../../src/kordi-app/components/livePhotoPlayback';
import '../../src/index.css';
import '../../src/styles/shell-media-lightbox.css';
const photo = '/tests/visual/generated/live-photo/live-photo.jpg';
const video = '/tests/visual/generated/live-photo/live-photo.mp4';

document.documentElement.classList.add('app-attachment-media-window-root');
document.body.style.background = '#333';
function Preview() {
  const imageRef = useRef<HTMLImageElement>(null);
  const [photoReady, setPhotoReady] = useState(!location.search.includes('delayed-photo'));
  useEffect(() => {
    const timer = setTimeout(() => setPhotoReady(true), 200);
    return () => clearTimeout(timer);
  }, []);
  const [visible, setVisible] = useState(true);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  return <main className="app-attachment-image-lightbox fixed inset-0 flex items-center justify-center" aria-label="Live Photo preview">
    {photoReady ? <img ref={imageRef} src={photo} alt="Generated teal test card" className="app-attachment-image-lightbox-image" style={{ width: 800 }} /> : null}
    {visible ? <LivePhotoPlayback imageRef={imageRef} imageUrl={photoReady ? photo : null} controlsTarget={controls} loadSource={async () => {
      document.body.dataset.liveSourceRequests = String(Number(document.body.dataset.liveSourceRequests ?? 0) + 1);
      if (location.search.includes('slow-source')) await new Promise((resolve) => setTimeout(resolve, 600));
      if (location.search.includes('failure')) throw new Error('Offline');
      return video;
    }} /> : null}
    <div ref={setControls} className="app-attachment-image-lightbox-zoom-controls">
      <button aria-label="Zoom out">−</button><button>100%</button><button aria-label="Zoom in">+</button>
    </div>
    <button className="absolute left-4 top-4 text-white" onClick={() => setVisible(false)}>Close preview</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
