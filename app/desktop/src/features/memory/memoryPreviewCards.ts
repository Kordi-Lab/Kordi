// Sample Grounding cards and chat names for the preview memory client. The card rule follows the
// server (#2035): a memory's cards are the ones its category routes to, minus the cards the person
// removed it from, plus the cards they added it to. Group memories have no cards.

import type { MemoryCategory } from './memoryCategory';
import type { MemoryLesson } from './memoryModel';
import type { MemoryOriginSources } from './memoryOrigin';
import type { MemoryCard } from './memoryOrganizerModel';

export const PREVIEW_CARDS: MemoryCard[] = [
  { profileId: 'cgp-preview-work', kind: 'work', name: 'Work' },
  { profileId: 'cgp-preview-health', kind: 'health', name: 'Health' },
  { profileId: 'cgp-preview-daily', kind: 'daily', name: 'Daily' },
  { profileId: 'cgp-preview-lab', kind: 'custom', name: 'Lab' },
];

const ROUTES: Partial<Record<MemoryCategory, string[]>> = {
  work_context: ['work'],
  education_learner_profile: ['work'],
  health_context: ['health'],
  location_context: ['daily'],
  purchase_history_preferences: ['daily'],
  coordination_context: ['work', 'health', 'daily'],
};

/** Cards the sample memories were added to by hand. */
const PREVIEW_ADDED: Record<string, string[]> = {
  'lesson-2': ['cgp-preview-lab'],
  'lesson-6': ['cgp-preview-lab'],
};

export function createPreviewCardRouting() {
  const added = new Map<string, Set<string>>(Object.entries(PREVIEW_ADDED).map(([id, cards]) => [id, new Set(cards)]));
  const removed = new Map<string, Set<string>>();
  const setOf = (map: Map<string, Set<string>>, lessonId: string) => {
    let set = map.get(lessonId);
    if (!set) {
      set = new Set();
      map.set(lessonId, set);
    }
    return set;
  };

  /** The lesson with its effective cards. */
  const route = (lesson: MemoryLesson): MemoryLesson => {
    if (lesson.scope === 'group') return { ...lesson, profileIds: [], excludedProfileIds: [] };
    const kinds = (lesson.category && ROUTES[lesson.category]) || [];
    const plus = added.get(lesson.lessonId) ?? new Set<string>();
    const minus = removed.get(lesson.lessonId) ?? new Set<string>();
    const profileIds = PREVIEW_CARDS
      .filter((card) => plus.has(card.profileId) || (kinds.includes(card.kind) && !minus.has(card.profileId)))
      .map((card) => card.profileId);
    return { ...lesson, profileIds, excludedProfileIds: PREVIEW_CARDS.filter((card) => minus.has(card.profileId)).map((card) => card.profileId) };
  };

  return {
    route,
    add(lesson: MemoryLesson, profileId: string) {
      if (lesson.scope === 'group') throw new Error('Group memories stay off cards.');
      if (!PREVIEW_CARDS.some((card) => card.profileId === profileId)) throw new Error('That card no longer exists.');
      setOf(removed, lesson.lessonId).delete(profileId);
      if (!route(lesson).profileIds?.includes(profileId)) setOf(added, lesson.lessonId).add(profileId);
      return route(lesson);
    },
    remove(lesson: MemoryLesson, profileId: string) {
      if (lesson.scope === 'group') throw new Error('Group memories stay off cards.');
      if (!route(lesson).profileIds?.includes(profileId)) throw new Error('This memory is not on that card.');
      setOf(added, lesson.lessonId).delete(profileId);
      if (route(lesson).profileIds?.includes(profileId)) setOf(removed, lesson.lessonId).add(profileId);
      return route(lesson);
    },
  };
}

/** The chats and group the sample memories came from, as this Mac would list them. */
export const PREVIEW_ORIGIN_SOURCES: MemoryOriginSources = {
  sessions: [
    { id: 'conv-launch-copy', title: 'Launch copy with Priya' },
    { id: 'conv-weekly-planning', title: 'Weekly planning' },
    { id: 'session-launch-site', title: 'Image sizes', projectId: 'proj-launch-site', projectName: 'Launch site' },
  ],
  conversations: [
    { id: '4f1c2a9e-7d3b-4e8a-9c61-2b5d8e0f3a17', kind: 'group', legacy_session_id: 'session:group:design-review', shared_title: null, group_title: 'Design review' },
  ],
};
