export type ParsedDiffLine = {
  kind: 'file' | 'hunk' | 'add' | 'delete' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_LITERAL_PATTERN = /\\u001b\[[0-?]*[ -/]*[@-~]|\\x1b\[[0-?]*[ -/]*[@-~]|\[\d+(?:;\d+)*m/g;
const HUNK_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const EDIT_HEADER_PATTERN = /^Applied\s+\d+\/\d+\s+edit\(s\)\s+to\s+(.+)$/;

export function stripAnsi(text: string) {
  return text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(ANSI_LITERAL_PATTERN, '');
}

export function isDiffLikeOutput(text: string) {
  const cleaned = stripAnsi(text);
  const lines = cleaned.split('\n');
  const semanticDiffLines = lines.filter((line) => {
    const trimmedStart = line.trimStart();
    return HUNK_PATTERN.test(line)
      || line.startsWith('diff --git ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || /^[-+]\s/.test(trimmedStart)
      || /^\d+\s+[-+]\s/.test(trimmedStart);
  });

  return semanticDiffLines.length >= 2
    || /^@@\s+-\d+/m.test(cleaned)
    || /^Applied \d+\/\d+ edit\(s\)/m.test(cleaned);
}

function normalizeEditedLine(line: string, readEmbeddedLineNumber: boolean) {
  if (readEmbeddedLineNumber) {
    const numberedEditMatch = /^\s*([+-])\s*(\d+)\s+(.*)$/.exec(line);
    if (numberedEditMatch) {
      return {
        sign: numberedEditMatch[1] as '+' | '-',
        content: numberedEditMatch[3] ?? '',
        lineNumber: Number.parseInt(numberedEditMatch[2], 10),
      };
    }
  }

  const editMatch = readEmbeddedLineNumber
    ? /^\s*([+-])\s*(.*)$/.exec(line)
    : /^([+-])(.*)$/.exec(line);
  if (!editMatch) return null;
  return {
    sign: editMatch[1] as '+' | '-',
    content: editMatch[2] ?? '',
    lineNumber: undefined,
  };
}

function normalizeContextLine(line: string, readEmbeddedLineNumber: boolean) {
  if (!readEmbeddedLineNumber) return { content: line.startsWith(' ') ? line.slice(1) : line };
  const contextMatch = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!contextMatch) return { content: line };
  return {
    content: contextMatch[2] ?? '',
    lineNumber: Number.parseInt(contextMatch[1], 10),
  };
}

export function parseDiffOutput(text: string): ParsedDiffLine[] {
  const lines = stripAnsi(text).split('\n');
  const parsed: ParsedDiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    const hunkMatch = HUNK_PATTERN.exec(line);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[3], 10);
      parsed.push({ kind: 'hunk', content: line });
      continue;
    }

    const editHeaderMatch = EDIT_HEADER_PATTERN.exec(line);
    if (editHeaderMatch) {
      parsed.push({ kind: 'file', content: editHeaderMatch[1]?.trim() ?? line });
      continue;
    }

    if (/^(diff --git |--- |\+\+\+ )/.test(line)) {
      parsed.push({ kind: 'file', content: line });
      continue;
    }

    const readEmbeddedLineNumber = oldLine === null && newLine === null;
    const normalized = normalizeEditedLine(line, readEmbeddedLineNumber);
    if (normalized?.sign === '-') {
      parsed.push({
        kind: 'delete',
        content: normalized.content,
        oldLineNumber: oldLine ?? normalized.lineNumber,
      });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    if (normalized?.sign === '+') {
      parsed.push({
        kind: 'add',
        content: normalized.content,
        newLineNumber: newLine ?? normalized.lineNumber,
      });
      if (newLine !== null) newLine += 1;
      continue;
    }

    const normalizedContext = normalizeContextLine(line, readEmbeddedLineNumber);
    parsed.push({
      kind: 'context',
      content: normalizedContext.content,
      oldLineNumber: oldLine ?? normalizedContext.lineNumber,
      newLineNumber: newLine ?? normalizedContext.lineNumber,
    });
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
  }

  return parsed;
}
