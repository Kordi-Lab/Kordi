import { ConfigurationError } from './backend.mjs';

const fail = () => { throw new ConfigurationError('Invalid instance authentication policy.'); };
export function validateAuthentication(value, target) {
  if (!value || Object.keys(value).sort().join(',') !== 'admission,approvedEmailsBinding,loginPage,oauthBindings,verifiedDomains') fail();
  if (Object.keys(value.loginPage ?? {}).sort().join(',') !== 'signupSubtitle,signupTitle,subtitle,title'
      || Object.values(value.loginPage).some((v) => typeof v !== 'string' || !/^[^\r\n\0]{1,240}$/.test(v))) fail();
  if (!['existing', 'verified-domain', 'approved-testers'].includes(value.admission)) fail();
  if (!Array.isArray(value.verifiedDomains) || value.verifiedDomains.length > 20
      || value.verifiedDomains.some((v) => typeof v !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(v))
      || new Set(value.verifiedDomains).size !== value.verifiedDomains.length) fail();
  if ((value.admission === 'verified-domain') !== (value.verifiedDomains.length > 0)) fail();
  if (target.environment === 'staging' && value.admission !== 'approved-testers') fail();
  if (target.edition === 'research' && target.environment === 'production' && value.admission !== 'verified-domain') fail();
  if (Object.keys(value.oauthBindings ?? {}).sort().join(',') !== 'githubClientId,githubClientSecret,googleClientId,googleClientSecret') fail();
  const bindings = [value.approvedEmailsBinding, ...Object.values(value.oauthBindings)];
  if (bindings.some((v) => typeof v !== 'string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(v)) || new Set(bindings).size !== bindings.length) fail();
  return value;
}

// Only the process launcher resolves credentials; prepared artifacts contain names, never values.
export function authenticationBindings(profile, env) {
  if (!profile.authentication) return {};
  const output = {};
  for (const [field, runtime] of Object.entries({ googleClientId: 'KORDI_OAUTH_GOOGLE_CLIENT_ID', googleClientSecret: 'KORDI_OAUTH_GOOGLE_CLIENT_SECRET', githubClientId: 'KORDI_OAUTH_GITHUB_CLIENT_ID', githubClientSecret: 'KORDI_OAUTH_GITHUB_CLIENT_SECRET' })) {
    const value = env[profile.authentication.oauthBindings[field]];
    if (!value?.trim() || /[\r\n\0]/.test(value)) throw new ConfigurationError('Required instance OAuth binding is missing.');
    output[runtime] = value;
  }
  if (profile.authentication.admission !== 'existing' && !env[profile.authentication.approvedEmailsBinding]) {
    throw new ConfigurationError('Explicit approved-email binding is required; use an empty JSON array to approve nobody.');
  }
  return output;
}
