import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function ComposerDropSurface({
  children,
  saveDesktopAttachments,
}: {
  children: ReactNode;
  saveDesktopAttachments: (files: File[]) => Promise<unknown>;
}) {
  const [isFileDropActive, setIsFileDropActive] = useState(false);

  return (
    <div
      className={cn(
        'app-composer-shell relative rounded-[26px] p-3',
        isFileDropActive && 'ring-2 ring-sky-400/55 ring-offset-2 ring-offset-transparent',
      )}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        setIsFileDropActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setIsFileDropActive(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsFileDropActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        setIsFileDropActive(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) void saveDesktopAttachments(files);
      }}
    >
      {isFileDropActive ? (
        <div
          className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-[22px] border border-sky-400/45 bg-[color:var(--app-modal-bg)] text-[12px] font-medium text-[color:var(--utility-foreground)]"
          role="status"
        >
          Drop files to attach
        </div>
      ) : null}
      {children}
    </div>
  );
}
