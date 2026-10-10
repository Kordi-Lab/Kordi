const MEMORY_SECTION_HEADING = '## Memories';

function placeholderScopedLessonLine(line: string) {
  if (/^\s*-\s*Global scope `[^`]*`:\s*\S+/.test(line)) {
    return '- Global scope `account`: <global lesson artifact path>';
  }
  if (/^\s*-\s*Conversation scope `[^`]*`:\s*\S+/.test(line)) {
    return '- Conversation scope `{session_id}`: <conversation lesson artifact path>';
  }
  if (/^\s*-\s*Project scope `[^`]*`:\s*\S+/.test(line)) {
    return '- Project scope `{project_scope_id}`: <project lesson artifact path>';
  }
  if (/^\s*-\s*Group scope `[^`]*`:\s*\S+/.test(line)) {
    return '- Group scope `{group_scope_id}`: <group lesson artifact path>';
  }
  return line;
}

export function promptDisplayText(systemPrompt: string) {
  if (!systemPrompt.includes(MEMORY_SECTION_HEADING)) return systemPrompt;
  return systemPrompt
    .split('\n')
    .map(placeholderScopedLessonLine)
    .join('\n');
}
