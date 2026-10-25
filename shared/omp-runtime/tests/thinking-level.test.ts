import { describe, expect, test } from 'bun:test';
import { ompThinkingLevel } from '../src/thinkingLevel';

describe('ompThinkingLevel', () => {
  test('default and an unset level leave the level to OMP', () => {
    expect(ompThinkingLevel('anthropic', 'claude-sonnet-5-5', 'default')).toBeUndefined();
    expect(ompThinkingLevel('anthropic', 'claude-sonnet-5-5', undefined)).toBeUndefined();
  });

  test('Claude Opus 4.5 caps xhigh and max at high', () => {
    expect(ompThinkingLevel('anthropic', 'claude-opus-4-5', 'xhigh')).toBe('high');
    expect(ompThinkingLevel('anthropic', 'claude-opus-4-5-20251101', 'max')).toBe('high');
    expect(ompThinkingLevel('anthropic', 'anthropic/claude-opus-4-5', 'max')).toBe('high');
    expect(ompThinkingLevel('anthropic', 'claude-opus-4-5', 'medium')).toBe('medium');
  });

  test('other models and providers pass the level through', () => {
    expect(ompThinkingLevel('anthropic', 'claude-opus-4-8', 'max')).toBe('max');
    expect(ompThinkingLevel('anthropic', 'claude-sonnet-5-5', 'off')).toBe('off');
    expect(ompThinkingLevel('openai-codex', 'gpt-6.1-sol', 'xhigh')).toBe('xhigh');
    expect(ompThinkingLevel('openrouter', 'anthropic/claude-opus-4-5', 'max')).toBe('max');
  });
});
