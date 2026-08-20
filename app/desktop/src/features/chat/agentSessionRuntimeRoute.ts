import type { Agent } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from '@/features/cloud/cloudAgentRuntime';

function text(value?: string | null) {
  return value?.trim() ?? '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function publishedAgentRuntimeRouteMetadata(agent: Agent) {
  if (!text(agent.cloudAgentId)) return {};
  return {
    cloudAgentRuntimeRoute: {
      model: text(agent.defaultModel) || null,
      authProvider: text(agent.defaultAuthProvider) || null,
      authChoice: text(agent.defaultAuthChoice) || null,
      thinking: text(agent.defaultThinking) || null,
    },
  };
}

export function publishedAgentRuntimeRouteFromConversation(
  conversation: unknown,
): DesktopChatMessageRoute | null {
  const route = record(record(record(conversation).metadata).cloudAgentRuntimeRoute);
  const model = text(typeof route.model === 'string' ? route.model : null);
  if (!model) return null;
  const authProvider = text(typeof route.authProvider === 'string' ? route.authProvider : null);
  const authChoice = text(typeof route.authChoice === 'string' ? route.authChoice : null);
  const thinking = text(typeof route.thinking === 'string' ? route.thinking : null);
  return {
    model,
    ...(authProvider ? { authProvider } : {}),
    ...(authChoice ? { authChoice } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function resolvedPublishedAgentRuntimeRoute(
  conversation: unknown,
  fallbackRoute: DesktopChatMessageRoute | null,
) {
  return cloudAgentRuntimeRouteForTargetCloudAgent({
    requestRoute: publishedAgentRuntimeRouteFromConversation(conversation),
    fallbackRoute,
  });
}
