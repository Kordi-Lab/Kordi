import { useCallback, useSyncExternalStore, type RefObject } from 'react';

import { artifactPreviewDocumentSource } from '@/pages/artifactPreviewDocument';

/** App colors and type resolved for an HTML document, which cannot see the app's CSS variables. */
export type DocumentTheme = {
  scheme: 'dark' | 'light';
  foreground: string;
  muted: string;
  link: string;
  codeBackground: string;
  divider: string;
  fontFamily: string;
};

const SYSTEM_FONT = '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif';

export const FALLBACK_DOCUMENT_THEME: DocumentTheme = {
  scheme: 'dark',
  foreground: 'rgba(255, 255, 255, 0.92)',
  muted: 'rgba(255, 255, 255, 0.62)',
  link: '#60a5fa',
  codeBackground: 'rgba(255, 255, 255, 0.06)',
  divider: 'rgba(255, 255, 255, 0.08)',
  fontFamily: SYSTEM_FONT,
};

/** Keeps a token value from closing the style element or the rule it sits in. */
function cssValue(value: string, fallback: string) {
  const clean = value.trim().replace(/[<>{};]/g, '');
  return clean || fallback;
}

/** Reads the theme from the element the document is shown in (inside `.kordi-app`). */
export function resolveDocumentTheme(element: Element | null): DocumentTheme {
  const view = element?.ownerDocument.defaultView;
  if (!element || !view) return FALLBACK_DOCUMENT_THEME;
  const styles = view.getComputedStyle(element);
  const token = (name: string, fallback: string) => cssValue(styles.getPropertyValue(name), fallback);
  const light = Boolean(element.closest('.theme-light')) || element.ownerDocument.body.classList.contains('theme-light');
  return {
    scheme: light ? 'light' : 'dark',
    foreground: token('--utility-foreground', FALLBACK_DOCUMENT_THEME.foreground),
    muted: token('--utility-muted-text', FALLBACK_DOCUMENT_THEME.muted),
    link: token('--app-markdown-link', FALLBACK_DOCUMENT_THEME.link),
    codeBackground: token('--app-control-bg', FALLBACK_DOCUMENT_THEME.codeBackground),
    divider: token('--app-divider', FALLBACK_DOCUMENT_THEME.divider),
    fontFamily: cssValue(styles.fontFamily, SYSTEM_FONT),
  };
}

/** Stylesheet that puts an HTML document on the app surface: one background, app text, app links. */
export function documentThemeHead(theme: DocumentTheme) {
  return `<meta name="color-scheme" content="${theme.scheme}">
<style data-kordi-document-theme>
  :root { color-scheme: ${theme.scheme}; }
  html, body { background: transparent !important; color: ${theme.foreground} !important; font-family: ${theme.fontFamily} !important; margin: 0 !important; padding: 0 !important; max-width: 100% !important; overflow-x: hidden !important; }
  body { font-size: 13.5px; line-height: 1.5; }
  :is(html, body, main, article, section, div, header, footer, aside, nav, table, tr, td, th) { background: transparent !important; }
  :is(h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, span, small, strong, em, label, blockquote, figcaption) { color: inherit !important; }
  :is(blockquote, figcaption, small) { color: ${theme.muted} !important; }
  :is(pre, code, kbd, samp) { background: ${theme.codeBackground} !important; color: inherit !important; border-radius: 6px; }
  pre { padding: 10px 12px; }
  a { color: ${theme.link} !important; }
  :is(table, th, td, hr) { border-color: ${theme.divider} !important; }
  :is(button, input, select, textarea) { background: transparent !important; color: inherit !important; border: 1px solid ${theme.divider} !important; border-radius: 8px; font: inherit; }
  :is(img, video, canvas, svg, iframe) { max-width: 100% !important; height: auto; }
  /* Fixed-width grids and rows wrap to the pane width instead of running off its edge. */
  body * { min-width: 0 !important; max-width: 100% !important; box-shadow: none !important; flex-wrap: wrap !important; grid-template-columns: minmax(0, 1fr) !important; }
</style>`;
}

/** The HTML with the rail-fit rules and then the app theme in its head. */
export function themedDocumentSource(source: string, theme: DocumentTheme) {
  const fitted = artifactPreviewDocumentSource(source, 'rail');
  return fitted.replace(/<\/head>/i, `${documentThemeHead(theme)}</head>`);
}

/** Theme of the element behind `ref`, updated when the app root or body switches its theme class. */
export function useDocumentTheme(ref: RefObject<Element | null>): DocumentTheme {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined;
    const observer = new MutationObserver(onChange);
    const root = ref.current?.closest('.kordi-app') ?? document.documentElement;
    for (const target of new Set([root, document.body])) observer.observe(target, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    // The element exists only after mount; read it once it does.
    queueMicrotask(onChange);
    return () => observer.disconnect();
  }, [ref]);
  const snapshot = useCallback(() => JSON.stringify(resolveDocumentTheme(ref.current)), [ref]);
  const serialized = useSyncExternalStore(subscribe, snapshot, () => JSON.stringify(FALLBACK_DOCUMENT_THEME));
  return JSON.parse(serialized) as DocumentTheme;
}
