import { ConfigurationError, validateBackendConfiguration } from './backend.mjs';

const fail = (message) => { throw new ConfigurationError(message); };
function object(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has missing or unknown fields.`);
  }
}
function text(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} is outside safe bounds.`);
}
const identifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const binding = /^[A-Z][A-Z0-9_]{2,79}$/;
const asset = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:png|icns)$/;

/** Validate a JSON-only ops profile against an independently selected target. */
export function validateDistributionConfiguration(input, expected) {
  // JSON is the interchange format. Reject accessor-bearing objects before serialization.
  function data(value) {
    if (value && typeof value === 'object') {
      if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('Configuration must be JSON data.');
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('Configuration must be JSON data.');
        data(value[key]);
      }
    } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) fail('Configuration must be JSON data.');
  }
  data(input);
  const value = JSON.parse(JSON.stringify(input));
  object(value, ['schemaVersion', 'routing', 'clients', 'services', 'resources', 'apple'], 'Distribution');
  if (value.schemaVersion !== 1) fail('Unsupported distribution schema version.');
  validateBackendConfiguration(value.routing, expected);
  const c = value.clients;
  object(c, ['displayName', 'callbackScheme', 'desktopIdentifier', 'iosIdentifier', 'iosShareIdentifier', 'appGroup', 'credentialService', 'desktopIcon', 'desktopIcns', 'iosIcon', 'updates'], 'Clients');
  text(c.displayName, /^[A-Za-z][A-Za-z0-9 -]{0,39}$/, 'Display name');
  for (const field of ['desktopIdentifier', 'iosIdentifier', 'iosShareIdentifier', 'appGroup', 'credentialService']) {
    text(c[field], identifier, field);
    if (/(?:^|[.-])beta(?:[.-]|$)/.test(c[field])) fail('Release identity must not reuse Beta storage.');
  }
  if (expected.edition === 'app' && [c.desktopIdentifier, c.iosIdentifier, c.appGroup, c.credentialService].some((v) => v.split(/[.-]/).includes('research'))) fail('App must not reuse Research storage.');
  text(c.callbackScheme, /^[a-z][a-z0-9-]{2,39}$/, 'Callback scheme');
  if (c.callbackScheme === 'kordi-beta') fail('Release callback must not reuse Beta.');
  if (expected.environment === 'staging' && [c.desktopIdentifier, c.iosIdentifier, c.appGroup, c.credentialService, c.callbackScheme].some((v) => !v.split(/[.-]/).includes('staging'))) fail('Staging must have separate identities.');
  if (c.iosShareIdentifier !== `${c.iosIdentifier}.share`) fail('Share extension identity must belong to this app.');
  if (expected.edition === 'research' && [c.desktopIdentifier, c.iosIdentifier, c.appGroup, c.credentialService, c.callbackScheme].some((v) => !v.split(/[.-]/).includes('research'))) {
    fail('Research identities must carry a separate research namespace.');
  }
  for (const field of ['desktopIcon', 'desktopIcns', 'iosIcon']) {
    text(c[field], asset, field);
    if (c[field].split('/').some((part) => part === '..' || part === '.')) fail('Asset paths must stay within ops.');
  }
  object(c.updates, ['enabled', 'publicKey', 'artifactName'], 'Updates');
  if (typeof c.updates.enabled !== 'boolean') fail('Update enablement must be boolean.');
  text(c.updates.artifactName, /^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'Artifact name');
  if (c.updates.enabled) {
    text(c.updates.publicKey, /^[A-Za-z0-9+/]{80,512}={0,2}$/, 'Updater public key');
    const decoded = Buffer.from(c.updates.publicKey, 'base64').toString('utf8');
    if (!/^untrusted comment: [^\r\n]+\n[A-Za-z0-9+/]{56}={0,2}\n?$/.test(decoded)) fail('Updater public key must be a minisign public key.');
  } else if (c.updates.publicKey !== '') fail('Disabled updates must not carry a fallback key.');
  const s = value.services;
  object(s, ['model', 'systemAgent', 'supportAgent', 'runner', 'connectorCallsPerHour'], 'Services');
  object(s.model, ['provider', 'baseURL', 'model'], 'Model policy');
  if (!['openai', 'openai-compatible', 'vertex-ai'].includes(s.model.provider)) fail('Unsupported model provider.');
  text(s.model.model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/, 'Model');
  const modelURL = new URL(s.model.baseURL);
  if (modelURL.protocol !== 'https:' || modelURL.username || modelURL.password || modelURL.search || modelURL.hash) fail('Model endpoint must be HTTPS without credentials.');
  for (const field of ['systemAgent', 'supportAgent']) {
    object(s[field], ['enabled', 'name', 'subtitle', 'ownerEmail', 'persona'], field);
    if (typeof s[field].enabled !== 'boolean') fail('Agent enablement must be boolean.');
    text(s[field].name, /^[A-Za-z][A-Za-z0-9 -]{0,59}$/, 'Agent name');
    text(s[field].subtitle, /^[^\r\n\0]{1,160}$/, 'Agent subtitle');
    text(s[field].ownerEmail, /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Agent owner email');
    text(s[field].persona, /^[^\0]{1,12000}$/, 'Agent persona');
  }
  object(s.runner, ['concurrency', 'pollMilliseconds', 'sandboxBackend'], 'Runner');
  integer(s.runner.concurrency, 1, 4, 'Runner concurrency');
  integer(s.runner.pollMilliseconds, 100, 60000, 'Runner poll interval');
  if (!['k8s', 'fly'].includes(s.runner.sandboxBackend)) fail('Release sandbox must be isolated.');
  integer(s.connectorCallsPerHour, 1, 100000, 'Connector budget');
  const res = value.resources;
  object(res, ['provider', 'cpuLimit', 'memoryMiB', 'sandboxCpuMillis', 'sandboxMemoryMiB', 'bindings'], 'Resources');
  if (!['gcp', 'external'].includes(res.provider) || (expected.edition === 'research' && res.provider !== 'gcp')) fail('Invalid hosting provider.');
  integer(res.cpuLimit, 1, 64, 'CPU limit');
  integer(res.memoryMiB, 256, 262144, 'Memory limit');
  integer(res.sandboxCpuMillis, 100, 16000, 'Sandbox CPU limit');
  integer(res.sandboxMemoryMiB, 128, 32768, 'Sandbox memory limit');
  object(res.bindings, ['project', 'region', 'zone', 'instance', 'database', 'objectStorage', 'serviceIdentity'], 'Resource bindings');
  for (const name of Object.values(res.bindings)) text(name, binding, 'Resource binding name');
  object(value.apple, ['teamBinding', 'identityBinding', 'notaryProfileBinding', 'exportMethod'], 'Apple packaging');
  for (const field of ['teamBinding', 'identityBinding', 'notaryProfileBinding']) text(value.apple[field], binding, 'Signing binding name');
  if (!['app-store-connect', 'release-testing', 'debugging'].includes(value.apple.exportMethod)) fail('Invalid Apple export method.');
  return value;
}

/** Only this subset may be compiled into a client. No service/resource/signing fields. */
export function publicClientConfiguration(profile) {
  return {
    edition: profile.routing.edition,
    environment: profile.routing.environment,
    backendOrigin: profile.routing.backend.origin,
    displayName: profile.clients.displayName,
    callbackScheme: profile.clients.callbackScheme,
    desktopIdentifier: profile.clients.desktopIdentifier,
    iosIdentifier: profile.clients.iosIdentifier,
    iosShareIdentifier: profile.clients.iosShareIdentifier,
    appGroup: profile.clients.appGroup,
    credentialService: profile.clients.credentialService,
    updates: profile.clients.updates,
  };
}

/** Desktop bundles do not need iOS app-group or credential-service identifiers. */
export function publicDesktopConfiguration(profile) {
  const client = publicClientConfiguration(profile);
  return {
    backendOrigin: client.backendOrigin,
    callbackScheme: client.callbackScheme,
    updates: { enabled: client.updates.enabled, artifactName: client.updates.artifactName },
  };
}
