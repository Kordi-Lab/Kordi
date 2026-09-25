import { canonicalCloudProviderId } from '@/features/cloud/providerAuthSnapshot';
import type { CloudProviderAuthSnapshot } from '@/features/cloud/cloudAgentRuntimeTypes';
import type { OmpLoginKind, OmpLoginSpec } from '@/features/cloud/providerLogin';
import type { DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';
import { buildAuthDisplayProviders, isLocalProvider, kordiSignInProviderIds } from './model';
import type { AuthDisplayMethod, AuthDisplayProvider, AuthHostedLogin, OmpProviderAuth } from './model';

export type OmpCatalogEntry = {
  id: string;
  name?: string | null;
  models: string[];
  defaultModel?: string | null;
  auth?: OmpProviderAuth;
  login?: OmpLoginSpec | null;
};

export type OmpCatalog = {
  version: string | null;
  providers: OmpCatalogEntry[];
};

const authKinds = new Set<OmpProviderAuth['kind']>(['api-key', 'oauth-code', 'device-code', 'custom', 'native']);

function ompAuthKind(kind: string): OmpProviderAuth['kind'] {
  return authKinds.has(kind as OmpProviderAuth['kind']) ? kind as OmpProviderAuth['kind'] : 'custom';
}

const loginKinds = new Set<OmpLoginKind>(['api-key', 'oauth-code', 'device-code', 'custom', 'env-only']);

function ompLoginKind(kind: string): OmpLoginKind {
  return loginKinds.has(kind as OmpLoginKind) ? kind as OmpLoginKind : 'custom';
}

type PinnedCatalogPayload = typeof import('../../../../../shared/omp-catalog/omp-provider-catalog.json');

function pinnedCatalogFrom(payload: PinnedCatalogPayload): OmpCatalog {
  return {
    version: payload.version,
    providers: payload.providers.map((entry) => ({
      id: entry.id,
      name: entry.name,
      models: entry.models,
      defaultModel: entry.defaultModel,
      auth: { ...entry.auth, kind: ompAuthKind(entry.auth.kind) },
      login: entry.login ? { ...entry.login, kind: ompLoginKind(entry.login.kind) } : null,
    })),
  };
}

let pinnedCatalog: OmpCatalog | null = null;
let pinnedCatalogPromise: Promise<OmpCatalog> | null = null;

/**
 * The OMP provider catalog bundled with the app, loaded once as its own chunk
 * so it stays out of the startup bundle. The hosted catalog only refreshes it.
 */
export function loadPinnedOmpCatalog(): Promise<OmpCatalog> {
  pinnedCatalogPromise ??= import('../../../../../shared/omp-catalog/omp-provider-catalog.json')
    .then((module) => {
      pinnedCatalog = pinnedCatalogFrom(module.default);
      return pinnedCatalog;
    })
    .catch((caught: unknown) => {
      pinnedCatalogPromise = null;
      throw caught;
    });
  return pinnedCatalogPromise;
}

/** The pinned catalog when it has already loaded, so later visits render at once. */
export function loadedPinnedOmpCatalog(): OmpCatalog | null {
  return pinnedCatalog;
}

/** Replaces the catalog with the hosted one when it loads; any failure keeps the current catalog. */
export async function refreshOmpCatalog(
  current: OmpCatalog,
  load: (() => Promise<{ providers: OmpCatalogEntry[]; version?: string | null }>) | null,
): Promise<OmpCatalog> {
  if (!load) return current;
  try {
    const result = await load();
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    if (!providers.some((entry) => entry.models?.length > 0)) return current;
    // Older servers omit login steps; keep the pinned ones for those providers.
    const pinnedLogins = new Map(current.providers.map((entry) => [entry.id, entry.login]));
    return {
      version: result.version ?? null,
      providers: providers.map((entry) => (entry.login ? entry : { ...entry, login: pinnedLogins.get(entry.id) ?? null })),
    };
  } catch {
    return current;
  }
}

// Kordi aliases for the same OMP provider. The OMP id always stays the display id.
const localProviderAliases: Record<string, string> = {
  codex: 'openai-codex',
  'openai-codex-device': 'openai-codex',
  'google-gemini': 'google',
};

export function ompProviderIdFor(providerId: string, ompIds: ReadonlySet<string>): string | null {
  const id = providerId.trim().toLowerCase();
  if (ompIds.has(id)) return id;
  const alias = localProviderAliases[id];
  if (alias && ompIds.has(alias)) return alias;
  const family = canonicalCloudProviderId(id);
  return family && ompIds.has(family) ? family : null;
}

/** OMP lists some key-capable providers as sign-in only; a *_API_KEY variable still means a key works. */
export function ompAcceptsApiKey(auth?: OmpProviderAuth) {
  if (!auth) return true;
  return auth.acceptsApiKey || auth.envVars.some((name) => name.endsWith('_API_KEY'));
}

export function ompProviderName(id: string, entry?: OmpCatalogEntry) {
  if (id === 'custom') return 'Custom API';
  return entry?.auth?.name?.trim() || id;
}

function preferredCatalogModel(providerId: string, preferredModel: string | null | undefined, entry: OmpCatalogEntry) {
  const [modelProvider, ...modelParts] = preferredModel?.split('/') ?? [];
  const modelId = modelProvider === providerId || (providerId === 'openai-codex' && modelProvider === 'openai')
    ? modelParts.join('/') : '';
  if (modelId && entry.models.includes(modelId)) return `${providerId}/${modelId}`;
  const fallback = entry.defaultModel && entry.models.includes(entry.defaultModel)
    ? entry.defaultModel : entry.models[0];
  return fallback ? `${providerId}/${fallback}` : null;
}

function ompProvider(entry: OmpCatalogEntry, locals: DesktopAuthProvider[]): DesktopAuthProvider {
  const label = ompProviderName(entry.id, entry);
  const options = locals.flatMap((local) => local.options);
  const kind = entry.auth?.kind;
  return {
    id: entry.id,
    label,
    statusSummary: options.length > 0
      ? locals.find((local) => local.options.length > 0)?.statusSummary ?? 'Saved accounts'
      : 'No saved accounts',
    loginHint: `Connect ${label} to use its OMP models.`,
    envVar: entry.auth?.envVars[0] ?? '',
    helpUrl: entry.auth?.authUrl ?? '',
    supportsOAuth: kordiSignInProviderIds.has(entry.id) || kind === 'oauth-code' || kind === 'device-code',
    supportsApiKey: ompAcceptsApiKey(entry.auth),
    configured: locals.some((local) => local.configured) || options.length > 0,
    authority: locals.find((local) => local.authority)?.authority ?? null,
    preferredModel: preferredCatalogModel(entry.id, locals.find((local) => local.preferredModel)?.preferredModel, entry),
    options,
  };
}

function snapshotTarget(snapshot: CloudProviderAuthSnapshot, providerIds: ReadonlySet<string>) {
  if (canonicalCloudProviderId(snapshot.provider) === 'openai' && snapshot.authChoice.includes('codex')
    && providerIds.has('openai-codex')) {
    return 'openai-codex';
  }
  return ompProviderIdFor(snapshot.provider, providerIds);
}

/** OMP defines every provider; Kordi contributes saved accounts, local model servers, and sign-in adapters. */
export function mergeOmpAuthState(
  authState: DesktopAuthState | null,
  snapshots: CloudProviderAuthSnapshot[],
  catalog: OmpCatalogEntry[],
): DesktopAuthState | null {
  if (!authState) return null;
  const entries = [...catalog.filter((entry) => entry.models.length > 0 && entry.id !== 'custom'), { id: 'custom', models: [] }];
  const ompIds = new Set(entries.map((entry) => entry.id));
  const localsByOmpId = new Map<string, DesktopAuthProvider[]>();
  const unmatched: DesktopAuthProvider[] = [];
  for (const local of authState.providers) {
    const target = ompProviderIdFor(local.id, ompIds);
    if (target) localsByOmpId.set(target, [...(localsByOmpId.get(target) ?? []), local]);
    else unmatched.push(local);
  }

  const providers = new Map(entries.map((entry) => [entry.id, ompProvider(entry, localsByOmpId.get(entry.id) ?? [])]));
  for (const local of unmatched) {
    if (local.configured || local.options.length > 0 || isLocalProvider(local.id)) {
      providers.set(local.id, { ...local, options: [...local.options] });
    }
  }
  const savedChoices = new Set([...providers.values()].flatMap((provider) => provider.options.map((option) => option.value)));
  for (const snapshot of snapshots) {
    if (savedChoices.has(snapshot.authChoice)) continue;
    const targetId = snapshotTarget(snapshot, new Set(providers.keys())) ?? snapshot.provider;
    const provider = providers.get(targetId) ?? ompProvider({ id: targetId, models: [] }, []);
    providers.set(targetId, provider);
    const hasCloudOption = provider.options.some((option) => option.source === 'Cloud');
    provider.options.push({
      value: snapshot.authChoice,
      profileId: snapshot.snapshotId,
      method: /codex|oauth|device/i.test(snapshot.authChoice) ? 'OAuth' : 'API key',
      source: 'Cloud',
      label: snapshot.label || 'Saved account',
      modelHint: snapshot.modelHint,
      active: false,
    });
    savedChoices.add(snapshot.authChoice);
    provider.configured = true;
    const entry = entries.find((item) => item.id === targetId);
    if (snapshot.modelHint && !hasCloudOption && entry?.models.includes(snapshot.modelHint)) {
      provider.preferredModel = `${targetId}/${snapshot.modelHint}`;
    }
  }
  return { ...authState, providers: [...providers.values()], hasAnyAuth: authState.hasAnyAuth || snapshots.length > 0 };
}

const signInKinds = new Set<OmpLoginKind>(['oauth-code', 'device-code', 'custom']);
/** Hooks whose OMP flow shows a one-time device code. */
const deviceHooks = new Set(['openai-codex-device', 'github-copilot']);

/** OMP also takes a key: the catalog flag, or its rule (paste key or a *_API_KEY variable). */
export function loginAcceptsApiKey(login: OmpLoginSpec) {
  return login.kind === 'api-key' || login.kind === 'env-only'
    || (login.acceptsApiKeyMethod ?? (login.pasteKey || login.envVars.some((name) => name.endsWith('_API_KEY'))));
}

/** Add-account methods OMP offers for one provider, in display order. */
export function ompLoginMethods(login: OmpLoginSpec): Array<'sign-in' | 'api-key'> {
  const methods: Array<'sign-in' | 'api-key'> = [];
  if (signInKinds.has(login.kind)) methods.push('sign-in');
  if (loginAcceptsApiKey(login)) methods.push('api-key');
  return methods;
}

function apiKeyLogin(login: OmpLoginSpec | null | undefined, name: string, envVars: string[]): OmpLoginSpec {
  if (login && (login.kind === 'api-key' || login.kind === 'env-only')) return login;
  return {
    kind: 'api-key', name, instructions: null, prompt: null, placeholder: null, authUrl: null,
    validates: false, pasteKey: false, manualOnly: false, callbackPort: null, hook: null,
    apiKeyFormat: login?.apiKeyFormat ?? 'bearer', envVars: login?.envVars ?? envVars, storeCredentialsAs: null,
  };
}

function hostedLoginsFor(method: AuthDisplayMethod, catalogById: Map<string, OmpCatalogEntry>): AuthHostedLogin[] {
  const entry = catalogById.get(method.providerId);
  if (!entry || method.providerId === 'custom') return [];
  const name = ompProviderName(entry.id, entry);
  if (method.mode === 'api-key') {
    return [{ providerId: entry.id, method: 'api-key', login: apiKeyLogin(entry.login, name, entry.auth?.envVars ?? []), displayName: name }];
  }
  const logins: AuthHostedLogin[] = [];
  if (entry.login && signInKinds.has(entry.login.kind)) logins.push({ providerId: entry.id, login: entry.login, displayName: name });
  // ChatGPT also signs in with a device code through OMP's openai-codex-device hook.
  const device = method.providerId === 'openai-codex' ? catalogById.get('openai-codex-device')?.login : null;
  if (device) logins.push({ providerId: 'openai-codex-device', mode: 'device', login: device, displayName: 'ChatGPT' });
  return logins;
}

// Catalog-only providers get one method per way OMP can add an account:
// its sign-in flow, and an API key when OMP accepts one.
function catalogMethods(item: AuthDisplayProvider, entry: OmpCatalogEntry | undefined): AuthDisplayMethod[] {
  const login = entry?.login;
  if (!entry || !login || item.id === 'custom') return item.methods;
  const options = item.methods.flatMap((method) => method.options);
  const name = ompProviderName(entry.id, entry);
  const base = { providerId: item.id, helpUrl: login.authUrl ?? '', envVar: login.envVars[0] ?? '' };
  const methods: AuthDisplayMethod[] = [];
  if (signInKinds.has(login.kind)) {
    methods.push({
      ...base,
      mode: 'oauth',
      title: login.kind === 'device-code' ? 'Device sign-in' : login.kind === 'custom' && !deviceHooks.has(login.hook ?? '') ? 'Connect account' : 'Sign in',
      detail: login.kind === 'device-code' || deviceHooks.has(login.hook ?? '')
        ? `Sign in on ${name}'s page with a one-time code.`
        : login.kind === 'oauth-code' ? `Sign in with your ${name} account in the browser.` : `Connect ${name} with the details OMP asks for.`,
      options: options.filter((option) => option.method === 'OAuth'),
    });
  }
  if (ompLoginMethods(login).includes('api-key')) {
    methods.push({
      ...base,
      mode: 'api-key',
      title: 'API key',
      detail: `Paste a ${name} API key. OMP checks it and stores it in your Kordi account.`,
      options: options.filter((option) => option.method !== 'OAuth'),
    });
  }
  return methods;
}

/** Stands in for this Mac's accounts when they have not loaded, so the catalog still lists every provider. */
const noLocalAccounts: DesktopAuthState = { authPath: '', hasAnyAuth: false, providers: [] };

/**
 * Display providers for the auth page, each carrying its OMP models and
 * sign-in policy. Without this Mac's accounts the list comes from the catalog
 * and hosted accounts alone.
 */
export function buildOmpDisplayProviders(
  authState: DesktopAuthState | null,
  snapshots: CloudProviderAuthSnapshot[],
  catalog: OmpCatalogEntry[],
): { authState: DesktopAuthState | null; providers: AuthDisplayProvider[] } {
  const merged = mergeOmpAuthState(authState ?? noLocalAccounts, snapshots, catalog);
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const providers = buildAuthDisplayProviders(merged).map((item) => {
    const entry = catalogById.get(item.id);
    const methods = item.catalogOnly ? catalogMethods(item, entry) : item.methods;
    return {
      ...item,
      methods: methods.map((method) => {
        const methodEntry = catalogById.get(method.providerId);
        const hostedLogins = hostedLoginsFor(method, catalogById);
        return {
          ...method,
          modelIds: methodEntry?.models ?? [],
          defaultModelId: methodEntry?.defaultModel,
          providerName: methodEntry ? ompProviderName(methodEntry.id, methodEntry) : item.label,
          hostedLogins,
          hostedLogin: hostedLogins[0] ?? null,
        };
      }),
      modelCount: entry?.models.length,
      modelIds: entry?.models ?? [],
      defaultModelId: entry?.defaultModel,
      ompAuth: entry?.auth ? { ...entry.auth, acceptsApiKey: ompAcceptsApiKey(entry.auth) } : undefined,
    };
  });
  return { authState: merged, providers };
}
