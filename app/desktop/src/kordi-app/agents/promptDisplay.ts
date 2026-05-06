const SCOPED_LESSON_SECTION_HEADING = '## Scoped lesson artifacts';

function placeholderScopedLessonLine(line: string) {
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
  if (!systemPrompt.includes(SCOPED_LESSON_SECTION_HEADING)) return systemPrompt;
  return systemPrompt
    .split('\n')
    .map(placeholderScopedLessonLine)
    .join('\n');
}
