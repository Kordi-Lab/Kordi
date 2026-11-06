import { createPortal } from 'react-dom';

/** A brief toast at the bottom of the window, such as "Link copied". It
 * renders inside the app root so it takes the app's theme. */
export function CopyToast({ visible, label = 'Link copied' }: { visible: boolean; label?: string }) {
  if (!visible || typeof document === 'undefined') return null;
  return createPortal(
    <div className="app-copy-toast" role="status" aria-live="polite">{label}</div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
