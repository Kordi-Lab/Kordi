import type { DesktopChatMessageRoute } from '@/lib/desktop';

import type { CloudAgentDefinition } from './cloudAgents';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeRouteFromDefinition,
  compactCloudAgentRuntimeRoute,
} from './cloudAgentRuntime';
import {
  cleanRuntimeRouteText as cleanText,
  runtimeRouteModelProvider,
  runtimeRouteProvider as routeProvider,
} from './cloudAgentRuntimeRoute';

function routeWithCompatibleAuthForQualifiedModel(
  route: DesktopChatMessageRoute | null,
  localRoutes: readonly (DesktopChatMessageRoute | null)[],
): DesktopChatMessageRoute | null {
  const compactRoute = compactCloudAgentRuntimeRoute(route);
  const modelProvider = runtimeRouteModelProvider(compactRoute);
  const authProvider = routeProvider(compactRoute);
  if (!compactRoute || !modelProvider) return compactRoute;

  const compatibleLocalRoute = localRoutes.find(
    (candidate) => (
      routeProvider(candidate) === modelProvider
      && cleanText(candidate?.authChoice)
    ),
  );
  if (compatibleLocalRoute) {
    return compactCloudAgentRuntimeRoute({
      ...compactRoute,
      authProvider: compatibleLocalRoute.authProvider ?? modelProvider,
      authChoice: compatibleLocalRoute.authChoice,
    });
  }
  if (!authProvider || modelProvider === authProvider) return compactRoute;
  return compactCloudAgentRuntimeRoute({
    ...compactRoute,
    authProvider: modelProvider,
    authChoice: null,
  });
}

export function cloudAgentRuntimeRouteForTargetCloudAgent(input: {
  targetCloudAgentId?: string | null;
  cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition> | null;
  routesByRuntimeSessionId?: Record<string, DesktopChatMessageRoute> | null;
  runtimeSessionId?: string | null;
  fallbackRoute?: DesktopChatMessageRoute | null;
  requestRoute?: DesktopChatMessageRoute | null;
}): DesktopChatMessageRoute | null {
  const requestRoute = compactCloudAgentRuntimeRoute(input.requestRoute);
  const targetCloudAgentId = cleanText(input.targetCloudAgentId);
  const definitionRoute = targetCloudAgentId
    ? cloudAgentRuntimeRouteFromDefinition(input.cloudAgentDefinitionsById?.[targetCloudAgentId])
    : null;
  const sessionRoute = cloudAgentRuntimeRouteForSession(
    input.routesByRuntimeSessionId,
    input.runtimeSessionId,
    null,
  );
  const fallbackRoute = compactCloudAgentRuntimeRoute(input.fallbackRoute);
  const rawHostRoute = sessionRoute ?? definitionRoute ?? fallbackRoute;
  const hostRoute = routeWithCompatibleAuthForQualifiedModel(
    rawHostRoute,
    [fallbackRoute, sessionRoute, definitionRoute],
  );
  if (!requestRoute) return hostRoute;
  const effectiveRequestRoute = routeWithCompatibleAuthForQualifiedModel(
    requestRoute,
    [hostRoute, fallbackRoute, sessionRoute, definitionRoute],
  );
  if (!effectiveRequestRoute) return hostRoute;
  if (!hostRoute) return effectiveRequestRoute;

  const requestProvider = routeProvider(effectiveRequestRoute);
  const hostProvider = routeProvider(hostRoute);
  const providerChanged = Boolean(
    requestProvider
    && hostProvider
    && requestProvider !== hostProvider,
  );
  if (providerChanged && cleanText(hostRoute.authChoice)) {
    return compactCloudAgentRuntimeRoute({
      ...hostRoute,
      thinking: effectiveRequestRoute.thinking ?? hostRoute.thinking,
    });
  }

  return compactCloudAgentRuntimeRoute({
    model: effectiveRequestRoute.model ?? hostRoute.model,
    thinking: effectiveRequestRoute.thinking ?? hostRoute.thinking,
    authProvider: effectiveRequestRoute.authProvider ?? hostRoute.authProvider,
    authChoice: providerChanged
      ? effectiveRequestRoute.authChoice
      : hostRoute.authChoice ?? effectiveRequestRoute.authChoice,
  });
}
