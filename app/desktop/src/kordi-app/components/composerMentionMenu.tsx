import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { File, Folder, House, Link, Paperclip, Users } from 'lucide-react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import type { ComposerMentionOption } from './composer';
import { IdentityAvatar } from './IdentityAvatar';
import { orderedComposerMentionOptions } from './composerMentionOptions';

function initialComposerMentionMenuThemeClass() {
  if (typeof document === 'undefined') return '';
  return document.querySelector('.kordi-app.theme-light') ? 'app-composer-mention-menu-light' : '';
}

export function ComposerMentionMenu({
  id,
  items,
  selectedIndex,
  onSelect,
}: {
  id?: string;
  items: ComposerMentionOption[];
  selectedIndex: number;
  onSelect: (item: ComposerMentionOption) => void;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [menuThemeClass, setMenuThemeClass] = useState(initialComposerMentionMenuThemeClass);

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const anchor = anchorRef.current;
    const container = anchor?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const viewportPadding = 24;
    const menuWidth = Math.min(
      480,
      Math.max(280, rect.width),
      Math.max(240, window.innerWidth - (viewportPadding * 2)),
    );
    const appShell = anchor.closest('.kordi-app') ?? document.querySelector('.kordi-app.theme-light');
    setMenuThemeClass(appShell?.classList.contains('theme-light') ? 'app-composer-mention-menu-light' : '');
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const top = Math.max(viewportPadding, rect.top - 10);
    const availableAbove = Math.max(160, top - viewportPadding);
    setMenuStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: `${menuWidth}px`,
      maxHeight: `min(26rem, ${availableAbove}px)`,
      transform: 'translateY(-100%)',
    });
  }, []);

  useEffect(() => {
    if (items.length === 0) return undefined;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [items.length, updateMenuPosition]);

  useEffect(() => {
    if (!id || items.length === 0) return;
    document.getElementById(`${id}-option-${selectedIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, items.length, selectedIndex]);

  if (items.length === 0) return null;

  const orderedItems = orderedComposerMentionOptions(items);
  const sections = [
    {
      label: 'References',
      items: orderedItems.filter((item) => item.targetKind === 'reference'),
    },
    {
      label: 'Contacts',
      items: orderedItems.filter((item) => item.targetKind === 'person' || item.targetKind === 'all'),
    },
    {
      label: 'Agents',
      items: orderedItems.filter((item) => item.targetKind === 'agent'),
    },
  ].filter((section) => section.items.length > 0);

  const menu = (
    <div
      className={cn('app-transient-surface app-composer-mention-menu app-composer-mention-menu-layer fixed flex flex-col overflow-hidden rounded-[14px] border p-1.5', menuThemeClass)}
      id={id}
      role="listbox"
      aria-label="Add a reference, contact, or agent"
      style={menuStyle}
    >
      <div className="app-transient-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div className="space-y-1.5">
          {sections.map((section) => (
            <div key={section.label} role="group" aria-label={section.label}>
              <div className="app-composer-mention-menu-section px-2 pb-1 pt-1 text-[10.5px] font-medium">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const index = orderedItems.indexOf(item);
                  const active = index === selectedIndex;
                  const ReferenceIcon = item.referenceAction === 'pick-file'
                    ? Paperclip
                    : item.referenceAction === 'home-path'
                      ? House
                      : item.referenceKind === 'url'
                        ? Link
                        : item.referenceKind === 'directory'
                          ? Folder
                          : File;
                  return (
                    <button
                      id={id ? `${id}-option-${index}` : undefined}
                      key={`${item.sourceHostId}-${item.nodeId}-${item.value}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onSelect(item);
                      }}
                      className={cn(
                        'app-composer-mention-menu-item flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition',
                        active && 'app-composer-mention-menu-item-active',
                      )}
                      aria-label={item.targetKind === 'all' ? 'Mention all people in this group' : undefined}
                    >
                      {item.targetKind === 'reference' ? (
                        <span className="app-composer-mention-menu-reference-icon grid h-6 w-6 shrink-0 place-items-center" aria-hidden="true">
                          <ReferenceIcon className="h-3.5 w-3.5" />
                        </span>
                      ) : item.targetKind === 'all' ? (
                        <span className="app-composer-mention-menu-icon grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[color:var(--app-composer-mention-menu-border)]" aria-hidden="true">
                          <Users className="h-3.5 w-3.5" />
                        </span>
                      ) : (
                        <IdentityAvatar
                          kind={item.targetKind === 'agent' ? 'agent' : 'human'}
                          seed={item.avatarSeed ?? item.agentId ?? item.humanId ?? item.nodeId ?? item.label}
                          name={item.label}
                          imageUrl={item.avatarImageUrl}
                          className="app-composer-mention-menu-icon h-6 w-6 shrink-0 border border-[color:var(--app-composer-mention-menu-border)]"
                        />
                      )}
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex min-w-0 items-center">
                          <span className="app-composer-mention-menu-label truncate text-[13px] font-medium leading-5">
                            {item.targetKind === 'reference' ? null : <span className="app-composer-mention-menu-at mr-px">@</span>}
                            {item.label}
                          </span>
                        </div>
                        {item.detail && item.targetKind !== 'person' ? <div className="app-composer-mention-menu-detail truncate text-[10.5px] leading-4">{item.detail}</div> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  return (
    <>
      <span ref={anchorRef} className="pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden="true" />
      {typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
    </>
  );
}
