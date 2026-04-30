function arrayFromList<T>(value: ArrayLike<T> | null | undefined): T[] {
  return value ? Array.from(value) : [];
}

function fileIdentity(file: File) {
  return [file.name, file.size, file.type, file.lastModified].join(':');
}

export function extractClipboardFiles(clipboardData: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = arrayFromList(clipboardData.files);
  const seen = new Set(files.map(fileIdentity));

  for (const item of arrayFromList(clipboardData.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const identity = fileIdentity(file);
    if (seen.has(identity)) continue;
    seen.add(identity);
    files.push(file);
  }

  return files;
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function decodeFileUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return pathname.slice(1);
    }
    return pathname;
  } catch {
    return null;
  }
}

function normalizeLocalPathCandidate(value: string) {
  const unquoted = stripWrappingQuotes(value);
  if (!unquoted) return null;

  const filePath = decodeFileUrl(unquoted);
  if (filePath) return filePath;

  if (unquoted.startsWith('/') || unquoted.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(unquoted)) {
    return unquoted;
  }

  return null;
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function pathsFromUriList(uriList: string) {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(normalizeLocalPathCandidate)
    .filter((path): path is string => Boolean(path));
}

function pathsFromPlainText(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const paths = lines.map(normalizeLocalPathCandidate);
  if (paths.some((path) => !path)) return [];
  return paths as string[];
}

export function extractPastedLocalFilePaths(plainText: string, uriList = ''): string[] {
  const uriPaths = pathsFromUriList(uriList);
  if (uriPaths.length > 0) {
    return unique(uriPaths);
  }

  return unique(pathsFromPlainText(plainText));
}
