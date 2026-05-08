import assert from 'node:assert/strict';
import { test } from 'node:test';

import { navigateToTranscriptMessageOrScrollBottom, transcriptMessageDomId } from '../src/kordi-app/components/transcriptReplyAttribution';

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

test('task response navigation scrolls only the transcript container when target is mounted', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let scrolledPageTarget = false;
  let highlighted = false;
  const scrollContainer = {
    current: {
      clientHeight: 400,
      scrollHeight: 2000,
      scrollTop: 200,
      scrollTo(options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
      },
      getBoundingClientRect() {
        return { top: 100, height: 400 } as DOMRect;
      },
    } as HTMLDivElement,
  };
  const target = {
    scrollIntoView() {
      scrolledPageTarget = true;
    },
    getBoundingClientRect() {
      return { top: 900, height: 100 } as DOMRect;
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
    assert.equal(scrolledPageTarget, false);
    assert.equal(scrollContainer.current.scrollTop, 850);
    assert.equal(highlighted, true);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});

test('task response navigation still jumps to mounted transcript messages first', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let scrolledTargetId: string | null = null;
  let highlighted = false;
  const scrollContainer = {
    current: {
      scrollHeight: 2400,
      scrollTop: 0,
      scrollTo(options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
      },
    } as HTMLDivElement,
  };
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

    const navigated = navigateToTranscriptMessageOrScrollBottom('mounted-message', scrollContainer);

    assert.equal(navigated, true);
    assert.equal(scrolledTargetId, 'mounted-message');
    assert.equal(highlighted, true);
    assert.equal(scrollContainer.current.scrollTop, 0);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  }
});
