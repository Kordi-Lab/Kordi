const TITLE_CASE_WORD = /^[A-Z][a-z'’-]*$/;

function startsCapitalised(word: string) {
  const first = word.match(/\p{L}/u)?.[0];
  return !first || first === first.toUpperCase();
}

/**
 * Agent thread titles are sentence case. A model-written Title Case title
 * ("Count Lines Across Project Files") is lowered after the first word, while
 * acronyms and words with digits, underscores, or inner capitals stay as written.
 */
export function sentenceCaseAgentThreadTitle(title: string) {
  const words = title.trim().split(/\s+/);
  if (words.length < 2 || !words.every(startsCapitalised)) return title.trim();
  return words
    .map((word, index) => (index > 0 && TITLE_CASE_WORD.test(word) ? word.toLowerCase() : word))
    .join(' ');
}
