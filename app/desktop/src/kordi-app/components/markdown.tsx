import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

import {
  handleDocumentCopySurfaceKeyDown,
  type KordiCopySurface,
} from '@/features/contentSelection';
import { cn } from '@/lib/utils';
import { ExternalMessageLink, MessageInlineContent } from './messageInlineContent';
import { MarkdownTable } from './markdownTable';
import {
  bareHttpUrlStartPattern,
  safeExternalHttpHref,
  splitBareHttpUrl,
} from './messageLinks';

export { openExternalMessageLink as openExternalMarkdownLink } from './messageLinks';

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

function nextInlineTokenIndex(slice: string) {
  return [slice.indexOf('['), slice.indexOf('`'), slice.indexOf('*'), slice.search(bareHttpUrlStartPattern)]
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];
}

function parseInlineMarkdown(text: string): MarkdownInlinePart[] {
  const parts: MarkdownInlinePart[] = [];
  let index = 0;

  while (index < text.length) {
    const slice = text.slice(index);
    const patterns = [
      { type: 'link' as const, match: slice.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i) },
      { type: 'bareLink' as const, match: slice.match(/^https?:\/\/[^\s<>"']+/i) },
      { type: 'code' as const, match: slice.match(/^`([^`]+)`/) },
      { type: 'strong' as const, match: slice.match(/^\*\*([^*]+)\*\*/) },
      { type: 'em' as const, match: slice.match(/^\*([^*]+)\*/) },
    ];
    const hit = patterns.find((entry) => entry.match);

    if (!hit?.match) {
      const nextIndex = nextInlineTokenIndex(slice);
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
      const href = safeExternalHttpHref(second ?? '');
      parts.push(href
        ? { type: 'link', label: first, href }
        : { type: 'text', value: matched });
    } else if (hit.type === 'bareLink') {
      const { href, suffix } = splitBareHttpUrl(matched);
      const safeHref = safeExternalHttpHref(href);
      parts.push(safeHref
        ? { type: 'link', label: href, href: safeHref }
        : { type: 'text', value: href });
      if (suffix) {
        parts.push({ type: 'text', value: suffix });
      }
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

function renderInlineMarkdown(
  text: string,
  tone: 'default' | 'muted' = 'default',
  showLinkIcons = false,
) {
  return parseInlineMarkdown(text).map((part, index) => {
    if (part.type === 'code') {
      return (
        <code
          key={`code-${index}`}
          className={cn(
            'rounded bg-[color:var(--app-control-bg)] px-1.5 py-0.5 font-mono text-[0.92em]',
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
          <MessageInlineContent text={part.value} showSiteIcons={false} />
        </strong>
      );
    }
    if (part.type === 'em') {
      return (
        <em key={`em-${index}`} className={cn('italic', tone === 'muted' ? 'text-slate-300' : 'text-slate-100')}>
          <MessageInlineContent text={part.value} showSiteIcons={false} />
        </em>
      );
    }
    if (part.type === 'link') {
      return (
        <ExternalMessageLink
          key={`link-${index}`}
          href={part.href}
          tone={tone}
          showSiteIcon={showLinkIcons}
        >
          {part.label}
        </ExternalMessageLink>
      );
    }
    return <Fragment key={`text-${index}`}><MessageInlineContent text={part.value} showSiteIcons={false} /></Fragment>;
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

    const codeFence = trimmed.match(/^(`{3,})([^\s`]*)?.*$/);
    if (codeFence) {
      const language = codeFence[2] || undefined;
      const fenceLength = codeFence[1].length;
      index += 1;
      const body: string[] = [];
      while (index < lines.length) {
        const closingFence = lines[index].trim().match(/^(`{3,})\s*$/);
        if (closingFence && closingFence[1].length >= fenceLength) break;
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
  if (['py', 'py3'].includes(normalized)) return 'python';
  if (['sh', 'zsh', 'shell'].includes(normalized)) return 'bash';
  if (['yml'].includes(normalized)) return 'yaml';
  if (['md', 'mdx'].includes(normalized)) return 'markdown';
  if (['htm', 'xml', 'svg'].includes(normalized)) return 'html';
  if (['mmd'].includes(normalized)) return 'mermaid';
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
    css: /(\/\*[\s\S]*?\*\/|#[\da-fA-F]{3,8}\b|\.[A-Za-z_-][\w-]*|#[A-Za-z_-][\w-]*|--[A-Za-z_-][\w-]*|\b(?:color|background|display|grid|flex|position|border|padding|margin|font|width|height|oklch|var|calc|clamp)\b|-?\b\d+(?:\.\d+)?(?:%|px|rem|em|vh|vw)?\b|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g,
    html: /(<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|\b[A-Za-z_:][-A-Za-z0-9_:.]*(?=\=)|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b\d+(?:\.\d+)?\b|\/?>)/g,
    markdown: /(`[^`]+`|^#{1,6}\s.*$|^>.*$|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|^\s*(?:[-*+] |\d+\. ))/g,
    mermaid: /(%%.*$|\b(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|participant|actor|subgraph|end|style|classDef|class|click|linkStyle)\b|-->|---|==>|-.->|\[[^\]]*\]|\{[^}]*\}|\([^)]*\))/g,
    python: /(#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:def|class|return|if|elif|else|for|while|in|import|from|as|try|except|finally|with|lambda|True|False|None|async|await|yield|pass|break|continue)\b|\b\d+(?:\.\d+)?\b)/g,
    rust: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:fn|let|mut|pub|struct|enum|impl|use|mod|async|await|match|if|else|loop|while|for|in|return|Self|self|Result|Option|Some|None|Ok|Err)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g,
    javascript: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|import|from|export|default|async|await|new|class|extends|try|catch|finally|throw|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g,
    typescript: /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|import|from|export|default|async|await|new|class|extends|try|catch|finally|throw|interface|type|implements|public|private|protected|readonly|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g,
    yaml: /(#.*$|^\s*[-?]\s|[A-Za-z_][\w.-]*(?=\s*:)|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\btrue\b|\bfalse\b|\bnull\b|-?\b\d+(?:\.\d+)?\b)/g,
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
    if (/^(\/\/|#|%%|<!--|\/\*)/.test(matched)) {
      className = 'text-slate-500';
    } else if (/^"/.test(matched) || /^'/.test(matched) || /^`/.test(matched)) {
      className = language === 'json' && /:\s*$/.test(line.slice(start + matched.length)) ? 'text-cyan-200' : 'text-emerald-200';
    } else if (/^(<\/?|\b[A-Za-z_:][-A-Za-z0-9_:.]*(?=\=)|[A-Za-z_][\w.-]*(?=\s*:))/.test(matched)) {
      className = 'text-cyan-200';
    } else if (/^(\$|-{1,2}|\.|--|#(?:[A-Za-z_-]|[\da-fA-F]{3,8}\b))/.test(matched)) {
      className = 'text-fuchsia-200';
    } else if (/^(true|false|null|True|False|None|-?\d)/.test(matched)) {
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

function mermaidLines(code: string) {
  return code.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('%%'));
}

function mermaidNode(raw: string) {
  const trimmed = raw.trim().replace(/;$/, '');
  const match = trimmed.match(/^([A-Za-z0-9_.$-]+)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?$/);
  const id = match?.[1] ?? trimmed;
  const label = (match?.[2] ?? match?.[3] ?? match?.[4] ?? id).replace(/^"|"$/g, '');
  return { id, label };
}

function MermaidFlowchart({ lines }: { lines: string[] }) {
  const direction = lines[0]?.match(/^(?:graph|flowchart)\s+(LR|RL|TD|TB|BT)/i)?.[1]?.toUpperCase() ?? 'TD';
  const horizontal = direction === 'LR' || direction === 'RL';
  const nodes = new Map<string, string>();
  const edges: Array<{ from: string; to: string; dashed: boolean }> = [];

  for (const line of lines.slice(1)) {
    const edge = line.match(/^(.+?)\s*(-->|---|==>|-.->)\s*(.+)$/);
    if (!edge) continue;
    const from = mermaidNode(edge[1]);
    const to = mermaidNode(edge[3]);
    nodes.set(from.id, from.label);
    nodes.set(to.id, to.label);
    edges.push({ from: from.id, to: to.id, dashed: edge[2].includes('.') });
  }

  if (nodes.size === 0) return null;

  const entries = [...nodes.entries()];
  const positions = new Map(entries.map(([id], index) => [id, horizontal ? { x: 86 + index * 150, y: 88 } : { x: 190, y: 58 + index * 96 }]));
  const width = horizontal ? Math.max(320, entries.length * 150 + 40) : 380;
  const height = horizontal ? 190 : Math.max(190, entries.length * 96 + 28);

  return (
    <svg role="img" aria-label="Mermaid diagram preview" viewBox={`0 0 ${width} ${height}`} className="min-h-[12rem] w-full min-w-[22rem] text-slate-950">
      <defs>
        <marker id="mermaid-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
        </marker>
      </defs>
      {edges.map((edge, index) => {
        const from = positions.get(edge.from) ?? { x: 0, y: 0 };
        const to = positions.get(edge.to) ?? { x: 0, y: 0 };
        return <line key={`edge-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth="1.6" strokeDasharray={edge.dashed ? '5 5' : undefined} markerEnd="url(#mermaid-arrow)" opacity="0.55" />;
      })}
      {entries.map(([id, label]) => {
        const position = positions.get(id) ?? { x: 0, y: 0 };
        return (
          <g key={id}>
            <rect x={position.x - 56} y={position.y - 22} width="112" height="44" rx="12" fill="white" stroke="currentColor" strokeOpacity="0.18" />
            <text x={position.x} y={position.y + 4} textAnchor="middle" className="fill-slate-900 text-[12px] font-medium">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MermaidSequence({ lines }: { lines: string[] }) {
  const messages = lines.slice(1).map((line) => line.match(/^([^:-]+?)(?:-+>>?|-->>?)\s*([^:]+):?\s*(.*)$/)).filter((match): match is RegExpMatchArray => Boolean(match));
  if (messages.length === 0) return null;
  const participants = [...new Set(messages.flatMap((message) => [message[1].trim(), message[2].trim()]))];
  const width = Math.max(360, participants.length * 160);
  const height = Math.max(220, messages.length * 64 + 96);
  const xFor = (name: string) => 80 + participants.indexOf(name) * 150;

  return (
    <svg role="img" aria-label="Mermaid sequence diagram preview" viewBox={`0 0 ${width} ${height}`} className="min-h-[14rem] w-full min-w-[24rem] text-slate-950">
      <defs><marker id="sequence-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="currentColor" /></marker></defs>
      {participants.map((participant) => {
        const x = xFor(participant);
        return <g key={participant}><rect x={x - 46} y="24" width="92" height="32" rx="10" fill="white" stroke="currentColor" strokeOpacity="0.18" /><text x={x} y="45" textAnchor="middle" className="fill-slate-900 text-[12px] font-medium">{participant}</text><line x1={x} y1="60" x2={x} y2={height - 24} stroke="currentColor" strokeOpacity="0.18" strokeDasharray="4 5" /></g>;
      })}
      {messages.map((message, index) => {
        const y = 96 + index * 56;
        const from = xFor(message[1].trim());
        const to = xFor(message[2].trim());
        return <g key={`message-${index}`}><line x1={from} y1={y} x2={to} y2={y} stroke="currentColor" strokeWidth="1.6" markerEnd="url(#sequence-arrow)" /><text x={(from + to) / 2} y={y - 8} textAnchor="middle" className="fill-slate-700 text-[11px]">{message[3]}</text></g>;
      })}
    </svg>
  );
}

function MermaidPie({ lines }: { lines: string[] }) {
  const rows = lines.map((line) => line.match(/^"?([^":]+)"?\s*:\s*(\d+(?:\.\d+)?)$/)).filter((match): match is RegExpMatchArray => Boolean(match));
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((row) => Number(row[2])));
  return (
    <div className="space-y-2 p-4 text-slate-900">
      {rows.map((row) => <div key={row[1]} className="grid grid-cols-[7rem_minmax(0,1fr)_3rem] items-center gap-3 text-[12px]"><div className="truncate font-medium">{row[1]}</div><div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-slate-900" style={{ width: `${Math.max(4, (Number(row[2]) / max) * 100)}%` }} /></div><div className="text-right tabular-nums text-slate-600">{row[2]}</div></div>)}
    </div>
  );
}

function MermaidDiagram({
  code,
  className,
  copySurface,
}: {
  code: string;
  className?: string;
  copySurface?: KordiCopySurface;
}) {
  const lines = mermaidLines(code);
  const diagram = lines[0]?.startsWith('sequenceDiagram')
    ? <MermaidSequence lines={lines} />
    : lines[0]?.startsWith('pie')
      ? <MermaidPie lines={lines} />
      : /^(graph|flowchart)\b/i.test(lines[0] ?? '')
        ? <MermaidFlowchart lines={lines} />
        : null;

  return (
    <div data-mermaid-diagram="true" data-kordi-copy-block="true" className={cn('overflow-hidden rounded-[18px] border border-white/8 bg-[color:var(--app-code-bg)]', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-3 py-2" data-kordi-copy-exclude="true">
        <div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Mermaid diagram</div>
        {!diagram ? <div className="truncate text-[10px] text-amber-200">Source preview</div> : null}
      </div>
      {diagram ? (
        <div
          className="overflow-auto bg-white p-3"
          data-kordi-copy-surface={copySurface}
          tabIndex={copySurface === 'document' ? 0 : undefined}
          onKeyDown={copySurface === 'document' ? handleDocumentCopySurfaceKeyDown : undefined}
        >
          {diagram}
        </div>
      ) : (
        <div className="p-3"><MarkdownCodeBlock language="mermaid" code={code} maxHeightClass="max-h-[20rem]" copySurface={copySurface} /></div>
      )}
    </div>
  );
}

function MarkdownCodeBlock({
  language,
  code,
  maxHeightClass = 'max-h-[28rem]',
  wrapLines = false,
  headerActions,
  copySurface,
}: {
  language?: string;
  code: string;
  maxHeightClass?: string;
  wrapLines?: boolean;
  headerActions?: ReactNode;
  copySurface?: KordiCopySurface;
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
    <div
      className="group relative max-w-full overflow-hidden rounded-[10px] border border-white/8 bg-[color:var(--app-code-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
      aria-label={`Code block language: ${resolvedLanguage}`}
      data-kordi-copy-block="true"
    >
      <span className="sr-only" data-kordi-copy-exclude="true">{resolvedLanguage}</span>
      {headerActions ? (
        <div className="absolute right-9 top-2 z-10 flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {headerActions}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        onClick={() => {
          void handleCopy();
        }}
        className="app-button-quiet app-markdown-code-copy-button absolute right-2 top-2 z-10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      </button>
      <pre
        className={cn('overflow-auto px-2.5 py-2.5 font-mono text-[11px] leading-5.5 text-slate-100', maxHeightClass)}
        data-kordi-copy-surface={copySurface}
        tabIndex={copySurface === 'document' ? 0 : undefined}
        onKeyDown={copySurface === 'document' ? handleDocumentCopySurfaceKeyDown : undefined}
      >
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

function MarkdownListView({
  list,
  depth = 0,
  showLinkIcons = false,
}: {
  list: MarkdownList;
  depth?: number;
  showLinkIcons?: boolean;
}) {
  const Wrapper = list.ordered ? 'ol' : 'ul';

  return (
    <Wrapper
      data-kordi-copy-block={depth === 0 ? 'true' : undefined}
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
                  item.checked ? 'border-emerald-400/60 bg-[linear-gradient(180deg,rgba(16,185,129,0.18),rgba(6,95,70,0.16))] text-emerald-200' : 'border-white/15 bg-white/5 text-slate-300',
                )}
              >
                {item.checked ? '✓' : ''}
              </span>
            ) : null}
            <div className="min-w-0">{renderInlineMarkdown(item.text, 'default', showLinkIcons)}</div>
          </div>
          {item.children.map((child, childIndex) => (
            <MarkdownListView key={`${depth}-${index}-child-${childIndex}`} list={child} depth={depth + 1} showLinkIcons={showLinkIcons} />
          ))}
        </li>
      ))}
    </Wrapper>
  );
}

function MarkdownContent({
  text,
  className,
  tone = 'default',
  showLinkIcons = false,
  copySurface,
}: {
  text: string;
  className?: string;
  tone?: 'default' | 'muted';
  showLinkIcons?: boolean;
  copySurface?: KordiCopySurface;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);

  return (
    <div
      className={cn('min-w-0 space-y-3 break-words [overflow-wrap:anywhere]', className)}
      data-kordi-copy-surface={copySurface}
      tabIndex={copySurface === 'document' ? 0 : undefined}
      onKeyDown={copySurface === 'document' ? handleDocumentCopySurfaceKeyDown : undefined}
    >
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
            <div key={`heading-${index}`} data-kordi-copy-block="true" className={cn(headingClass, 'min-w-0 break-words [overflow-wrap:anywhere]')}>
              {renderInlineMarkdown(block.text, tone, showLinkIcons)}
            </div>
          );
        }
        if (block.type === 'code') {
          return normalizeCodeLanguage(block.language) === 'mermaid'
            ? <MermaidDiagram key={`code-${index}`} code={block.code} />
            : <MarkdownCodeBlock key={`code-${index}`} language={block.language} code={block.code} />;
        }
        if (block.type === 'list') {
          return <MarkdownListView key={`list-${index}`} list={{ ordered: block.ordered, items: block.items }} showLinkIcons={showLinkIcons} />;
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={`quote-${index}`} data-kordi-copy-block="true" className={cn('min-w-0 break-words [overflow-wrap:anywhere] border-l-2 pl-4 text-sm italic leading-6', tone === 'muted' ? 'app-markdown-muted-quote border-slate-500/20 text-slate-500' : 'border-slate-500/40 text-slate-300')}>
              {block.text.split('\n').map((line, lineIndex) => (
                <p key={`quote-line-${lineIndex}`}>{renderInlineMarkdown(line, tone, showLinkIcons)}</p>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={`table-${index}`} data-kordi-copy-block="true">
              <MarkdownTable
                headers={block.headers}
                rows={block.rows}
                renderCell={(value) => renderInlineMarkdown(value, 'default', showLinkIcons)}
              />
            </div>
          );
        }
        return (
          <p key={`paragraph-${index}`} data-kordi-copy-block="true" className={cn('min-w-0 break-words [overflow-wrap:anywhere] text-sm leading-6', tone === 'muted' ? 'app-markdown-muted-copy text-slate-400' : 'text-slate-100')}>
            {renderInlineMarkdown(block.text, tone, showLinkIcons)}
          </p>
        );
      })}
    </div>
  );
}

export { MarkdownCodeBlock, MarkdownContent, MermaidDiagram };
