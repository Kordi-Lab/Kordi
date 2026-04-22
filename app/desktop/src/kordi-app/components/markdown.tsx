import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Check, SquareArrowOutUpRight } from 'lucide-react';

import { cn } from '@/lib/utils';

type MarkdownInlinePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'link'; label: string; href: string };

type MarkdownList = {
  ordered: boolean;
  items: MarkdownListItem[];
};

type MarkdownListItem = {
  text: string;
  checked: boolean | null;
  children: MarkdownList[];
};

type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language?: string; code: string }
  | { type: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

function parseInlineMarkdown(text: string): MarkdownInlinePart[] {
  const parts: MarkdownInlinePart[] = [];
  let index = 0;

  while (index < text.length) {
    const slice = text.slice(index);
    const patterns = [
      { type: 'link' as const, match: slice.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/) },
      { type: 'code' as const, match: slice.match(/^`([^`]+)`/) },
      { type: 'strong' as const, match: slice.match(/^\*\*([^*]+)\*\*/) },
      { type: 'em' as const, match: slice.match(/^\*([^*]+)\*/) },
    ];
    const hit = patterns.find((entry) => entry.match);

    if (!hit?.match) {
      const nextIndex = [slice.indexOf('['), slice.indexOf('`'), slice.indexOf('*')]
        .filter((value) => value >= 0)
        .sort((left, right) => left - right)[0];
      if (nextIndex === undefined) {
        parts.push({ type: 'text', value: text.slice(index) });
        break;
      }
      if (nextIndex === 0) {
        parts.push({ type: 'text', value: slice[0] });
        index += 1;
        continue;
      }
      const endIndex = index + nextIndex;
      parts.push({ type: 'text', value: text.slice(index, endIndex) });
      index = endIndex;
      continue;
    }

    const [matched, first, second] = hit.match;
    if (hit.type === 'link') {
      parts.push({ type: 'link', label: first, href: second ?? '#' });
    } else if (hit.type === 'code') {
      parts.push({ type: 'code', value: first });
    } else if (hit.type === 'strong') {
      parts.push({ type: 'strong', value: first });
    } else {
      parts.push({ type: 'em', value: first });
    }
    index += matched.length;
  }

  return parts;
}

function renderInlineMarkdown(text: string, tone: 'default' | 'muted' = 'default') {
  return parseInlineMarkdown(text).map((part, index) => {
    if (part.type === 'code') {
      return (
        <code
          key={`code-${index}`}
          className={cn(
            'rounded bg-black/20 px-1.5 py-0.5 font-mono text-[0.92em]',
            tone === 'muted' ? 'text-slate-200' : 'text-slate-100',
          )}
        >
          {part.value}
        </code>
      );
    }
    if (part.type === 'strong') {
      return (
        <strong key={`strong-${index}`} className={cn('font-semibold', tone === 'muted' ? 'text-slate-100' : 'text-white')}>
          {part.value}
        </strong>
      );
    }
    if (part.type === 'em') {
      return (
        <em key={`em-${index}`} className={cn('italic', tone === 'muted' ? 'text-slate-300' : 'text-slate-100')}>
          {part.value}
        </em>
      );
    }
    if (part.type === 'link') {
      return (
        <a
          key={`link-${index}`}
          href={part.href}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'inline-flex max-w-full flex-wrap items-center gap-1 break-words [overflow-wrap:anywhere] underline decoration-cyan-400/50 underline-offset-4 transition',
            tone === 'muted' ? 'text-cyan-200 hover:text-cyan-100' : 'text-cyan-300 hover:text-cyan-200',
          )}
        >
          <span>{part.label}</span>
          <SquareArrowOutUpRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </a>
      );
    }
    return <Fragment key={`text-${index}`}>{part.value}</Fragment>;
  });
}

function leadingIndentWidth(line: string) {
  const indent = line.match(/^\s*/)?.[0] ?? '';
  return indent.replace(/\t/g, '    ').length;
}

function parseTaskPrefix(text: string) {
  const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
  if (!task) {
    return { checked: null, text };
  }
  return {
    checked: task[1].toLowerCase() === 'x',
    text: task[2],
  };
}

function splitTableRow(line: string) {
  const trimmed = line.trim();
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const normalized = content.endsWith('|') ? content.slice(0, -1) : content;
  return normalized.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return splitTableRow(trimmed).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function matchListLine(line: string) {
  const match = line.match(/^(\s*)([-*+]|(\d+)\.)\s+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: Boolean(match[3]),
    content: match[4],
  };
}

function parseMarkdownList(lines: string[], startIndex: number): { list: MarkdownList; nextIndex: number } | null {
  const firstLine = matchListLine(lines[startIndex]);
  if (!firstLine) return null;

  const rootList: MarkdownList = { ordered: firstLine.ordered, items: [] };
  const stack: Array<{ indent: number; list: MarkdownList }> = [{ indent: firstLine.indent, list: rootList }];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) break;

    const matched = matchListLine(line);
    if (!matched) break;
    if (matched.indent < stack[0].indent) break;

    while (
      stack.length > 1 &&
      (matched.indent < stack[stack.length - 1].indent ||
        (matched.indent === stack[stack.length - 1].indent && matched.ordered !== stack[stack.length - 1].list.ordered))
    ) {
      stack.pop();
    }

    if (matched.indent > stack[stack.length - 1].indent) {
      const parentItem = stack[stack.length - 1].list.items[stack[stack.length - 1].list.items.length - 1];
      if (!parentItem) break;
      const childList: MarkdownList = { ordered: matched.ordered, items: [] };
      parentItem.children.push(childList);
      stack.push({ indent: matched.indent, list: childList });
    } else if (matched.ordered !== stack[stack.length - 1].list.ordered && matched.indent === stack[0].indent) {
      break;
    }

    const currentList = stack[stack.length - 1].list;
    const parsedTask = parseTaskPrefix(matched.content);
    currentList.items.push({
      text: parsedTask.text,
      checked: parsedTask.checked,
      children: [],
    });
    index += 1;
  }

  return { list: rootList, nextIndex: index };
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks: MarkdownBlock[] = [];
  const lines = normalized.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```([\w-]+)?\s*$/);
    if (codeFence) {
      const language = codeFence[1];
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !lines[index].match(/^```\s*$/)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language, code: body.join('\n') });
      continue;
    }

    if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: quote.join('\n') });
      continue;
    }

    const list = parseMarkdownList(lines, index);
    if (list) {
      blocks.push({ type: 'list', ordered: list.list.ordered, items: list.list.items });
      index = list.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index].trim();
      if (
        /^(#{1,3})\s+/.test(current) ||
        /^```/.test(current) ||
        /^>\s?/.test(current) ||
        matchListLine(lines[index]) ||
        (current.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

function normalizeCodeLanguage(language?: string) {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return 'text';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(normalized)) return 'javascript';
  if (['ts', 'tsx'].includes(normalized)) return 'typescript';
  if (['sh', 'zsh', 'shell'].includes(normalized)) return 'bash';
  return normalized;
}

function inferCodeLanguage(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return 'text';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json';
  }
  if (/^\s*(\$ |>|sudo |cd |ls |pwd |echo |find |grep |git |npm |pnpm |yarn |cargo |rustc )/m.test(code)) {
    return 'bash';
  }
  if (/\b(fn|let mut|impl|pub struct|use std::)\b/.test(code)) {
    return 'rust';
  }
  const tsSignals = [
    /\b(const|let|function|import|export|return)\b/,
    /\b(interface|type|implements|readonly|public|private|protected)\b/,
    /=>/,
    /:\s*[A-Z_a-z][\w<>, |\[\]?]*/,
  ].filter((pattern) => pattern.test(code)).length;
  if (tsSignals >= 2) {
    return 'typescript';
  }
  return 'text';
}

function highlightCodeTokens(line: string, language: string) {
  const patterns: Record<string, RegExp> = {
    json: /("(?:\\.|[^"])*"(?=\s*:)|"(?:\\.|[^"])*"|\btrue\b|\bfalse\b|\bnull\b|-?\b\d+(?:\.\d+)?\b)/g,
    bash: /(#.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\$\{?[A-Za-z_][\w]*\}?|\b(?:if|then|fi|for|in|do|done|case|esac|function|export|sudo|cd|ls|pwd|echo|cat|grep|find|git|npm|pnpm|yarn|cargo)\b|-{1,2}[\w-]+)/g,
    rust: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:fn|let|mut|pub|struct|enum|impl|use|mod|async|await|match|if|else|loop|while|for|in|return|Self|self|Result|Option|Some|None|Ok|Err)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g,
    javascript: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|import|from|export|default|async|await|new|class|extends|try|catch|finally|throw|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g,
    typescript: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|import|from|export|default|async|await|new|class|extends|try|catch|finally|throw|interface|type|implements|public|private|protected|readonly|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g,
    text: /(\u0000)/g,
  };

  const regex = patterns[language] ?? patterns.text;
  const tokens: Array<{ text: string; className?: string }> = [];
  let lastIndex = 0;

  for (const match of line.matchAll(regex)) {
    const matched = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, start) });
    }

    let className = 'text-slate-100';
    if (/^\/\//.test(matched) || /^#/.test(matched)) {
      className = 'text-slate-500';
    } else if (/^"/.test(matched) || /^'/.test(matched) || /^`/.test(matched)) {
      className = language === 'json' && /:\s*$/.test(line.slice(start + matched.length)) ? 'text-cyan-200' : 'text-emerald-200';
    } else if (/^\$/.test(matched) || /^-{1,2}/.test(matched)) {
      className = 'text-fuchsia-200';
    } else if (/^(true|false|null|-?\d)/.test(matched)) {
      className = 'text-amber-200';
    } else {
      className = 'text-violet-200';
    }

    tokens.push({ text: matched, className });
    lastIndex = start + matched.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }

  return tokens.length > 0 ? tokens : [{ text: line }];
}

function MarkdownCodeBlock({
  language,
  code,
  maxHeightClass = 'max-h-[28rem]',
  wrapLines = false,
  headerActions,
}: {
  language?: string;
  code: string;
  maxHeightClass?: string;
  wrapLines?: boolean;
  headerActions?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const resolvedLanguage = useMemo(() => normalizeCodeLanguage(language ?? inferCodeLanguage(code)), [language, code]);
  const highlightedLines = useMemo(() => code.split('\n').map((line) => highlightCodeTokens(line, resolvedLanguage)), [code, resolvedLanguage]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="max-w-full overflow-hidden rounded-[18px] border border-white/8 bg-black/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-2.5 py-1.5">
        <div className="truncate text-[10px] uppercase tracking-[0.12em] text-slate-400">{resolvedLanguage}</div>
        <div className="flex shrink-0 items-center gap-2">
          {headerActions}
          <button
            type="button"
            onClick={() => {
              void handleCopy();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/5 px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : null}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className={cn('overflow-auto px-2.5 py-2.5 font-mono text-[11px] leading-5.5 text-slate-100', maxHeightClass)}>
        <code className={cn('block', wrapLines ? 'min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'min-w-max')}>
          {highlightedLines.map((line, lineIndex) => (
            <div key={`code-line-${lineIndex}`} className={wrapLines ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre'}>
              {line.length === 0
                ? ' '
                : line.map((token, tokenIndex) => (
                    <span
                      key={`code-token-${lineIndex}-${tokenIndex}`}
                      className={token.className}
                    >
                      {token.text}
                    </span>
                  ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function MarkdownListView({ list, depth = 0 }: { list: MarkdownList; depth?: number }) {
  const Wrapper = list.ordered ? 'ol' : 'ul';

  return (
    <Wrapper
      className={cn(
        'space-y-1 text-sm leading-6 text-slate-100 marker:text-slate-500',
        depth === 0 ? 'pl-5' : 'pl-4 pt-1',
        list.ordered ? 'list-decimal' : 'list-disc',
      )}
    >
      {list.items.map((item, index) => (
        <li key={`${depth}-${index}`} className="space-y-1">
          <div className="flex items-start gap-2">
            {item.checked !== null ? (
              <span
                className={cn(
                  'mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                  item.checked ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200' : 'border-white/15 bg-white/5 text-slate-500',
                )}
              >
                {item.checked ? '✓' : ''}
              </span>
            ) : null}
            <div className="min-w-0">{renderInlineMarkdown(item.text)}</div>
          </div>
          {item.children.map((child, childIndex) => (
            <MarkdownListView key={`${depth}-${index}-child-${childIndex}`} list={child} depth={depth + 1} />
          ))}
        </li>
      ))}
    </Wrapper>
  );
}

function MarkdownTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="max-w-full overflow-hidden rounded-2xl border border-white/8 bg-black/10">
      <div className="overflow-x-auto overscroll-x-contain px-1 py-1">
        <table className="min-w-full w-max border-collapse text-left text-sm text-slate-100">
        <thead className="bg-white/[0.05] text-slate-300">
          <tr>
            {headers.map((header, index) => (
              <th key={`header-${index}`} className="border-b border-white/8 px-3 py-2 font-medium">
                {renderInlineMarkdown(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`} className="border-b border-white/6 last:border-b-0">
              {headers.map((_, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`} className="align-top px-3 py-2 text-slate-200">
                  {renderInlineMarkdown(row[cellIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  );
}

function MarkdownContent({ text, className, tone = 'default' }: { text: string; className?: string; tone?: 'default' | 'muted' }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);

  return (
    <div className={cn('min-w-0 space-y-3 break-words [overflow-wrap:anywhere]', className)}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const headingClass =
            block.level === 1
              ? tone === 'muted'
                ? 'app-markdown-muted-heading text-[1.05rem] font-medium text-slate-300'
                : 'text-[1.05rem] font-semibold text-white'
              : block.level === 2
                ? tone === 'muted'
                  ? 'app-markdown-muted-heading text-[0.98rem] font-medium text-slate-300'
                  : 'text-[0.98rem] font-semibold text-white'
                : tone === 'muted'
                  ? 'app-markdown-muted-heading text-[0.92rem] font-medium text-slate-400'
                  : 'text-[0.92rem] font-semibold text-slate-100';
          return (
            <div key={`heading-${index}`} className={cn(headingClass, 'min-w-0 break-words [overflow-wrap:anywhere]')}>
              {renderInlineMarkdown(block.text, tone)}
            </div>
          );
        }
        if (block.type === 'code') {
          return <MarkdownCodeBlock key={`code-${index}`} language={block.language} code={block.code} />;
        }
        if (block.type === 'list') {
          return <MarkdownListView key={`list-${index}`} list={{ ordered: block.ordered, items: block.items }} />;
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={`quote-${index}`} className={cn('min-w-0 break-words [overflow-wrap:anywhere] border-l-2 pl-4 text-sm italic leading-6', tone === 'muted' ? 'app-markdown-muted-quote border-slate-500/20 text-slate-500' : 'border-slate-500/40 text-slate-300')}>
              {block.text.split('\n').map((line, lineIndex) => (
                <p key={`quote-line-${lineIndex}`}>{renderInlineMarkdown(line, tone)}</p>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'table') {
          return <MarkdownTable key={`table-${index}`} headers={block.headers} rows={block.rows} />;
        }
        return (
          <p key={`paragraph-${index}`} className={cn('min-w-0 break-words [overflow-wrap:anywhere] text-sm leading-6', tone === 'muted' ? 'app-markdown-muted-copy text-slate-400' : 'text-slate-100')}>
            {renderInlineMarkdown(block.text, tone)}
          </p>
        );
      })}
    </div>
  );
}

export { MarkdownCodeBlock, MarkdownContent };
