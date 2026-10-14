import { useEffect, useRef, type KeyboardEvent } from 'react';

import { cleanDocumentTitle } from './documentReaderModel';

/**
 * A title being renamed in place: it opens with the text selected, Enter or
 * leaving saves, Escape cancels. An empty or unchanged title closes without
 * saving.
 */
export function DocumentTitleField({ value, className, label, onSave, onClose }: {
  value: string;
  className: string;
  label: string;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = save ? cleanDocumentTitle(ref.current?.value ?? '') : null;
    onClose();
    if (title && title !== value) onSave(title);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Tab strip and editor shortcuts stay out of the field.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  };

  return (
    <input
      ref={ref}
      type="text"
      className={className}
      aria-label={label}
      defaultValue={value}
      maxLength={200}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
