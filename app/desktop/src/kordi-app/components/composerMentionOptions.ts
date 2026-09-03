import type { ComposerMentionOption } from './composer';

const sectionOrder: ComposerMentionOption['targetKind'][] = [
  'reference',
  'all',
  'person',
  'agent',
];

export function orderedComposerMentionOptions(items: ComposerMentionOption[]) {
  return [...items].sort((left, right) => (
    sectionOrder.indexOf(left.targetKind) - sectionOrder.indexOf(right.targetKind)
  ));
}
