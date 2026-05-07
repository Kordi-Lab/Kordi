function arrayFromList<T>(value: ArrayLike<T> | null | undefined): T[] {
  return value ? Array.from(value) : [];
}

function fileIdentity(file: File) {
  return [file.name, file.size, file.type, file.lastModified].join(':');
}

function clipboardFileIdentity(file: File) {
  return [file.name, file.size, file.type].join(':');
}

export function extractClipboardFiles(clipboardData: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = arrayFromList(clipboardData.files);
  const seen = new Set(files.map(fileIdentity));
  const seenClipboardFiles = new Set(files.map(clipboardFileIdentity));

  for (const item of arrayFromList(clipboardData.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const identity = fileIdentity(file);
    const clipboardIdentity = clipboardFileIdentity(file);
    if (seen.has(identity) || seenClipboardFiles.has(clipboardIdentity)) continue;
    seen.add(identity);
    seenClipboardFiles.add(clipboardIdentity);
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
    .map((line) => decodeFileUrl(stripWrappingQuotes(line)))
    .filter((path): path is string => Boolean(path));
}

export function extractPastedLocalFilePaths(_plainText: string, uriList = ''): string[] {
  return unique(pathsFromUriList(uriList));
}
