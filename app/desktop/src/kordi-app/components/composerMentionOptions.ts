import type { ComposerMentionOption } from './composer';

const sectionOrder: ComposerMentionOption['targetKind'][] = [
  'reference',
  'all',
  'person',
  'agent',
];

export function orderedComposerMentionOptions(items: ComposerMentionOption[]) {
  return [...items].sort((left, right) => (
    sectionOrder.indexOf(left.targetKind) - sectionOrder.indexOf(right.targetKind)
  ));
}

export type MentionQuery = {
  start: number;
  end: number;
  normalized: string;
  raw: string;
  trailingWhitespace: boolean;
  quote?: '"' | "'";
};

export function normalizeMentionSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function currentMentionQuery(text: string, cursor = text.length): MentionQuery | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const start = text.lastIndexOf('@', end - 1);
  if (start < 0) return null;
  const token = text.slice(start + 1, end);
  const quote = token[0] === '"' || token[0] === "'" ? token[0] : undefined;
  const raw = quote ? token.slice(1) : token;
  if (raw.length > 512 || /[\n\r]/.test(raw)) return null;
  // Whitespace completes an unquoted reference; subsequent prose must not
  // reopen the popup. Quoted paths can still contain spaces.
  if (quote ? raw.includes(quote) : /\s/.test(raw)) return null;
  return {
    start,
    end,
    normalized: normalizeMentionSearch(raw),
    raw,
    trailingWhitespace: /\s$/.test(raw),
    ...(quote ? { quote } : {}),
  };
}

function referenceOption(
  value: string,
  label: string,
  detail: string,
  referenceKind: NonNullable<ComposerMentionOption['referenceKind']>,
  keepMenuOpen = false,
  referenceAction?: ComposerMentionOption['referenceAction'],
): ComposerMentionOption {
  return {
    value,
    label,
    detail,
    targetKind: 'reference',
    sourceHostId: 'composer-reference',
    nodeId: referenceAction ?? `${referenceKind}:${value}`,
    runtime: 'reference',
    referenceKind,
    referencePath: referenceKind === 'file' ? value : null,
    referenceAction,
    keepMenuOpen,
  };
}

function composerReferenceOptions(query: MentionQuery, allowLocalFiles: boolean) {
  const raw = query.raw.trim();
  if (!raw) {
    return [
      ...(allowLocalFiles
        ? [referenceOption('', 'Attach file…', 'Choose a local file', 'file', false, 'pick-file')]
        : []),
      ...(allowLocalFiles
        ? [referenceOption('~/', 'Local path', 'Browse from your home folder', 'directory', true, 'home-path')]
        : []),
      referenceOption('https://', 'Web link', 'Example: @https://example.com', 'url', true),
    ];
  }
  if (/^https?:\/\//i.test(raw)) {
    let complete = false;
    try {
      complete = Boolean(new URL(raw).hostname);
    } catch {
      complete = false;
    }
    return [referenceOption(
      raw,
      raw,
      complete ? 'Add this web reference' : 'Continue typing a URL',
      'url',
      !complete,
    )];
  }
  return [];
}

export function insertComposerMention(
  text: string,
  query: MentionQuery,
  item: ComposerMentionOption,
) {
  const prefix = text.slice(0, query.start);
  const rawSuffix = text.slice(query.end);
  const suffix = query.quote && rawSuffix.startsWith(query.quote) ? rawSuffix.slice(1) : rawSuffix;
  const keepsSigil = item.targetKind !== 'reference' || item.keepMenuOpen;
  const quotePath = item.targetKind === 'reference' && item.keepMenuOpen
    && (Boolean(query.quote) || /\s/.test(item.value));
  const replacement = quotePath ? `@"${item.value}"` : `${keepsSigil ? '@' : ''}${item.value}`;
  const separator = item.keepMenuOpen || !replacement || /^\s/.test(suffix) ? '' : ' ';
  return {
    value: `${prefix}${replacement}${separator}${suffix}`,
    cursor: prefix.length + replacement.length + separator.length - (quotePath ? 1 : 0),
  };
}

export function mentionTargetMatchesExactly(target: ComposerMentionOption, normalizedQuery: string) {
  return [target.value, target.label]
    .map(normalizeMentionSearch)
    .some((value) => value === normalizedQuery);
}

export function filterMentionTargets(
  targets: ComposerMentionOption[],
  query: MentionQuery | null,
  { allowLocalFiles = true }: { allowLocalFiles?: boolean } = {},
) {
  if (query === null) return [];
  const references = composerReferenceOptions(query, allowLocalFiles);
  if (!query.normalized) {
    return orderedComposerMentionOptions([...references, ...targets]);
  }
  if (query.trailingWhitespace && targets.some((target) => mentionTargetMatchesExactly(target, query.normalized))) {
    return [];
  }

  const matches = targets.filter((target) => {
    const haystack = normalizeMentionSearch(`${target.label} ${target.detail ?? ''} ${target.nodeId} ${target.runtime}`);
    return haystack.includes(query.normalized);
  });
  return orderedComposerMentionOptions([...references, ...matches]);
}
