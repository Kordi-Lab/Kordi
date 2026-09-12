import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptMediaBoundary } from '../../src/kordi-app/components/TranscriptMediaBoundary';
import { AttachmentPreview } from '../../src/kordi-app/components/transcriptAttachments';
import { acquireCloudAttachmentPreviewLease as acquire, retainCloudAttachmentPreviewResource as retain, cachedCloudAttachmentPreviewResource as cached, clearCloudAttachmentPreviewCache as clear, type CloudAttachmentPreviewLease } from '../../src/features/cloud/cloudAttachmentPreviewCache';
import '../../src/index.css';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="teal"/></svg>';
function LeasedImage({ open }: { open: (lease: CloudAttachmentPreviewLease) => void }) {
  const [lease, setLease] = useState<CloudAttachmentPreviewLease | null>(null);
  useEffect(() => {
    const resource = cached('synthetic') ?? retain('synthetic', URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), 320 * 200 * 4);
    const next = acquire(resource);
    let active = true;
    queueMicrotask(() => { if (active) setLease(next); });
    return () => { active = false; next.release(); };
  }, []);
  return <div style={{ width: 320, height: 230 }}>
    {lease ? <><img data-leased-image src={lease.previewUrl} width={320} height={200} alt="Synthetic preview" /><button onClick={() => open(lease.retain())}>Keep preview open</button></> : null}
  </div>;
}
function Fixture() {
  const borrowed = useRef<CloudAttachmentPreviewLease | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  return <>
    <button onClick={clear}>Evict cache</button>
    <button onClick={() => { borrowed.current?.release(); borrowed.current = null; setPreview(null); }}>Close preview</button>
    {preview ? <img data-borrowed-image src={preview} width={80} height={50} alt="Open preview" style={{ position: 'fixed', right: 0, top: 0 }} /> : null}
    <div data-virtual-transcript-scroll style={{ height: 600, width: 600, overflowY: 'auto', overflowAnchor: 'none' }}>
      <div style={{ height: 2400 }} />
      <div data-image-region><TranscriptMediaBoundary><LeasedImage open={lease => { borrowed.current?.release(); borrowed.current = lease; setPreview(lease.previewUrl); }} /></TranscriptMediaBoundary></div>
      <div data-real-image><AttachmentPreview msg={{ role: 'person', text: '', time: '12:00', attachments: [{ kind: 'image', name: 'Synthetic.svg', previewUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`, widthPixels: 320, heightPixels: 200 }] }} /></div>
      <div data-gif-region><AttachmentPreview msg={{ role: 'person', text: '', time: '12:00', attachments: [{ kind: 'image', name: 'Synthetic.gif', mimeType: 'image/gif', previewUrl: `${location.origin}/tests/visual/generated/media-retention.gif`, widthPixels: 320, heightPixels: 200 }] }} /></div>
      <div data-video-region><AttachmentPreview msg={{ role: 'person', text: '', time: '12:00', attachments: [{ kind: 'file', name: 'Synthetic.mp4', mimeType: 'video/mp4', previewUrl: `${location.origin}/tests/visual/generated/media-retention.mp4`, widthPixels: 320, heightPixels: 200 }] }} /></div>
      <div data-after-media style={{ height: 30 }}>After media</div>
      <div style={{ height: 3000 }} />
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
