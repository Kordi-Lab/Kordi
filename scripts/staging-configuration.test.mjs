import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateAuthentication, authenticationBindings } from '../shared/configuration/authentication.mjs';
import { validateDistributionConfiguration, publicDesktopConfiguration } from '../shared/configuration/distribution.mjs';
import { serviceEnvironment } from '../shared/configuration/distribution-files.mjs';

const target = {edition:'app',environment:'staging',backendOrigin:'https://staging.example.test'};
const authentication = () => ({admission:'approved-testers',verifiedDomains:[],approvedEmailsBinding:'TEST_APPROVED',oauthBindings:{googleClientId:'TEST_GOOGLE_ID',googleClientSecret:'TEST_GOOGLE_SECRET',githubClientId:'TEST_GITHUB_ID',githubClientSecret:'TEST_GITHUB_SECRET'},loginPage:{title:'Welcome to Test Staging',subtitle:'Approved testers only.',signupTitle:'Join Test Staging',signupSubtitle:'Request approval from the instance owner.'}});
function profile() {
  const value = JSON.parse(readFileSync(new URL('./test_support/distribution/app.json',import.meta.url)));
  value.authentication = authentication(); value.routing.environment = 'staging'; value.routing.backend.origin = target.backendOrigin;
  for (const key of ['desktopIdentifier','iosIdentifier','appGroup','credentialService']) value.clients[key]+='.staging';
  value.clients.iosShareIdentifier=value.clients.iosIdentifier+'.share';value.clients.callbackScheme='kordi-staging';
  value.clients.updates={enabled:false,publicKey:'',artifactName:'TestStaging'};
  return value;
}
test('staging rejects production identities and open admission while keeping credentials out of clients',()=>{
  const value=validateDistributionConfiguration(profile(),target);
  const client=publicDesktopConfiguration(value);
  assert.equal(client.loginPage.title,'Welcome to Test Staging');
  assert.equal(client.backendOrigin,target.backendOrigin);
  assert.ok(!JSON.stringify(client).includes('TEST_GOOGLE'));
  const policy=JSON.parse(serviceEnvironment(value,'server').KORDI_AUTH_POLICY_JSON);
  assert.equal(policy.admission,'approved-testers');
  for(const mutate of [p=>delete p.authentication,p=>p.authentication.admission='existing',p=>p.clients.callbackScheme='kordi',p=>p.clients.iosIdentifier='ai.kordi.ios']) {
    const wrong=profile();mutate(wrong);assert.throws(()=>validateDistributionConfiguration(wrong,target));
  }
});
test('OAuth bindings are resolved only by the service launcher with no inherited production fallback',()=>{
  const value=profile();
  const env={KORDI_OAUTH_GOOGLE_CLIENT_ID:'wrong-instance',TEST_APPROVED:'[]'};
  assert.throws(()=>authenticationBindings(value,env),/binding/);
  for(const binding of Object.values(value.authentication.oauthBindings))env[binding]='synthetic-'+binding;
  const resolved=authenticationBindings(value,env);
  assert.equal(resolved.KORDI_OAUTH_GOOGLE_CLIENT_ID,'synthetic-TEST_GOOGLE_ID');
  assert.ok(!JSON.stringify(serviceEnvironment(value,'server')).includes('synthetic-TEST_GOOGLE_SECRET'));
  delete env.TEST_APPROVED;assert.throws(()=>authenticationBindings(value,env),/approved-email/);
});
test('Apple bindings resolve only when configured and keep the PEM key intact',()=>{
  const value=profile();
  const env={TEST_APPROVED:'[]'};
  for(const binding of Object.values(value.authentication.oauthBindings))env[binding]='synthetic-'+binding;
  const without=authenticationBindings(value,env);
  assert.ok(!Object.keys(without).some((name)=>name.startsWith('KORDI_OAUTH_APPLE_')));
  Object.assign(value.authentication.oauthBindings,{appleClientId:'TEST_APPLE_ID',appleTeamId:'TEST_APPLE_TEAM',appleKeyId:'TEST_APPLE_KEY_ID',applePrivateKey:'TEST_APPLE_KEY'});
  assert.equal(validateAuthentication(value.authentication,target),value.authentication);
  assert.throws(()=>authenticationBindings(value,env),/binding/);
  Object.assign(env,{TEST_APPLE_ID:'test.services.id',TEST_APPLE_TEAM:'TEAM000001',TEST_APPLE_KEY_ID:'KEY0000001',TEST_APPLE_KEY:'-----BEGIN SYNTHETIC-----\nAAAA\n-----END SYNTHETIC-----\n'});
  const resolved=authenticationBindings(value,env);
  assert.equal(resolved.KORDI_OAUTH_APPLE_CLIENT_ID,'test.services.id');
  assert.equal(resolved.KORDI_OAUTH_APPLE_PRIVATE_KEY,env.TEST_APPLE_KEY);
  env.TEST_APPLE_ID='two\nlines';assert.throws(()=>authenticationBindings(value,env),/binding/);
  delete value.authentication.oauthBindings.appleKeyId;assert.throws(()=>validateAuthentication(value.authentication,target));
});
test('Research production requires a verified-domain policy and exact, bounded page settings',()=>{
  const value=authentication();value.admission='verified-domain';value.verifiedDomains=['example.edu'];
  const research={...target,edition:'research',environment:'production'};
  assert.equal(validateAuthentication(value,research),value);
  for(const mutate of [a=>a.verifiedDomains=['*.example.edu'],a=>a.loginPage.title='',a=>a.loginPage.extra='bad',a=>a.oauthBindings.googleClientSecret=a.oauthBindings.googleClientId]) {
    const wrong=structuredClone(value);mutate(wrong);assert.throws(()=>validateAuthentication(wrong,research));
  }
});
