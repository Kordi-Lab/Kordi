import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './backend.mjs';
import { validateDistributionConfiguration, publicClientConfiguration } from './distribution.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function loadDistributionConfiguration(file, expected) {
  try {
    const source = realpathSync(file);
    if (statSync(source).size > 65536) throw new Error();
    const profile = validateDistributionConfiguration(JSON.parse(readFileSync(source, 'utf8')), expected);
    const root = path.dirname(source);
    const assets = {};
    for (const field of ['desktopIcon', 'desktopIcns', 'iosIcon']) {
      const asset = realpathSync(path.resolve(root, profile.clients[field]));
      if (!asset.startsWith(`${root}${path.sep}`) || statSync(asset).size > 16 * 1024 * 1024) throw new Error();
      const bytes = readFileSync(asset);
      if (field === 'desktopIcns' ? bytes.subarray(0, 4).toString() !== 'icns' : bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error();
      assets[field] = bytes;
    }
    return { profile, assets };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('Unable to read a valid distribution profile and its contained icon assets.');
  }
}

export function distributionFromEnvironment(env = process.env, { required = true } = {}) {
  if (!env.KORDI_DISTRIBUTION_PROFILE && !required) return null;
  if (!env.KORDI_DISTRIBUTION_PROFILE) throw new ConfigurationError('KORDI_DISTRIBUTION_PROFILE is required for packaging.');
  return loadDistributionConfiguration(env.KORDI_DISTRIBUTION_PROFILE, {
    edition: env.KORDI_EXPECTED_EDITION,
    environment: env.KORDI_EXPECTED_ENVIRONMENT,
    backendOrigin: env.KORDI_EXPECTED_BACKEND_ORIGIN,
  });
}

export function serviceEnvironment(profile, service) {
  const { services: s, resources: r, routing } = profile;
  if (service === 'runner') return {
    KORDI_CLOUD_API_BASE: routing.backend.origin,
    KORDI_CLOUD_RUNNER_CONCURRENCY: String(s.runner.concurrency),
    KORDI_CLOUD_RUNNER_POLL_MS: String(s.runner.pollMilliseconds),
    KORDI_CLOUD_SANDBOX_BACKEND: s.runner.sandboxBackend,
    KORDI_CLOUD_SANDBOX_CPU_MILLIS: String(r.sandboxCpuMillis),
    KORDI_CLOUD_SANDBOX_MEMORY_MIB: String(r.sandboxMemoryMiB),
  };
  if (service !== 'server') throw new ConfigurationError('Unknown configured service.');
  const values = {
    ...(profile.authentication ? { KORDI_AUTH_POLICY_JSON: JSON.stringify({ ...profile.authentication, edition: routing.edition, environment: routing.environment, backendOrigin: routing.backend.origin }) } : {}),
    KORDI_CLOUD_PUBLIC_BASE_URL: routing.backend.origin,
    KORDI_PUBLIC_APP_URL: routing.backend.origin,
    KORDI_CLIENT_CALLBACK_SCHEME: profile.clients.callbackScheme,
    KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST: `${profile.clients.callbackScheme}://oauth/callback`,
    KORDI_SERVICE_MODEL_PROVIDER: s.model.provider,
    KORDI_SERVICE_MODEL_BASE_URL: s.model.baseURL,
    KORDI_SERVICE_MODEL_MODEL: s.model.model,
    KORDI_CONNECTOR_CALLS_PER_HOUR: String(s.connectorCallsPerHour),
  };
  for (const [name, a] of [['SYSTEM_AGENT', s.systemAgent], ['SUPPORT', s.supportAgent]]) {
    Object.assign(values, {
      [`KORDI_${name}_ENABLED`]: String(a.enabled),
      [`KORDI_${name}_AGENT_NAME`]: a.name,
      [`KORDI_${name}_AGENT_SUBTITLE`]: a.subtitle,
      [`KORDI_${name}_OWNER_EMAIL`]: a.ownerEmail,
      [`KORDI_${name}_PERSONA`]: a.persona,
      [`KORDI_${name}_PROVIDER`]: s.model.provider,
      [`KORDI_${name}_OPENAI_MODEL`]: s.model.model,
      [`KORDI_${name}_VERTEX_MODEL`]: s.model.model,
      [`KORDI_${name}_OPENAI_BASE_URL`]: s.model.baseURL,
    });
  }
  return values;
}

/** Creates a new, local-only artifact directory. Never overwrites, executes, signs or deploys. */
export function writeDistributionArtifacts(selection, directory) {
  const { profile: p, assets } = selection;
  const out = path.resolve(directory);
  const c = publicClientConfiguration(p);
  const origin = c.backendOrigin;
  const files = {
    'client.json': json(c),
    'profile.json': json({ ...p, clients: { ...p.clients, desktopIcon: 'icon.png', desktopIcns: 'icon.icns', iosIcon: 'ios-icon.png' } }),
    'ios-icon.png': assets.iosIcon,
    'server.env.json': json(serviceEnvironment(p, 'server')),
    'runner.env.json': json(serviceEnvironment(p, 'runner')),
    'resources.json': json(p.resources),
    'apple-signing.json': json(p.apple),
    'ExportOptions.plist': `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>method</key><string>${p.apple.exportMethod}</string><key>destination</key><string>export</string><key>signingStyle</key><string>automatic</string></dict></plist>\n`,
    'icon.png': assets.desktopIcon,
    'icon.icns': assets.desktopIcns,
    'Distribution.xcassets/DistributionIcon.appiconset/icon.png': assets.iosIcon,
    'Distribution.xcassets/DistributionIcon.appiconset/Contents.json': json({images: [{filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024'}], info: {author: 'xcode', version: 1}}),
    'tauri.json': json({
      productName: c.updates.artifactName,
      identifier: c.desktopIdentifier,
      bundle: { icon: [path.join(out, 'icon.png'), path.join(out, 'icon.icns')], createUpdaterArtifacts: c.updates.enabled },
      plugins: {
        'deep-link': { desktop: { schemes: [c.callbackScheme] } },
        updater: { pubkey: c.updates.publicKey, endpoints: c.updates.enabled ? [`${origin}/updates/desktop/{{target}}/{{arch}}/{{current_version}}`] : [] },
      },
    }),
  };
  const settings = {
    KORDI_OPS_APP_ID: c.iosIdentifier,
    KORDI_OPS_SHARE_ID: c.iosShareIdentifier,
    KORDI_OPS_DISPLAY_NAME: c.displayName,
    KORDI_OPS_ORIGIN: origin.replace('://', ':/$()/'),
    KORDI_OPS_CHANNEL: c.environment === 'staging' ? (c.edition === 'research' ? 'research-staging' : 'staging') : (c.edition === 'app' ? 'production' : 'research'),
    KORDI_OPS_CALLBACK: c.callbackScheme,
    KORDI_OPS_APP_GROUP: c.appGroup,
    KORDI_OPS_CREDENTIAL_SERVICE: c.credentialService,
    KORDI_OPS_EXPECTED: Buffer.from(JSON.stringify(c)).toString('base64'),
    KORDI_OPS_ASSET_CATALOG: path.join(out, 'Distribution.xcassets'),
    KORDI_OPS_ICON: 'DistributionIcon',
  };
  files['ios.xcconfig'] = Object.entries(settings).map(([key, value]) => `${key} = ${value}`).join('\n') + '\n';
  // Hash artifact content, not source paths. Signing references and service policies stay out of client.json.
  files['manifest.json'] = json({ schemaVersion: 1, edition: c.edition, environment: c.environment,
    backendOrigin: origin, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) });
  mkdirSync(out, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(out, name)), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(out, name), content, { flag: 'wx', mode: 0o600 });
  }
  return out;
}
