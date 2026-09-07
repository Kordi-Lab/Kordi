import { useEffect, useRef } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { LivePhotoPlayback } from './livePhotoPlayback';

export function LivePhotoComposerReview({ attachment, onClose }: { attachment: AttachmentItem; onClose: () => void }) {
  const image = useRef<HTMLImageElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} onCancel={onClose} onClose={onClose}
    className="fixed inset-0 m-auto h-[80vh] w-[90vw] max-w-5xl rounded-2xl bg-neutral-950 p-5 text-white backdrop:bg-black/70"
    aria-label="Review Live Photo before sending">
    <div className="flex items-center justify-between gap-4">
      <h2>Review Live Photo</h2>
      <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4">Done</button>
    </div>
    <div className="relative flex h-[calc(100%-3rem)] items-center justify-center">
      {attachment.previewUrl ? <img ref={image} src={attachment.previewUrl} alt={attachment.name} className="max-h-full max-w-full object-contain" /> : null}
      <LivePhotoPlayback imageRef={image} localVideoPath={attachment.livePhotoFiles?.playbackPath} />
    </div>
  </dialog>;
}
