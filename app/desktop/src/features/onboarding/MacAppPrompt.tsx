import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useHelpCornerPosition } from './helpCornerPosition';
import { MAC_DOWNLOAD_PATH } from './macAppPromptRules';

/** Browser-only card that offers the Mac app, in the welcome prompt's place. */
export function MacAppPrompt({ trigger, onDownload, onDismiss }: {
  trigger: RefObject<HTMLButtonElement | null>;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const position = useHelpCornerPosition(trigger);
  if (!position) return null;
  return createPortal(<aside className="app-transient-surface fixed z-30 w-60 rounded-xl border p-4 text-left text-foreground" style={position} aria-label="Kordi for Mac">
    <p className="text-[13px] font-semibold">Kordi for Mac</p>
    <p className="my-2 text-[12px] leading-5">Your agent runs on your Mac, with your files.</p>
    <div className="flex items-center gap-3">
      <a className="app-button-primary rounded-lg px-3 py-2 text-xs" href={MAC_DOWNLOAD_PATH} onClick={onDownload}>Download for Mac</a>
      <button className="text-xs" onClick={onDismiss}>Not now</button>
    </div>
  </aside>, document.body);
}
