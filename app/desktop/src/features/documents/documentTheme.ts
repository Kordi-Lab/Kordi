import { useCallback, useSyncExternalStore, type RefObject } from 'react';

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

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * What the reader adds to an HTML document's head, and nothing more: a
 * viewport when the page has none, and media that stays inside its container
 * unless the page says otherwise. On a page without its own background, the
 * app's color scheme, text color, font and link color fill in. Every rule has
 * zero specificity, so the author's own `<style>` and inline rules win. The
 * page is laid out at the pane's width as a browser would: a responsive page
 * reflows and a fixed-width page scrolls sideways inside the frame.
 */
export function documentThemeHead(theme: DocumentTheme, authorSurface = false, hasViewport = false) {
  const colors = authorSurface ? '' : `
  :root { color-scheme: ${theme.scheme}; }
  :where(html, body) { background: transparent; color: ${theme.foreground}; font-family: ${theme.fontFamily}; }
  :where(a:link, a:visited) { color: ${theme.link}; }`;
  const metas = `${hasViewport ? '' : `${VIEWPORT_META}\n`}${authorSurface ? '' : `<meta name="color-scheme" content="${theme.scheme}">\n`}`;
  return `${metas}<style data-kordi-document-theme>${colors}
  :where(img, video) { max-width: 100%; height: auto; }
</style>`;
}

/** The HTML with the reader's head additions (and app colors, unless it paints its own page). */
export function themedDocumentSource(source: string, theme: DocumentTheme) {
  const head = documentThemeHead(theme, hasAuthorPageBackground(source), /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i.test(source));
  if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, () => `${head}</head>`);
  const htmlOpeningTag = /<html(?:\s[^>]*)?>/i;
  if (htmlOpeningTag.test(source)) return source.replace(htmlOpeningTag, (tag) => `${tag}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
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
