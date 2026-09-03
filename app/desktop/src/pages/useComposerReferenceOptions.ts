import { useEffect, useMemo, useState } from 'react';

import type { MentionQuery } from '@/app/useKordiAppModelHelpers';
import type { ComposerMentionOption } from '@/kordi-app/components';
import { orderedComposerMentionOptions } from '@/kordi-app/components/composerMentionOptions';
import type { DesktopArtifactDirectoryEntry } from '@/kordi-app/types';
import { fetchDesktopChatArtifactDirectory } from '@/lib/desktop';

export function composerReferenceDirectorySearch(raw: string) {
  if (/^https?:\/\//i.test(raw) || !/[\\/]/.test(raw)) return null;
  const separator = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const directory = separator === 2 && raw[1] === ':'
    ? raw.slice(0, 3)
    : raw.slice(0, separator) || raw[separator];
  return {
    directory,
    prefix: raw.slice(0, separator + 1),
    leaf: raw.slice(separator + 1),
  };
}

function fileKindLabel(entry: DesktopArtifactDirectoryEntry) {
  if (entry.kind === 'code') return 'Code file';
  if (entry.kind === 'document') return 'Document';
  return 'File';
}

export function composerFileReferenceOptions(
  entries: DesktopArtifactDirectoryEntry[],
  search: NonNullable<ReturnType<typeof composerReferenceDirectorySearch>>,
): ComposerMentionOption[] {
  const leaf = search.leaf.toLocaleLowerCase();
  return entries
    .filter((entry) => entry.name.toLocaleLowerCase().includes(leaf))
    .sort((left, right) => {
      const leftStarts = left.name.toLocaleLowerCase().startsWith(leaf);
      const rightStarts = right.name.toLocaleLowerCase().startsWith(leaf);
      return Number(rightStarts) - Number(leftStarts);
    })
    .slice(0, 6)
    .map((entry) => ({
      value: `${search.prefix}${entry.name}${entry.isDirectory ? '/' : ''}`,
      label: `${entry.name}${entry.isDirectory ? '/' : ''}`,
      detail: entry.isDirectory
        ? 'Browse this folder'
        : `${fileKindLabel(entry)} · ${search.prefix || 'Current folder'}`,
      targetKind: 'reference',
      sourceHostId: 'local-files',
      nodeId: entry.path,
      runtime: 'reference',
      referenceKind: entry.isDirectory ? 'directory' : 'file',
      referencePath: entry.path,
      keepMenuOpen: entry.isDirectory,
    }));
}

export function mergeComposerMentionOptions(
  items: ComposerMentionOption[],
  fileOptions: ComposerMentionOption[],
) {
  const seen = new Set<string>();
  const actions = items.filter((item) => item.referenceAction);
  const rest = items.filter((item) => !item.referenceAction);
  return orderedComposerMentionOptions([...actions, ...fileOptions, ...rest].filter((item) => {
    const key = `${item.targetKind}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function useComposerReferenceOptions({
  isNativeShell,
  query,
  rootPath,
}: {
  isNativeShell: boolean;
  query: MentionQuery | null;
  rootPath?: string | null;
}) {
  const queryRaw = query?.raw ?? null;
  const search = useMemo(
    () => queryRaw === null ? null : composerReferenceDirectorySearch(queryRaw.trim()),
    [queryRaw],
  );
  const directory = search?.directory ?? null;
  const searchOutsideRoot = Boolean(directory && /^(?:~(?:[\\/]|$)|[\\/]|[a-z]:[\\/])/i.test(directory));
  const effectiveRoot = searchOutsideRoot ? null : rootPath?.trim() || null;
  const requestKey = isNativeShell && search
    ? `${effectiveRoot ?? ''}\n${directory ?? ''}`
    : null;
  const [result, setResult] = useState<{
    key: string;
    entries: DesktopArtifactDirectoryEntry[];
  } | null>(null);

  useEffect(() => {
    if (!requestKey) return undefined;
    let cancelled = false;
    void fetchDesktopChatArtifactDirectory(directory, effectiveRoot)
      .then((next) => {
        if (!cancelled) setResult({ key: requestKey, entries: next.entries });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, entries: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [directory, effectiveRoot, requestKey]);

  return useMemo(() => (
    search && result?.key === requestKey
      ? composerFileReferenceOptions(result.entries, search)
      : []
  ), [requestKey, result, search]);
}
