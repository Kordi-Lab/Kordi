import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightTranscriptMessage, navigateToTranscriptMessage, navigateToTranscriptMessageOrScrollBottom, transcriptMessageDomId } from '../src/features/chat/transcriptNavigation';

test('virtualized reply navigation highlights an already-centered row without scrolling it again', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let scrollCalls = 0;
  let highlighted = false;
  const target = {
    scrollIntoView() {
      scrollCalls += 1;
    },
    classList: {
      add(value: string) {
        highlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const fakeDocument = {
    getElementById(id: string) {
      return id === transcriptMessageDomId('virtualized-message') ? target : null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
    clearTimeout(_timeout?: number) {},
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const didHighlight = highlightTranscriptMessage('virtualized-message');

    assert.equal(didHighlight, true);
    assert.equal(highlighted, true);
    assert.equal(scrollCalls, 0);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('task response navigation falls back to transcript bottom when live target is not mounted yet', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const scrollContainer = {
    current: {
      scrollHeight: 2400,
      scrollTop: 0,
      scrollTo(options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
      },
    } as HTMLDivElement,
  };
  const fakeDocument = {
    getElementById(_id: string) {
      return null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const navigated = navigateToTranscriptMessageOrScrollBottom('live-turn-1', scrollContainer);

    assert.equal(navigated, true);
    assert.equal(scrollContainer.current.scrollTop, 2400);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('task response navigation highlights the visible message root when it lands on a turn-id alias', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let rootHighlighted = false;
  let scrolledRoot = false;
  let aliasHighlighted = false;
  const visibleRoot = {
    scrollIntoView() {
      scrolledRoot = true;
    },
    classList: {
      add(value: string) {
        rootHighlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const aliasAnchor = {
    scrollIntoView() {},
    closest(selector: string) {
      return selector === '[data-transcript-message-root]' ? visibleRoot : null;
    },
    classList: {
      add(value: string) {
        aliasHighlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const fakeDocument = {
    getElementById(id: string) {
      return id === transcriptMessageDomId('turn-alias') ? aliasAnchor : null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const navigated = navigateToTranscriptMessageOrScrollBottom('turn-alias');

    assert.equal(navigated, true);
    assert.equal(scrolledRoot, true);
    assert.equal(rootHighlighted, true);
    assert.equal(aliasHighlighted, false);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('task response navigation scrolls only the transcript container when a mounted target exists', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let calledNativeScrollIntoView = false;
  let highlighted = false;
  const scrollContainer = {
    current: {
      clientHeight: 600,
      scrollHeight: 2400,
      scrollTop: 100,
      contains(node: unknown) {
        return node === target;
      },
      getBoundingClientRect() {
        return { top: 100, bottom: 700, height: 600 } as DOMRect;
      },
      scrollTo(options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
      },
    } as HTMLDivElement,
  };
  const target = {
    scrollIntoView() {
      calledNativeScrollIntoView = true;
    },
    getBoundingClientRect() {
      return { top: 500, bottom: 620, height: 120 } as DOMRect;
    },
    classList: {
      add(value: string) {
        highlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const fakeDocument = {
    getElementById(id: string) {
      return id === transcriptMessageDomId('mounted-message') ? target : null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const navigated = navigateToTranscriptMessageOrScrollBottom('mounted-message', scrollContainer);

    assert.equal(navigated, true);
    assert.equal(calledNativeScrollIntoView, false);
    assert.equal(highlighted, true);
    assert.equal(scrollContainer.current.scrollTop, 260);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('task response navigation still jumps to mounted transcript messages without a transcript ref', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let scrolledTargetId: string | null = null;
  let highlighted = false;
  const target = {
    scrollIntoView() {
      scrolledTargetId = 'mounted-message';
    },
    classList: {
      add(value: string) {
        highlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const fakeDocument = {
    getElementById(id: string) {
      return id === transcriptMessageDomId('mounted-message') ? target : null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const navigated = navigateToTranscriptMessageOrScrollBottom('mounted-message');

    assert.equal(navigated, true);
    assert.equal(scrolledTargetId, 'mounted-message');
    assert.equal(highlighted, true);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('live reply navigation discovers the transcript container when no ref is passed', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let calledNativeScrollIntoView = false;
  let highlighted = false;
  const scrollContainer = {
    clientHeight: 500,
    scrollHeight: 1800,
    scrollTop: 80,
    contains(node: unknown) {
      return node === target;
    },
    getBoundingClientRect() {
      return { top: 120, bottom: 620, height: 500 } as DOMRect;
    },
    scrollTo(options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
    },
  } as HTMLDivElement;
  const target = {
    scrollIntoView() {
      calledNativeScrollIntoView = true;
    },
    closest(selector: string) {
      return selector === '.app-scroll-area' ? scrollContainer : null;
    },
    getBoundingClientRect() {
      return { top: 420, bottom: 540, height: 120 } as DOMRect;
    },
    classList: {
      add(value: string) {
        highlighted = value === 'app-transcript-message-highlight';
      },
      remove(_value: string) {},
    },
  };
  const fakeDocument = {
    getElementById(id: string) {
      return id === transcriptMessageDomId('live-reply') ? target : null;
    },
  } as unknown as Document;
  const fakeWindow = {
    setTimeout(_callback: TimerHandler, _timeout?: number) {
      return 0;
    },
  } as unknown as Window & typeof globalThis;

  try {
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const navigated = navigateToTranscriptMessage('live-reply');

    assert.equal(navigated, true);
    assert.equal(calledNativeScrollIntoView, false);
    assert.equal(highlighted, true);
    assert.equal(scrollContainer.scrollTop, 190);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});
