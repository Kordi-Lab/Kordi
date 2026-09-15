import { useLayoutEffect, useRef } from 'react';

/** Keep the chat viewport and composer outline still throughout a voice draft. */
export function useVoiceComposerLayout(active: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const idleHeight = useRef(0);
  useLayoutEffect(() => {
    const shell = root.current?.querySelector<HTMLElement>('.app-composer-shell');
    if (!shell) return;
    if (active) {
      if (idleHeight.current) shell.style.height = `${idleHeight.current}px`;
      shell.dataset.voiceActive = 'true';
      return () => {
        shell.style.removeProperty('height');
        delete shell.dataset.voiceActive;
      };
    }
    const measure = () => { idleHeight.current = shell.getBoundingClientRect().height; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [active]);
  return root;
}
