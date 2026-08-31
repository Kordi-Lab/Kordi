import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type CompositionEventHandler,
  type FormEvent,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from 'react';

import { cn } from '@/lib/utils';
import { BlobEmojiImage } from './BlobEmojiImage';
import { blobEmojiTextParts } from './blobEmoji';
import {
  blobEmojiComposerValue,
  blobEmojiTokenFor,
} from './blobEmojiComposerDom';
import type { EmojiTextSelection } from './emojiText';

function logicalLength(node: Node): number {
  const token = blobEmojiTokenFor(node);
  if (token) return token.length;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  return Array.from(node.childNodes).reduce((total, child) => total + logicalLength(child), 0);
}

function logicalOffset(root: HTMLElement, target: Node, targetOffset: number) {
  function visit(node: Node): { found: boolean; length: number } {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        return { found: true, length: Math.min(targetOffset, node.textContent?.length ?? 0) };
      }
      return {
        found: true,
        length: Array.from(node.childNodes)
          .slice(0, targetOffset)
          .reduce((total, child) => total + logicalLength(child), 0),
      };
    }
    const token = blobEmojiTokenFor(node);
    if (token) return { found: false, length: token.length };
    if (node.nodeType === Node.TEXT_NODE) {
      return { found: false, length: node.textContent?.length ?? 0 };
    }
    let length = 0;
    for (const child of node.childNodes) {
      const result = visit(child);
      length += result.length;
      if (result.found) return { found: true, length };
    }
    return { found: false, length };
  }
  return visit(root).length;
}

function domPoint(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);
  function visit(node: Node): { node: Node; offset: number } | null {
    const token = blobEmojiTokenFor(node);
    if (token) {
      const parent = node.parentNode ?? root;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (remaining <= token.length / 2) return { node: parent, offset: index };
      remaining -= token.length;
      return { node: parent, offset: index + 1 };
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      return null;
    }
    for (const child of node.childNodes) {
      const point = visit(child);
      if (point) return point;
    }
    return null;
  }
  return visit(root) ?? { node: root, offset: root.childNodes.length };
}

function selectionIn(root: HTMLElement): EmojiTextSelection {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) {
    const end = blobEmojiComposerValue(root).length;
    return { start: end, end };
  }
  return {
    start: logicalOffset(root, selection.anchorNode, selection.anchorOffset),
    end: logicalOffset(root, selection.focusNode, selection.focusOffset),
  };
}

function restoreSelection(root: HTMLElement, selection: EmojiTextSelection) {
  const browserSelection = window.getSelection();
  if (!browserSelection) return;
  const range = document.createRange();
  const start = domPoint(root, selection.start);
  const end = domPoint(root, selection.end);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  browserSelection.removeAllRanges();
  browserSelection.addRange(range);
}

function replaceSelection(root: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export type BlobEmojiComposerInputHandle = {
  focus: (selection?: EmojiTextSelection) => void;
  selection: () => EmojiTextSelection;
};

type Props = {
  value: string;
  className?: string;
  placeholder: string;
  readOnly?: boolean;
  ariaBusy?: boolean;
  ariaDescribedBy?: string;
  onChange: (value: string, target: HTMLDivElement) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onCompositionStart?: CompositionEventHandler<HTMLDivElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLDivElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  onFocus?: () => void;
};

export const BlobEmojiComposerInput = forwardRef<BlobEmojiComposerInputHandle, Props>(
  function BlobEmojiComposerInput({
    value,
    className,
    placeholder,
    readOnly = false,
    ariaBusy,
    ariaDescribedBy,
    onChange,
    onPaste,
    onKeyDown,
    onCompositionStart,
    onCompositionEnd,
    onPointerDownCapture,
    onFocus,
  }, forwardedRef) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const pendingSelection = useRef<EmojiTextSelection | null>(null);

    useImperativeHandle(forwardedRef, () => ({
      focus(selection) {
        const root = rootRef.current;
        if (!root) return;
        root.focus();
        restoreSelection(root, selection ?? {
          start: value.length,
          end: value.length,
        });
      },
      selection() {
        return rootRef.current ? selectionIn(rootRef.current) : { start: value.length, end: value.length };
      },
    }), [value]);

    useLayoutEffect(() => {
      const root = rootRef.current;
      const nextSelection = pendingSelection.current;
      if (!root || !nextSelection) return;
      pendingSelection.current = null;
      restoreSelection(root, nextSelection);
    }, [value]);

    const commit = (target: HTMLDivElement) => {
      pendingSelection.current = selectionIn(target);
      onChange(blobEmojiComposerValue(target), target);
    };

    const handleInput = (event: FormEvent<HTMLDivElement>) => commit(event.currentTarget);

    return (
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        aria-busy={ariaBusy || undefined}
        aria-describedby={ariaDescribedBy}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck
        data-composer-scope="chat"
        data-empty={value.length === 0 ? 'true' : undefined}
        data-placeholder={placeholder}
        className={cn('app-blob-emoji-composer', className)}
        onInput={handleInput}
        onPointerDownCapture={onPointerDownCapture}
        onFocus={onFocus}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            replaceSelection(event.currentTarget, '\n');
            commit(event.currentTarget);
          }
        }}
        onCopy={(event) => {
          const selection = selectionIn(event.currentTarget);
          const start = Math.min(selection.start, selection.end);
          const end = Math.max(selection.start, selection.end);
          event.clipboardData.setData(
            'text/plain',
            blobEmojiComposerValue(event.currentTarget).slice(start, end),
          );
          event.preventDefault();
        }}
        onCut={(event) => {
          if (readOnly) return;
          const selection = selectionIn(event.currentTarget);
          const start = Math.min(selection.start, selection.end);
          const end = Math.max(selection.start, selection.end);
          event.clipboardData.setData(
            'text/plain',
            blobEmojiComposerValue(event.currentTarget).slice(start, end),
          );
          event.preventDefault();
          replaceSelection(event.currentTarget, '');
          commit(event.currentTarget);
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented || readOnly) return;
          event.preventDefault();
          replaceSelection(event.currentTarget, event.clipboardData.getData('text/plain'));
          commit(event.currentTarget);
        }}
      >
        <span key={value} data-composer-content="true">
          {blobEmojiTextParts(value).map((part, index) => (
            part.type === 'emoji' ? (
              <span
                key={`${part.emoji.id}-${index}`}
                contentEditable={false}
                data-blob-emoji-token={part.token}
                className="app-composer-blob-emoji"
              >
                <BlobEmojiImage emoji={part.emoji} />
              </span>
            ) : part.value
          ))}
        </span>
      </div>
    );
  },
);
