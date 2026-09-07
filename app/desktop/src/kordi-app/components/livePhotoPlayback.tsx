import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { LoaderCircle } from 'lucide-react';
import { LivePhotoIcon } from './livePhotoIcon';
import type { LivePhoto } from '@/features/chat/livePhotos';
import { loadCachedCloudAttachmentLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { cloudAttachmentPlaybackUrl } from '@/features/cloud/cloudAttachmentPlayback';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';

async function playbackSource(livePhoto: LivePhoto) {
  const resource = livePhoto.playback;
  const path = await loadCachedCloudAttachmentLocalPath(resource.attachmentId, resource.name);
  if (path) return convertFileSrc(path);
  const session = await loadSession();
  if (!session?.token) throw new Error('Sign in to play this Live Photo.');
  return cloudAttachmentPlaybackUrl(defaultCloudAuthClient(), session.token, resource.attachmentId);
}

export function LivePhotoPlayback({ livePhoto, localVideoPath, zoom = 1, loadSource, controlsTarget, imageRef }: {
  livePhoto?: LivePhoto | null;
  localVideoPath?: string;
  zoom?: number;
  loadSource?: () => Promise<string>;
  controlsTarget?: HTMLElement | null;
  imageRef?: RefObject<HTMLImageElement | null>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mounted = useRef(true);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.pause();
      video?.removeAttribute('src');
      video?.load();
    };
  }, [playing, source]);

  useEffect(() => {
    const image = imageRef?.current;
    if (!image || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setFrame({ width: image.clientWidth, height: image.clientHeight }));
    observer.observe(image);
    return () => observer.disconnect();
  }, [imageRef]);

  async function play() {
    if (playing) { videoRef.current?.pause(); setPlaying(false); setLoading(false); return; }
    setLoading(true);
    setFailed(false);
    try {
      const url = loadSource ? await loadSource()
        : localVideoPath ? convertFileSrc(localVideoPath)
        : livePhoto ? await playbackSource(livePhoto) : null;
      if (!url) throw new Error('Live Photo unavailable');
      if (mounted.current) { setSource(url); setPlaying(true); }
    } catch {
      if (mounted.current) { setFailed(true); setLoading(false); }
    }
  }

  const controls = (
    <div className={controlsTarget ? "flex h-full items-center gap-2" : "absolute bottom-5 z-20 flex flex-col items-center gap-2"} data-attachment-image-lightbox-control="true">
      {failed ? <span role="status" className="text-xs text-white/70">Live playback unavailable. Try again.</span> : null}
      <button type="button" onClick={() => void play()} disabled={loading && !playing}
        className={controlsTarget ? "flex h-full items-center justify-center rounded-full bg-white/10 aria-pressed:bg-white/25 px-3 text-sm text-white" : "flex min-h-11 items-center justify-center rounded-full bg-black/60 px-3 text-sm text-white backdrop-blur"}
        title={playing ? 'Stop Live Photo' : 'Play Live Photo'}
        aria-label={playing ? 'Stop Live Photo' : 'Play Live Photo'} aria-pressed={playing}>
        {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          : <LivePhotoIcon className="size-5" />}
      </button>
    </div>
  );

  return <>
    {playing && source ? (
      <video ref={videoRef} src={source} playsInline preload="auto"
        className="app-attachment-image-lightbox-image absolute object-contain"
        style={{ ...frame, transform: `scale(${zoom})`, background: "black", opacity: loading ? 0 : 1 }}
        data-attachment-image-lightbox-control="true"
        aria-label="Live Photo motion"
        onCanPlay={(event) => {
          setLoading(false);
          const video = event.currentTarget;
          void video.play().catch(() => {
            if (mounted.current && video.isConnected) { setFailed(true); setPlaying(false); setLoading(false); }
          });
        }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onEnded={() => { setPlaying(false); setLoading(false); }}
        onError={() => { setFailed(true); setPlaying(false); setLoading(false); }}
      />
    ) : null}
    {controlsTarget ? createPortal(controls, controlsTarget) : controls}

  </>;
}
