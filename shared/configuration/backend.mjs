/** Backend routing contract. No production assignments or environment lookups live here. */
export const CONFIGURATION_SCHEMA_VERSION = 1;
const EDITIONS = new Set(['app', 'research']);
const ENVIRONMENTS = new Set(['staging', 'production']);

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function fail(message) {
  throw new ConfigurationError(message);
}

function objectWithKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${label} must be an object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) {
    fail(`${label} has missing or unknown fields.`);
  }
  if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail(`${label} must contain data fields.`);
  }
}

function origin(value, label) {
  if (typeof value !== 'string' || value.length > 2048
    || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(value)) {
    fail(`${label} must be a canonical HTTPS DNS origin.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a canonical HTTPS DNS origin.`);
  }
  const labels = url.hostname.split('.');
  if (url.origin !== value || labels.length < 2
    || !/[a-z]/.test(labels.at(-1))
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || ['localhost', 'local', 'internal'].includes(labels.at(-1))) {
    fail(`${label} must be a canonical HTTPS DNS origin.`);
  }
  return value;
}

function target(value) {
  objectWithKeys(value, ['edition', 'environment', 'backendOrigin'], 'Expected target');
  if (!EDITIONS.has(value.edition) || !ENVIRONMENTS.has(value.environment)) {
    fail('Expected target has an unsupported edition or environment.');
  }
  origin(value.backendOrigin, 'Expected backend origin');
}

/**
 * @param {unknown} value
 * @param {import('./backend.mjs').ExpectedTarget} expected
 * @returns {import('./backend.mjs').BackendConfiguration}
 */
export function validateBackendConfiguration(value, expected) {
  target(expected);
  objectWithKeys(value, ['schemaVersion', 'edition', 'environment', 'backend'], 'Configuration');
  if (value.schemaVersion !== CONFIGURATION_SCHEMA_VERSION) {
    fail('Unsupported configuration schema version.');
  }
  if (!EDITIONS.has(value.edition) || !ENVIRONMENTS.has(value.environment)) {
    fail('Configuration has an unsupported edition or environment.');
  }
  objectWithKeys(value.backend, ['origin'], 'Backend configuration');
  origin(value.backend.origin, 'Backend origin');
  if (value.edition !== expected.edition || value.environment !== expected.environment
    || value.backend.origin !== expected.backendOrigin) {
    fail('Configuration does not match the expected deployment target.');
  }
  return Object.freeze({
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    edition: value.edition,
    environment: value.environment,
    backend: Object.freeze({ origin: value.backend.origin }),
  });
}

export function parseBackendConfiguration(text, expected) {
  if (typeof text !== 'string' || text.length > 16_384) {
    fail('Configuration must be JSON text of at most 16384 characters.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('Configuration is not valid JSON.');
  }
  return validateBackendConfiguration(value, expected);
}

/** An explicit allowlist for existing consumers; never forward arbitrary input fields. */
export function legacyBackendEnvironment(value, expected) {
  const config = validateBackendConfiguration(value, expected);
  return Object.freeze({
    VITE_KORDI_CLOUD_API_BASE: config.backend.origin,
    KORDI_CLOUD_API_BASE: config.backend.origin,
  });
}
