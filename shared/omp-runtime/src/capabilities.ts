import { Settings, type CreateAgentSessionOptions } from '@oh-my-pi/pi-coding-agent';

export type RuntimeCapabilities = {
  /** This run is executing on the authenticated owner's Mac. */
  ownerLocal: boolean;
  /** Owner-authorized access to OMP's native computer Eval prelude. */
  computer: boolean;
  /** Owner-authorized access to OMP's native browser Eval prelude. */
  browser: boolean;
};

/**
 * Build isolated OMP settings for one run. Browser defaults to enabled upstream,
 * so both capabilities must be explicitly disabled outside an owner-local run.
 */
export function createOmpRuntimeSettings(capabilities: RuntimeCapabilities): Settings {
  return Settings.isolated({
    'computer.enabled': capabilities.ownerLocal && capabilities.computer,
    'browser.enabled': capabilities.ownerLocal && capabilities.browser,
    'goal.enabled': false,
    'task.maxRecursionDepth': 0,
    'task.isolation.enabled': false,
  });
}

/**
 * Discovery and Eval policy shared by the desktop and Cloud OMP adapters.
 * A restricted/shared run receives only its explicit host tools. OMP refuses
 * to install computer/browser preludes in a restricted session, even when the
 * upstream setting is enabled. The owner-local path may activate Eval only
 * when a named computer or browser capability was admitted by Kordi.
 */
export function ompCapabilityOptions(
  capabilities: RuntimeCapabilities,
  hostToolNames: readonly string[] = [],
): Pick<CreateAgentSessionOptions,
  | 'settings' | 'toolNames' | 'restrictToolNames' | 'allowRestrictedCustomTools'
  | 'disableExtensionDiscovery' | 'enableMCP' | 'enableLsp'
  | 'skills' | 'rules' | 'contextFiles' | 'promptTemplates' | 'slashCommands'
> {
  const allowEval = capabilities.ownerLocal && (capabilities.computer || capabilities.browser);
  return {
    settings: createOmpRuntimeSettings(capabilities),
    toolNames: allowEval ? [...hostToolNames, 'eval'] : [...hostToolNames],
    restrictToolNames: !allowEval,
    allowRestrictedCustomTools: !allowEval,
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  };
}
