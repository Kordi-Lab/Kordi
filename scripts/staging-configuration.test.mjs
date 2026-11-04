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
test('Research production requires a verified-domain policy and exact, bounded page settings',()=>{
  const value=authentication();value.admission='verified-domain';value.verifiedDomains=['example.edu'];
  const research={...target,edition:'research',environment:'production'};
  assert.equal(validateAuthentication(value,research),value);
  for(const mutate of [a=>a.verifiedDomains=['*.example.edu'],a=>a.loginPage.title='',a=>a.loginPage.extra='bad',a=>a.oauthBindings.googleClientSecret=a.oauthBindings.googleClientId]) {
    const wrong=structuredClone(value);mutate(wrong);assert.throws(()=>validateAuthentication(wrong,research));
  }
});
