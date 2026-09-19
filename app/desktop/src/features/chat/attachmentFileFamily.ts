export type AttachmentFileFamily =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'code'
  | 'archive'
  | 'image'
  | 'video'
  | 'audio'
  | 'design'
  | 'generic';

export type AttachmentFileFamilyInput = {
  name?: string | null;
  mimeType?: string | null;
  kind?: string | null;
};

const EXTENSION_FAMILIES: Record<Exclude<AttachmentFileFamily, 'generic'>, readonly string[]> = {
  pdf: ['pdf'],
  doc: ['doc', 'docx', 'txt', 'md', 'markdown', 'rtf', 'pages', 'odt'],
  sheet: ['xls', 'xlsx', 'csv', 'tsv', 'numbers', 'ods'],
  slides: ['ppt', 'pptx', 'key', 'odp'],
  code: [
    'json', 'xml', 'yaml', 'yml', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
    'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'php', 'sh', 'bash',
    'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'toml', 'ini', 'env', 'lock', 'ipynb',
  ],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lz', 'lzma', 'zst'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'avif', 'ico'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'wma'],
  design: ['fig', 'sketch', 'psd', 'ai', 'xd', 'indd', 'afdesign', 'afphoto', 'blend'],
};

const EXTENSION_TO_FAMILY = new Map<string, AttachmentFileFamily>();
for (const [family, extensions] of Object.entries(EXTENSION_FAMILIES)) {
  for (const extension of extensions) {
    EXTENSION_TO_FAMILY.set(extension, family as AttachmentFileFamily);
  }
}

export function attachmentExtension(name?: string | null) {
  const candidate = name?.trim() ?? '';
  const match = candidate.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

export function attachmentFileFamily(attachment: AttachmentFileFamilyInput): AttachmentFileFamily {
  const byExtension = EXTENSION_TO_FAMILY.get(attachmentExtension(attachment.name));
  if (byExtension) return byExtension;

  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('spreadsheet') || mimeType === 'text/csv') return 'sheet';
  if (mimeType.includes('presentation')) return 'slides';
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('tar')) return 'archive';
  if (mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('yaml')) return 'code';
  if (mimeType.startsWith('text/')) return 'doc';
  if (attachment.kind === 'image') return 'image';
  return 'generic';
}

export function attachmentFileTileLabel(formatLabel: string) {
  const trimmed = formatLabel.trim().toUpperCase();
  return (trimmed || 'FILE').slice(0, 4);
}

/** Splits a filename so the extension can stay visible while the base truncates. */
export function splitAttachmentName(name?: string | null) {
  const value = name?.trim() ?? '';
  const extension = attachmentExtension(value);
  if (!extension) return { base: value, extension: '' };
  const suffix = value.slice(-(extension.length + 1));
  return { base: value.slice(0, -suffix.length), extension: suffix };
}
