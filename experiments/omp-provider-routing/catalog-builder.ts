import path from 'node:path';
import { getBundledModels, getSupportedEfforts, type GeneratedProvider } from '@oh-my-pi/pi-catalog';
import { bundledProviderCatalog } from './live-server';
import type { ProviderLoginPolicy } from './login-policy';

export type OmpCatalogProvider = {
  id: string;
  name: string;
  defaultModel: string | null;
  /** Base URL a claimed credential for this row is used against, or `null` when OMP has no literal https URL. */
  baseUrl: string | null;
  /** OMP transport `api` kind (such as `openai-completions`), or `null`. */
  api: string | null;
  auth: {
    kind: string;
    name: string;
    acceptsApiKey: boolean;
    instructions: string | null;
    authUrl: string | null;
    placeholder: string | null;
    envVars: string[];
  };
  /** OMP login policy; see login-policy.ts for field meanings. */
  login: ProviderLoginPolicy;
  models: string[];
  /** Thinking profile id (a `thinkingProfiles` key) by model id; models without a controllable effort are absent. */
  modelThinking: Record<string, string>;
};

export type OmpThinkingProfile = {
  /** Supported efforts, least to most intensive. Never empty. */
  efforts: string[];
  defaultLevel?: string;
};

export type OmpCatalogOutput = {
  source: '@oh-my-pi/pi-catalog';
  version: string;
  generatedBy: 'experiments/omp-provider-routing/export-catalog.ts';
  /** Distinct thinking settings shared by models, ids assigned by first appearance. */
  thinkingProfiles: Record<string, OmpThinkingProfile>;
  providers: OmpCatalogProvider[];
};

const LATIN_SCRIPT_CHAR = /\p{Script=Latin}/u;
const LETTER_CHAR = /\p{L}/u;

/**
 * A "segment" (parenthetical content, or a trailing space-delimited token) counts as
 * non-Latin script when it contains at least one letter and no Latin-script letters —
 * e.g. a segment written only in CJK characters qualifies, with or without a
 * hyphenated ASCII suffix, but "beta" and "Café" do not.
 */
function isNonLatinSegment(text: string): boolean {
  let hasNonLatinLetter = false;
  for (const ch of text) {
    if (LATIN_SCRIPT_CHAR.test(ch)) return false;
    if (LETTER_CHAR.test(ch)) hasNonLatinLetter = true;
  }
  return hasNonLatinLetter;
}

/**
 * Removes parenthetical and trailing segments made of non-Latin script from a display
 * string, e.g. an English name followed by a CJK segment in parentheses keeps
 * only the English name. This keeps the
 * repository's English-only check (scripts/check-english-only-diff.sh) passing on the
 * checked-in catalog snapshot without altering provider ids, models, or auth mechanics.
 */
function stripNonLatinSegments(value: string): string {
  // Drop "(...)" groups (plus any leading whitespace before them) whose content is
  // entirely non-Latin script.
  let result = value.replace(/\s*\(([^()]*)\)/gu, (match, inner: string) =>
    (isNonLatinSegment(inner) ? '' : match));

  // Drop a single trailing non-space run (plus its leading whitespace) that is
  // entirely non-Latin script, e.g. a name ending in a CJK segment with no parentheses.
  result = result.replace(/\s*([^\s()]+)$/u, (match, trailing: string) =>
    (isNonLatinSegment(trailing) ? '' : match));

  return result.trim();
}

/** Sanitizes a required display string, falling back to `fallbackId` if stripping empties it. */
function sanitizeRequiredText(value: string, fallbackId: string): string {
  const stripped = stripNonLatinSegments(value);
  return stripped.length > 0 ? stripped : fallbackId;
}

/** Sanitizes an optional display string; `null` stays `null`, otherwise falls back to `fallbackId`. */
function sanitizeOptionalText(value: string | null, fallbackId: string): string | null {
  if (value === null) return null;
  const stripped = stripNonLatinSegments(value);
  return stripped.length > 0 ? stripped : fallbackId;
}

/**
 * Applies the display-text sanitisation to the login policy. Only `name`, `instructions`,
 * `prompt`, and `placeholder` carry display text; every other field passes through.
 */
function sanitizeLoginPolicy(login: ProviderLoginPolicy, fallbackId: string): ProviderLoginPolicy {
  return {
    kind: login.kind,
    name: sanitizeRequiredText(login.name, fallbackId),
    instructions: sanitizeOptionalText(login.instructions, fallbackId),
    prompt: sanitizeOptionalText(login.prompt, fallbackId),
    placeholder: sanitizeOptionalText(login.placeholder, fallbackId),
    authUrl: login.authUrl,
    validates: login.validates,
    pasteKey: login.pasteKey,
    manualOnly: login.manualOnly,
    callbackPort: login.callbackPort,
    callbackPath: login.callbackPath,
    hook: login.hook,
    apiKeyFormat: login.apiKeyFormat,
    envVars: [...login.envVars],
    storeCredentialsAs: login.storeCredentialsAs,
    acceptsApiKeyMethod: login.acceptsApiKeyMethod,
  };
}

/** Thinking settings for each listed model that has a controllable effort, from the bundled model metadata. */
function modelThinkingFor(providerId: string, models: string[]): Record<string, OmpThinkingProfile> {
  const listed = new Set(models);
  const result: Record<string, OmpThinkingProfile> = {};
  for (const model of getBundledModels(providerId as GeneratedProvider)) {
    if (!listed.has(model.id)) continue;
    const efforts = getSupportedEfforts(model);
    if (efforts.length === 0) continue;
    const defaultLevel = model.thinking?.defaultLevel;
    result[model.id] = defaultLevel ? { efforts: [...efforts], defaultLevel } : { efforts: [...efforts] };
  }
  return result;
}

/**
 * Replaces each provider's per-model thinking settings with ids into one shared
 * profile table. Ids follow first appearance in provider, then model, order, so
 * regeneration is stable.
 */
function withThinkingProfiles(rows: Array<Omit<OmpCatalogProvider, 'modelThinking'> & { thinking: Record<string, OmpThinkingProfile> }>) {
  const thinkingProfiles: Record<string, OmpThinkingProfile> = {};
  const idsByKey = new Map<string, string>();
  const providers: OmpCatalogProvider[] = rows.map(({ thinking, ...row }) => {
    const modelThinking: Record<string, string> = {};
    for (const [modelId, profile] of Object.entries(thinking)) {
      const key = JSON.stringify(profile);
      let id = idsByKey.get(key);
      if (!id) {
        id = `p${idsByKey.size + 1}`;
        idsByKey.set(key, id);
        thinkingProfiles[id] = profile;
      }
      modelThinking[modelId] = id;
    }
    return { ...row, modelThinking };
  });
  return { thinkingProfiles, providers };
}

/** Reads the pinned `@oh-my-pi/pi-catalog` version from this package's installed node_modules. */
export async function pinnedCatalogVersion(): Promise<string> {
  const pinnedCatalogPackageJsonPath = path.join(import.meta.dir, 'node_modules/@oh-my-pi/pi-catalog/package.json');
  const pinnedCatalogPackageJson = await Bun.file(pinnedCatalogPackageJsonPath).json() as { version: string };
  return pinnedCatalogPackageJson.version;
}

/**
 * Builds the pinned OMP provider catalog snapshot in memory, in the exact shape and
 * ordering that export-catalog.ts writes to shared/omp-catalog/omp-provider-catalog.json:
 * providers sorted by id, models kept in the order bundledProviderCatalog() returns them.
 */
export async function buildCatalogOutput(): Promise<OmpCatalogOutput> {
  const version = await pinnedCatalogVersion();

  const rows = bundledProviderCatalog()
    .map((provider) => {
      const name = sanitizeRequiredText(provider.auth.name, provider.id);
      return {
        id: provider.id,
        name,
        defaultModel: provider.defaultModel,
        baseUrl: provider.baseUrl,
        api: provider.api,
        auth: {
          kind: provider.auth.kind,
          name,
          acceptsApiKey: provider.auth.acceptsApiKey,
          instructions: sanitizeOptionalText(provider.auth.instructions, provider.id),
          authUrl: provider.auth.authUrl,
          placeholder: sanitizeOptionalText(provider.auth.placeholder, provider.id),
          envVars: provider.auth.envVars,
        },
        login: sanitizeLoginPolicy(provider.login, provider.id),
        models: provider.models,
        thinking: modelThinkingFor(provider.id, provider.models),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const { thinkingProfiles, providers } = withThinkingProfiles(rows);

  return {
    source: '@oh-my-pi/pi-catalog',
    version,
    generatedBy: 'experiments/omp-provider-routing/export-catalog.ts',
    thinkingProfiles,
    providers,
  };
}
