import { useEffect, useSyncExternalStore } from 'react';

import { documentFormatForPath, documentNameWithoutExtension } from './documentReaderModel';

/**
 * Titles of cloud documents by attachment id, so lists can show a renamed
 * document under its title. Readers fill it as they load, `document.updated`
 * renames update it, and Artifacts rows fetch what is missing. In memory only,
 * bounded like the attachment path cache; a window starts empty.
 */
const MAX_TITLES = 256;
/** Lazy title requests running at once. */
export const MAX_TITLE_REQUESTS = 2;

export type DocumentTitleFetch = (attachmentId: string) => Promise<{ title: string }>;

const titles = new Map<string, string>();
const listeners = new Set<() => void>();
// Ids asked for once this window; a failed request is not retried, the file name stays.
const requested = new Set<string>();
const queue: Array<{ attachmentId: string; fetch: DocumentTitleFetch }> = [];
let running = 0;
let generation = 0;

function emit() {
  for (const listener of [...listeners]) listener();
}

/** Records the title a reader, a rename or a sync event reported for `attachmentId`. */
export function rememberDocumentTitle(attachmentId: string | null | undefined, title: string | null | undefined) {
  const id = attachmentId?.trim();
  const value = title?.trim();
  if (!id || !value || titles.get(id) === value) return;
  titles.delete(id);
  titles.set(id, value);
  while (titles.size > MAX_TITLES) {
    const oldest = titles.keys().next().value;
    if (typeof oldest !== 'string') break;
    titles.delete(oldest);
  }
  emit();
}

export function documentTitleFor(attachmentId: string | null | undefined) {
  const id = attachmentId?.trim();
  return id ? titles.get(id) ?? null : null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function pump() {
  while (running < MAX_TITLE_REQUESTS && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    running += 1;
    const started = generation;
    Promise.resolve()
      .then(() => next.fetch(next.attachmentId))
      .then((document) => { if (started === generation) rememberDocumentTitle(next.attachmentId, document.title); })
      .catch(() => undefined)
      .finally(() => {
        if (started !== generation) return;
        running -= 1;
        pump();
      });
  }
}

/** Fetches the title of a cloud document once, unless one is known or a request already ran. */
export function requestDocumentTitle(attachmentId: string, fetch: DocumentTitleFetch) {
  const id = attachmentId.trim();
  if (!id || titles.has(id) || requested.has(id)) return;
  requested.add(id);
  queue.push({ attachmentId: id, fetch });
  pump();
}

/** The name a list shows: the document's title when it says more than the file name, else the file name. */
export function documentDisplayName(fileName: string, title: string | null | undefined) {
  const value = title?.trim();
  return value && value !== documentNameWithoutExtension(fileName) ? value : fileName;
}

/** Whether a row names a Markdown or HTML document with a cloud copy, the only ones with a server title. */
export function hasCloudDocumentTitle(attachmentId: string | null | undefined, fileName: string) {
  return Boolean(attachmentId?.trim() && documentFormatForPath(fileName));
}

/**
 * The known title of a cloud document, live. With `fetch`, a missing title
 * is requested once; files without a cloud copy are never requested.
 */
export function useDocumentTitle(attachmentId: string | null | undefined, fileName: string, fetch?: DocumentTitleFetch) {
  const cloud = hasCloudDocumentTitle(attachmentId, fileName);
  const id = cloud ? attachmentId?.trim() ?? '' : '';
  const snapshot = () => (id ? titles.get(id) ?? null : null);
  const title = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (id && fetch) requestDocumentTitle(id, fetch);
  }, [fetch, id]);
  return title;
}

export function resetDocumentTitlesForTests() {
  titles.clear();
  requested.clear();
  queue.length = 0;
  running = 0;
  generation += 1;
}
