import { useCallback, useSyncExternalStore, type RefObject } from 'react';

import { artifactPreviewDocumentSource } from '@/pages/artifactPreviewDocument';

/** App colors and type resolved for an HTML document, which cannot see the app's CSS variables. */
export type DocumentTheme = {
  scheme: 'dark' | 'light';
  foreground: string;
  link: string;
  fontFamily: string;
};

const SYSTEM_FONT = '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif';

export const FALLBACK_DOCUMENT_THEME: DocumentTheme = {
  scheme: 'dark',
  foreground: 'rgba(255, 255, 255, 0.92)',
  link: '#60a5fa',
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
    link: token('--app-markdown-link', FALLBACK_DOCUMENT_THEME.link),
    fontFamily: cssValue(styles.fontFamily, SYSTEM_FONT),
  };
}

/** True when the author paints the page itself (a `body` or `html` background), e.g. the common white page. */
export function hasAuthorPageBackground(source: string) {
  const styleRule = /(?:^|[\s,}>])(?:html|body)(?:[\s.#:[][^{]*)?\{[^}]*\bbackground(?:-color)?\s*:/i;
  const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n');
  const inline = /<(?:html|body)\b[^>]*\b(?:style\s*=\s*["'][^"']*\bbackground(?:-color)?\s*:|bgcolor\s*=)/i;
  return styleRule.test(styles) || inline.test(source);
}

/**
 * Stylesheet that fits an HTML document into the app without restyling it.
 * Only the fit is enforced: nothing wider than the pane, no sideways page
 * scroll. On a page without its own background, the app's color scheme, text
 * color, font and link color fill in at zero specificity, so the author's own
 * `<style>` and inline rules still win. A page with its own background keeps
 * it as its surface and gets no app colors.
 */
export function documentThemeHead(theme: DocumentTheme, authorSurface = false) {
  const colors = authorSurface ? '' : `
  :root { color-scheme: ${theme.scheme}; }
  :where(html, body) { background: transparent; color: ${theme.foreground}; font-family: ${theme.fontFamily}; }
  :where(a:link, a:visited) { color: ${theme.link}; }`;
  return `${authorSurface ? '' : `<meta name="color-scheme" content="${theme.scheme}">\n`}<style data-kordi-document-theme>${colors}
  html, body { max-width: 100% !important; overflow-x: hidden !important; }
  body * { min-width: 0 !important; }
  :is(img, video, iframe, canvas, svg) { max-width: 100% !important; height: auto; }
</style>`;
}

/** The HTML with the rail-fit rules and then the app fit (and colors, unless it paints its own page) in its head. */
export function themedDocumentSource(source: string, theme: DocumentTheme) {
  const fitted = artifactPreviewDocumentSource(source, 'rail');
  return fitted.replace(/<\/head>/i, `${documentThemeHead(theme, hasAuthorPageBackground(source))}</head>`);
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
