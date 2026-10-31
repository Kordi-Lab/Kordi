/**
 * How a reply that ended early stopped: `stopped` by a user, `interrupted` by
 * its executor (lost lease or runtime error). Present only when the reply
 * keeps the text the agent produced before it ended.
 */
export type CloudAgentReplyEnding = 'stopped' | 'interrupted';

export function cloudAgentReplyEnding(value: unknown): CloudAgentReplyEnding | undefined {
  return value === 'stopped' || value === 'interrupted' ? value : undefined;
}
