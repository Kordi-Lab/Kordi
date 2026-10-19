export type MarkdownList = {
  ordered: boolean;
  /** Source number of the first item for ordered lists. */
  start: number;
  items: MarkdownListItem[];
};

export type MarkdownListItem = {
  /** Item paragraphs; continuation lines join the last paragraph, blank lines start a new one. */
  paragraphs: string[];
  checked: boolean | null;
  children: MarkdownList[];
};

type ListLine = { indent: number; ordered: boolean; number: number; content: string };

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

function indentWidth(line: string) {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

export function matchListLine(line: string): ListLine | null {
  const match = line.match(/^(\s*)([-*+]|(\d+)\.)\s+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: Boolean(match[3]),
    number: match[3] ? Number.parseInt(match[3], 10) : 1,
    content: match[4],
  };
}

/** Lines that start another block and therefore end a list item's text. */
function startsOtherBlock(trimmed: string) {
  return /^(#{1,3})\s+/.test(trimmed) || /^```/.test(trimmed) || /^>/.test(trimmed);
}

function newList(line: ListLine): MarkdownList {
  return { ordered: line.ordered, start: line.ordered ? line.number : 1, items: [] };
}

export function parseMarkdownList(lines: string[], startIndex: number): { list: MarkdownList; nextIndex: number } | null {
  const firstLine = matchListLine(lines[startIndex]);
  if (!firstLine) return null;

  const rootList = newList(firstLine);
  const rootIndent = firstLine.indent;
  const stack: Array<{ indent: number; list: MarkdownList }> = [{ indent: rootIndent, list: rootList }];
  let index = startIndex;
  let afterBlank = false;

  const lastItem = () => {
    const top = stack[stack.length - 1].list;
    return top.items[top.items.length - 1];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      // A blank line keeps the list open (a loose list) only when the next
      // content continues it: another item, or text indented under an item.
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next >= lines.length) break;
      const nextItem = matchListLine(lines[next]);
      const continues = nextItem
        ? nextItem.indent > rootIndent || (nextItem.indent === rootIndent && nextItem.ordered === rootList.ordered)
        : indentWidth(lines[next]) > rootIndent && !startsOtherBlock(lines[next].trim());
      if (!continues) break;
      index = next;
      afterBlank = true;
      continue;
    }

    const matched = matchListLine(line);
    if (!matched) {
      // Text indented under an item continues it. Unindented text ends the
      // list so a plain line after a list stays its own paragraph.
      const lineIndent = indentWidth(line);
      if (startsOtherBlock(trimmed) || lineIndent <= rootIndent) break;
      // After a blank line, text not indented past a nested list belongs to its parent item.
      while (afterBlank && stack.length > 1 && lineIndent <= stack[stack.length - 1].indent) stack.pop();
      const item = lastItem();
      if (!item) break;
      if (afterBlank) {
        item.paragraphs.push(trimmed);
      } else {
        item.paragraphs[item.paragraphs.length - 1] = `${item.paragraphs[item.paragraphs.length - 1]} ${trimmed}`;
      }
      afterBlank = false;
      index += 1;
      continue;
    }
    if (matched.indent < rootIndent) break;

    while (
      stack.length > 1 &&
      (matched.indent < stack[stack.length - 1].indent ||
        (matched.indent === stack[stack.length - 1].indent && matched.ordered !== stack[stack.length - 1].list.ordered))
    ) {
      stack.pop();
    }

    // Models often write the bullets under a numbered item without indenting
    // them. Nest those bullets under the item instead of ending the list.
    const flatBulletUnderNumber = stack.length === 1 && matched.indent === rootIndent && rootList.ordered
      && !matched.ordered && !afterBlank && rootList.items.length > 0;

    if (matched.indent > stack[stack.length - 1].indent || flatBulletUnderNumber) {
      const parentItem = lastItem();
      if (!parentItem) break;
      const childList = newList(matched);
      parentItem.children.push(childList);
      stack.push({ indent: matched.indent, list: childList });
    } else if (matched.ordered !== stack[stack.length - 1].list.ordered && matched.indent === rootIndent) {
      break;
    }

    const parsedTask = parseTaskPrefix(matched.content);
    stack[stack.length - 1].list.items.push({
      paragraphs: [parsedTask.text],
      checked: parsedTask.checked,
      children: [],
    });
    afterBlank = false;
    index += 1;
  }

  return { list: rootList, nextIndex: index };
}
