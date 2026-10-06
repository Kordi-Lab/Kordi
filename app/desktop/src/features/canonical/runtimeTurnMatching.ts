import type { Message } from '@/kordi-app/types';
import { messageResponseText, sameAgentResponseText } from './readModel/runtimeMessageMatching';

export function comparableToolSignature(message: Message) {
  const tools = message.turn?.tools ?? [];
  if (tools.length === 0) return null;
  return tools
    .map((tool) => [tool.id ?? '', tool.name ?? '', tool.status ?? ''].join('\u0001'))
    .sort()
    .join('\u0002');
}

export function sameOwnedAgentTurn(canonical: Message, local: Message) {
  if (canonical.role !== 'owned-agent' || local.role !== 'owned-agent') return false;
  const canonicalText = messageResponseText(canonical);
  const localText = messageResponseText(local);
  if (canonicalText && localText && sameAgentResponseText(canonicalText, localText)) return true;
  const canonicalTools = comparableToolSignature(canonical);
  const localTools = comparableToolSignature(local);
  if (canonicalTools && localTools && canonicalTools === localTools) return true;
  const canonicalThinking = canonical.turn?.thinkingText?.trim() ?? '';
  const localThinking = local.turn?.thinkingText?.trim() ?? '';
  if (canonicalThinking && localThinking && sameAgentResponseText(canonicalThinking, localThinking)) return true;
  return false;
}
