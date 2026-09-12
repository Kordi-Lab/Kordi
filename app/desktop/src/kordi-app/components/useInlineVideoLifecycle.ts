import { useEffect, useRef, type RefObject } from 'react';

export function useInlineVideoLifecycle(videoRef: RefObject<HTMLVideoElement | null>, mediaActive: boolean, playbackRequested: boolean) {
  const playbackEndedRef = useRef(false);
  const resumeTimeRef = useRef(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const didFinish = () => playbackEndedRef.current;
    return () => {
      resumeTimeRef.current = didFinish() ? 0 : video.currentTime;
      video.pause(); video.removeAttribute('src'); video.load();
    };
  }, [mediaActive, playbackRequested, videoRef]);
  return { playbackEndedRef, resumeTimeRef };
}
