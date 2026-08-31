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

import {
  loadRemoteImageThroughNativeProxy,
  shouldLoadRemoteImageThroughNativeProxy,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import {
  blobEmojiAssetUrl,
  blobEmojiTextParts,
  type BlobEmoji,
} from './blobEmoji';
import {
  blobEmojiComposerValue,
  blobEmojiTokenFor,
} from './blobEmojiComposerDom';
import type { EmojiTextSelection } from './emojiText';

function setBlobEmojiSource(
  media: HTMLImageElement | HTMLCanvasElement,
  source: string,
) {
  if (media.tagName === 'IMG') {
    (media as HTMLImageElement).src = source;
    return;
  }
  const canvas = media as HTMLCanvasElement;
  const image = new Image();
  image.onload = () => {
    if (!canvas.isConnected) return;
    canvas.width = image.naturalWidth || 128;
    canvas.height = image.naturalHeight || 128;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
  };
  image.src = source;
}

function blobEmojiComposerNode(emoji: BlobEmoji, token: string) {
  const wrapper = document.createElement('span');
  wrapper.contentEditable = 'false';
  wrapper.dataset.blobEmojiToken = token;
  wrapper.className = 'app-composer-blob-emoji';

  const reduceMotion = emoji.animated
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const media = reduceMotion
    ? document.createElement('canvas')
    : document.createElement('img');
  media.className = 'object-contain';
  media.setAttribute('role', 'img');
  media.setAttribute('aria-label', emoji.id);
  if (media.tagName === 'IMG') {
    const image = media as HTMLImageElement;
    image.alt = emoji.id;
    image.decoding = 'async';
    image.draggable = false;
  }
  wrapper.append(media);

  const remoteUrl = blobEmojiAssetUrl(emoji);
  if (shouldLoadRemoteImageThroughNativeProxy(remoteUrl, undefined, true)) {
    void loadRemoteImageThroughNativeProxy(remoteUrl, {
      command: 'desktop_fetch_blob_emoji_data_url',
      expectedSha256: emoji.sha256,
    }).then((source) => {
      if (wrapper.isConnected) setBlobEmojiSource(media, source);
    }).catch(() => {
      if (wrapper.isConnected) setBlobEmojiSource(media, remoteUrl);
    });
  } else {
    setBlobEmojiSource(media, remoteUrl);
  }
  return wrapper;
}

function renderComposerValue(root: HTMLElement, value: string) {
  const fragment = document.createDocumentFragment();
  for (const part of blobEmojiTextParts(value)) {
    fragment.append(part.type === 'emoji'
      ? blobEmojiComposerNode(part.emoji, part.token)
      : document.createTextNode(part.value));
  }
  root.replaceChildren(fragment);
}

function renderedBlobEmojiCount(root: HTMLElement) {
  return root.querySelectorAll('[data-blob-emoji-token]').length;
}

function expectedBlobEmojiCount(value: string) {
  return blobEmojiTextParts(value).filter((part) => part.type === 'emoji').length;
}

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
      if (remaining <= token.length) {
        return {
          node: parent,
          offset: remaining <= token.length / 2 ? index : index + 1,
        };
      }
      remaining -= token.length;
      return null;
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
      if (!root) return;
      if (
        blobEmojiComposerValue(root) !== value
        || renderedBlobEmojiCount(root) !== expectedBlobEmojiCount(value)
      ) {
        renderComposerValue(root, value);
      }
      if (!nextSelection) return;
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
      />
    );
  },
);
