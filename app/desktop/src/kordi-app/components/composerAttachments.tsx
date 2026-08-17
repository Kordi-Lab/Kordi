import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  ImagePlus,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export type ComposerAttachmentPresentation = {
  id: string;
  name: string;
  kind: 'image' | 'file';
  mimeType?: string | null;
  subtype?: 'meme' | null;
  altText?: string | null;
  memeRightsConfirmed?: boolean;
};

type AttachmentVisual = {
  Icon: LucideIcon;
  iconClassName: string;
};

const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const CODE_EXTENSIONS = new Set([
  'css',
  'go',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'md',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'ods', 'tsv', 'xls', 'xlsm', 'xlsx']);

function attachmentExtension(name: string) {
  const match = name.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

function attachmentVisual(attachment: ComposerAttachmentPresentation): AttachmentVisual {
  const extension = attachmentExtension(attachment.name);

  if (attachment.kind === 'image' || attachment.mimeType?.startsWith('image/')) {
    return {
      Icon: FileImage,
      iconClassName: 'bg-violet-500/10 text-violet-500',
    };
  }
  if (extension === 'pdf' || attachment.mimeType === 'application/pdf') {
    return {
      Icon: FileText,
      iconClassName: 'bg-rose-500/10 text-rose-500',
    };
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return {
      Icon: FileSpreadsheet,
      iconClassName: 'bg-emerald-500/10 text-emerald-500',
    };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return {
      Icon: FileArchive,
      iconClassName: 'bg-amber-500/10 text-amber-500',
    };
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return {
      Icon: FileCode2,
      iconClassName: 'bg-sky-500/10 text-sky-500',
    };
  }
  return {
    Icon: FileText,
    iconClassName: 'bg-[color:var(--app-control-bg)] text-[color:var(--utility-muted-text)]',
  };
}

export function ComposerAttachmentList({
  attachments,
  onRemove,
  onUpdate,
}: {
  attachments: ComposerAttachmentPresentation[];
  onRemove: (id: string) => void;
  onUpdate?: (
    id: string,
    update: Pick<ComposerAttachmentPresentation, 'subtype' | 'altText' | 'memeRightsConfirmed'>,
  ) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div
      data-composer-attachment-list="true"
      className="mb-1.5 flex flex-wrap items-center gap-1.5"
    >
      {attachments.map((attachment) => {
        const visual = attachmentVisual(attachment);
        const Icon = visual.Icon;
        const isMeme = attachment.subtype === 'meme';
        return (
          <div
            key={attachment.id}
            data-composer-attachment-tile="true"
            data-composer-meme-attachment={isMeme ? 'true' : undefined}
            className={cn(
              'max-w-full rounded-[10px] bg-[color:var(--app-control-bg)] text-[color:var(--utility-foreground)]',
              isMeme
                ? 'flex w-full max-w-[420px] flex-col items-stretch gap-2 rounded-[14px] p-2'
                : 'inline-flex h-8 items-center gap-1.5 px-1.5',
            )}
            title={attachment.name}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-[7px]',
                  visual.iconClassName,
                )}
                aria-hidden="true"
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 max-w-[220px] flex-1 truncate text-[11.5px] font-medium leading-none">
                {attachment.name}
              </span>
              {onUpdate && attachment.kind === 'image' ? (
                <button
                  type="button"
                  onClick={() => onUpdate(attachment.id, {
                    subtype: isMeme ? null : 'meme',
                    altText: isMeme ? null : '',
                    memeRightsConfirmed: false,
                  })}
                  className="app-button-quiet min-h-6 shrink-0 rounded-full px-2 text-[10px] font-medium"
                  aria-pressed={isMeme}
                  aria-label={isMeme
                    ? `Treat ${attachment.name} as an ordinary image`
                    : `Mark ${attachment.name} as a meme`}
                >
                  {isMeme ? 'Meme' : 'Mark as meme'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="app-button-quiet grid h-5 w-5 shrink-0 place-items-center rounded-full p-0"
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            {isMeme && onUpdate ? (
              <div className="flex flex-col gap-1.5 px-0.5 pb-0.5">
                <label className="flex flex-col gap-1 text-[10px] font-medium text-[color:var(--utility-muted-text)]">
                  Alt text <span className="sr-only">for {attachment.name}</span>
                  <input
                    type="text"
                    value={attachment.altText ?? ''}
                    maxLength={500}
                    onChange={(event) => onUpdate(attachment.id, {
                      subtype: 'meme',
                      altText: event.currentTarget.value,
                      memeRightsConfirmed: attachment.memeRightsConfirmed,
                    })}
                    className="h-8 min-w-0 rounded-[9px] border border-[color:var(--app-control-border)] bg-transparent px-2.5 text-[12px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)] focus-visible:ring-2 focus-visible:ring-sky-400/55"
                    placeholder="Describe the visible text and joke"
                    aria-required="true"
                  />
                </label>
                <label className="flex min-h-8 cursor-pointer items-start gap-2 rounded-[9px] px-1 py-1 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">
                  <input
                    type="checkbox"
                    checked={attachment.memeRightsConfirmed === true}
                    onChange={(event) => onUpdate(attachment.id, {
                      subtype: 'meme',
                      altText: attachment.altText,
                      memeRightsConfirmed: event.currentTarget.checked,
                    })}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-500"
                  />
                  <span>I confirm I have permission or another legal right to share this meme.</span>
                </label>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type ComposerAttachmentAddMenuProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  memeInputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
  disabled?: boolean;
  'data-companion-attachment-control'?: string;
};

export function ComposerAttachmentAddMenu({
  inputRef,
  memeInputRef,
  className,
  disabled = false,
  'data-companion-attachment-control': companionAttachmentControl,
}: ComposerAttachmentAddMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [menuThemeClass, setMenuThemeClass] = useState('');
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const composerRect = trigger.closest('.app-composer-shell')?.getBoundingClientRect();
    const viewportPadding = 12;
    const anchorRect = composerRect ?? triggerRect;
    const menuWidth = Math.min(anchorRect.width, window.innerWidth - (viewportPadding * 2));
    const left = Math.min(
      Math.max(viewportPadding, anchorRect.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const appShell = trigger.closest('.kordi-app');
    setMenuThemeClass(appShell?.classList.contains('theme-light') ? 'app-compact-model-menu-light' : '');
    setMenuStyle({
      left: `${left}px`,
      top: `${Math.max(viewportPadding, anchorRect.top)}px`,
      width: `${menuWidth}px`,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return undefined;

    firstItemRef.current?.focus();

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  function openFilePicker() {
    setIsOpen(false);
    inputRef.current?.click();
    queueMicrotask(() => triggerRef.current?.focus());
  }

  function openMemePicker() {
    setIsOpen(false);
    memeInputRef?.current?.click();
    queueMicrotask(() => triggerRef.current?.focus());
  }

  const renderMenu = () => (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label="Add"
      data-composer-attachment-add-menu="true"
      className={cn(
        'app-composer-attachment-add-menu app-transient-surface app-composer-model-menu-layer app-compact-model-menu-layer rounded-[14px] p-1.5',
        menuThemeClass,
      )}
      style={menuStyle}
    >
      <div className="app-composer-attachment-add-menu-label app-transient-muted px-1.5 pb-1 pt-0.5 font-medium">
        Add
      </div>
      <button
        ref={firstItemRef}
        type="button"
        role="menuitem"
        onClick={openFilePicker}
        className="app-composer-attachment-add-menu-action app-transient-flat-action app-transient-action-row flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left"
      >
        <FolderOpen className="app-transient-action-icon" strokeWidth={1.8} aria-hidden="true" />
        <span className="app-transient-action-label">Files and folders</span>
      </button>
      {memeInputRef ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={openMemePicker}
            className="app-composer-attachment-add-menu-action app-transient-flat-action app-transient-action-row flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left"
          >
            <ImagePlus className="app-transient-action-icon" strokeWidth={1.8} aria-hidden="true" />
            <span className="app-transient-action-label">Meme image</span>
          </button>
          <p className="app-transient-muted px-1.5 pb-0.5 pt-1 text-[9.5px] leading-3.5">
            You will add alt text and confirm your right to share it before sending.
          </p>
        </>
      ) : null}
    </div>
  );

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        className="app-button-quiet app-icon-button grid h-9 w-9 shrink-0 place-items-center rounded-full border-0 p-0"
        disabled={disabled}
        onClick={() => {
          if (!isOpen) updateMenuPosition();
          setIsOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          updateMenuPosition();
          setIsOpen(true);
        }}
        title="Add attachment"
        aria-label="Add attachment"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        data-composer-attachment-add-trigger="true"
        data-companion-attachment-control={companionAttachmentControl}
      >
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </button>
      {isOpen
        ? (typeof document !== 'undefined' ? createPortal(renderMenu(), document.body) : renderMenu())
        : null}
    </div>
  );
}
