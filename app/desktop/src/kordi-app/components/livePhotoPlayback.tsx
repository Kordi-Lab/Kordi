import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { CirclePlay, LoaderCircle, Square } from 'lucide-react';
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
    if (playing) { videoRef.current?.pause(); setPlaying(false); return; }
    setLoading(true);
    setFailed(false);
    try {
      const url = loadSource ? await loadSource()
        : localVideoPath ? convertFileSrc(localVideoPath)
        : livePhoto ? await playbackSource(livePhoto) : null;
      if (!url) throw new Error('Live Photo unavailable');
      if (mounted.current) { setSource(url); setPlaying(true); }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  const controls = (
    <div className={controlsTarget ? "flex items-center border-l border-white/15" : "absolute bottom-5 z-20 flex flex-col items-center gap-2"} data-attachment-image-lightbox-control="true">
      <button type="button" onClick={() => void play()} disabled={loading}
        className={controlsTarget ? "gap-1.5 px-3 text-xs" : "flex min-h-11 items-center gap-2 rounded-full bg-black/60 px-5 text-sm text-white backdrop-blur"}
        aria-label={playing ? 'Stop Live Photo' : 'Play Live Photo'} aria-pressed={playing}>
        {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          : playing ? <Square className="size-4" aria-hidden="true" /> : <CirclePlay className="size-4" aria-hidden="true" />}
        {loading ? 'Loading…' : 'Live'}
      </button>
    </div>
  );

  return <>
    {playing && source ? (
      <video ref={videoRef} src={source} playsInline preload="auto"
        className="app-attachment-image-lightbox-image absolute object-contain"
        style={{ ...frame, transform: `scale(${zoom})`, background: "black" }}
        data-attachment-image-lightbox-control="true"
        aria-label="Live Photo motion"
        onCanPlay={(event) => {
          void event.currentTarget.play().catch(() => {
            if (mounted.current) { setFailed(true); setPlaying(false); }
          });
        }}
        onEnded={() => setPlaying(false)}
        onError={() => { setFailed(true); setPlaying(false); }}
      />
    ) : null}
    {failed ? <span role="status" className="absolute bottom-14 right-4 z-20 max-w-[90%] rounded-lg bg-black/80 px-3 py-2 text-sm text-white">Live playback unavailable. Try again.</span> : null}
    {controlsTarget ? createPortal(controls, controlsTarget) : controls}

  </>;
}
