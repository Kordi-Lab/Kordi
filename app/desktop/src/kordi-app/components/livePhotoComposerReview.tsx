import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { LivePhotoPlayback } from './livePhotoPlayback';

export function LivePhotoComposerReview({ attachment, onClose }: { attachment: AttachmentItem; onClose: () => void }) {
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const previewUrl = attachment.previewUrl || (attachment.livePhotoFiles?.previewPath ? convertFileSrc(attachment.livePhotoFiles.previewPath) : null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} onCancel={onClose} onClose={onClose}
    className="fixed inset-0 m-auto h-[80vh] w-[90vw] max-w-5xl rounded-2xl bg-neutral-950 p-0 text-[#fff] backdrop:bg-black/70"
    aria-label="Review Live Photo before sending">
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 px-5 py-3">
        <h2>Review Live Photo</h2>
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4">Done</button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {previewUrl ? <img ref={image} src={previewUrl} alt={attachment.name} className="max-h-full max-w-full object-contain" /> : null}
        <LivePhotoPlayback controlsTarget={controls} imageRef={image} imageUrl={previewUrl} localVideoPath={attachment.livePhotoFiles?.playbackPath} />
      </div>
      <div className="flex min-h-20 shrink-0 items-center justify-between gap-4 px-5 py-4">
        <div><p className="text-sm font-medium">Send as Live Photo</p><p className="mt-1 text-xs text-white/60">Original photo, motion and sound</p></div>
        <div ref={setControls} className="h-11" />
      </div>
    </div>
  </dialog>;
}
