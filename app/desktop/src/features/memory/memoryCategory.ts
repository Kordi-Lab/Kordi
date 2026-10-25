/** The HCP category of a memory; it decides which Grounding profile the memory is filed to. */
export const MEMORY_CATEGORIES = [
  'general_preferences',
  'goals_and_constraints',
  'health_context',
  'education_learner_profile',
  'work_context',
  'purchase_history_preferences',
  'values_and_ethics',
  'location_context',
  'coordination_context',
  'hcp-custom:task_lessons',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryDeclarationType = 'user-declared' | 'model-inferred';
export type MemoryConfidence = 'low' | 'medium' | 'high';
export type MemoryProfileKind = 'work' | 'health' | 'daily' | 'all' | 'custom';

// Shared with the iPhone app; keep both tables the same.
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  work_context: 'Work',
  education_learner_profile: 'Learning',
  health_context: 'Health',
  coordination_context: 'Schedule',
  location_context: 'Location',
  purchase_history_preferences: 'Shopping',
  general_preferences: 'Preference',
  goals_and_constraints: 'Goal',
  values_and_ethics: 'Values',
  'hcp-custom:task_lessons': 'Task note',
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, value);
}

/** The chip label for a category; null for a missing or unknown one, which shows no chip. */
export function memoryCategoryLabel(category: string | null | undefined): string | null {
  return isMemoryCategory(category) ? CATEGORY_LABELS[category] : null;
}
