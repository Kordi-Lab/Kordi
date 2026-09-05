import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { canonicalCloudProviderId } from './providerAuthSnapshot';

const AGENT_MODEL_CHANGE_PREFIX = 'Switched model to ';
const AGENT_RUNTIME_ROUTE_NOTICE_PREFIX = 'Model: ';
const AGENT_RUNTIME_ROUTE_NOTICE_SEPARATOR = ' · Thinking effort: ';

export function cleanRuntimeRouteText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function runtimeRouteProvider(
  route?: DesktopChatMessageRoute | null,
): string | null {
  const explicit = cleanRuntimeRouteText(route?.authProvider);
  if (explicit) return canonicalCloudProviderId(explicit);
  const model = cleanRuntimeRouteText(route?.model);
  const separatorIndex = model?.indexOf('/') ?? -1;
  return model && separatorIndex > 0
    ? canonicalCloudProviderId(model.slice(0, separatorIndex))
    : null;
}

export function qualifiedRouteModel(
  route?: DesktopChatMessageRoute | null,
): string | null {
  const model = cleanRuntimeRouteText(route?.model);
  const provider = runtimeRouteProvider(route);
  if (!model) return null;
  return provider && !model.includes('/') ? `${provider}/${model}` : model;
}

export function agentThinkingEffortLabel(thinking?: string | null): string {
  const value = cleanRuntimeRouteText(thinking) ?? 'default';
  const normalized = value.toLowerCase().replace(/[\s_-]/g, '');
  switch (normalized) {
    case 'off': return 'Off';
    case 'default':
    case 'auto':
    case 'thinking': return 'Default';
    case 'minimal': return 'Minimal';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh':
    case 'extrahigh': return 'Extra High';
    case 'max':
    case 'maximum': return 'Max';
    default: return value;
  }
}

export function agentRuntimeRouteChangeNotice(
  next: DesktopChatMessageRoute,
  _previous?: DesktopChatMessageRoute | null,
): string {
  const model = qualifiedRouteModel(next);
  if (!model) throw new Error('A session runtime route change requires a model.');
  return `${AGENT_RUNTIME_ROUTE_NOTICE_PREFIX}${model}`
    + `${AGENT_RUNTIME_ROUTE_NOTICE_SEPARATOR}${agentThinkingEffortLabel(next.thinking)}`;
}

export function runtimeRoutesMatch(
  left?: DesktopChatMessageRoute | null,
  right?: DesktopChatMessageRoute | null,
): boolean {
  const modelId = (route?: DesktopChatMessageRoute | null) => {
    const model = qualifiedRouteModel(route);
    return model?.slice(model.indexOf('/') + 1) ?? null;
  };
  return modelId(left) === modelId(right)
    && runtimeRouteProvider(left) === runtimeRouteProvider(right)
    && cleanRuntimeRouteText(left?.authChoice) === cleanRuntimeRouteText(right?.authChoice)
    && agentThinkingEffortLabel(left?.thinking) === agentThinkingEffortLabel(right?.thinking);
}

export function modelFromAgentModelChangeNotice(
  text?: string | null,
): string | null {
  const normalized = cleanRuntimeRouteText(text);
  if (!normalized) return null;
  if (normalized.startsWith(AGENT_MODEL_CHANGE_PREFIX)) {
    return cleanRuntimeRouteText(
      normalized.slice(AGENT_MODEL_CHANGE_PREFIX.length),
    );
  }
  if (!normalized.startsWith(AGENT_RUNTIME_ROUTE_NOTICE_PREFIX)) return null;
  const routeSummary = normalized.slice(
    AGENT_RUNTIME_ROUTE_NOTICE_PREFIX.length,
  );
  const separatorIndex = routeSummary.indexOf(
    AGENT_RUNTIME_ROUTE_NOTICE_SEPARATOR,
  );
  return cleanRuntimeRouteText(
    separatorIndex >= 0 ? routeSummary.slice(0, separatorIndex) : routeSummary,
  );
}
