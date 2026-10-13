import type { DesktopArtifactDirectoryEntry, SessionArtifact } from '@/kordi-app/types';

export const ARTIFACT_MARKDOWN_PREVIEW_CLASS = 'app-artifact-markdown-preview app-artifact-preview-opaque-surface text-[12px] leading-5 [&_p]:text-[12px] [&_p]:leading-5 [&_p]:text-[color:var(--utility-foreground)] [&_div]:text-[12px] [&_div]:leading-5 [&_blockquote]:text-[12px] [&_blockquote]:leading-5 [&_ul]:space-y-0.5 [&_ol]:space-y-0.5 [&_li]:space-y-0.5 [&_pre]:text-[10.5px] [&_pre]:leading-5';

export function formattedJsonSource(source: string) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

export function formatFileSize(value?: number | null) {
  if (!value) return 'File';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function artifactFromDirectoryEntry(entry: DesktopArtifactDirectoryEntry): SessionArtifact {
  return {
    id: `folder:${entry.path}`,
    path: entry.path,
    name: entry.name,
    kind: entry.kind === 'directory' ? 'file' : entry.kind,
    category: 'related',
    summary: `Project folder file • ${formatFileSize(entry.sizeBytes)}`,
    timeLabel: 'Folder',
  };
}
