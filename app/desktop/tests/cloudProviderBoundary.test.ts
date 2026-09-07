import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CloudAuthClient} from '../src/features/cloud/authClient';
import {reconcileCloudProviderAuthSnapshots} from '../src/features/cloud/useCloudProviderAuthSnapshotSync';

function fixture(configured: boolean, reason: 'oauth-completed' | 'provider-logout') {
  const calls: string[] = [];
  let revoked = false;
  const snapshot = {snapshotId:'from-device-b',provider:'openai',authChoice:'local-active-oauth',createdAt:'2026-09-01T00:00:00Z',revokedAt:null};
  const client = new CloudAuthClient({baseUrl:'http://fixture',fetchImpl:async (_url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(method);
    if (method === 'DELETE') revoked = true;
    return new Response(JSON.stringify(method === 'GET' ? {snapshot:revoked ? null : snapshot} : snapshot),{status:200});
  }});
  const options: Parameters<typeof reconcileCloudProviderAuthSnapshots>[0] = {
    accountId:'acct_owner',client,route:null,isCurrent:()=>true,
    intent:{accountId:'acct_owner',deviceId:'device-a',providerId:'openai',reason,revision:1},
    loadStoredSession:async()=>({accountId:'acct_owner',deviceId:'device-a',token:'synthetic',expiresAt:'2099-01-01'}),
    buildSnapshotPayload:async()=>({provider:'openai',authChoice:'local-active-oauth',payload:{accessToken:'synthetic'}}),
    desktopAuthState:{authPath:'/redacted',hasAnyAuth:configured,providers:[{
      id:'openai',label:'OpenAI',configured,statusSummary:'Fixture',loginHint:'',envVar:'',helpUrl:'',supportsOAuth:true,supportsApiKey:true,
      options:configured ? [{value:'profile:local',label:'Local',method:'oauth',source:'local',active:true}] : [],
    }]},
  };
  return {options,calls};
}

test('unauthenticated device never publishes or revokes on a non-removal intent', async () => {
  const {options,calls}=fixture(false,'oauth-completed');
  assert.equal(await reconcileCloudProviderAuthSnapshots(options),'not-ready');
  assert.deepEqual(calls,[]);
});

test('explicit local provider logout revokes Cloud even when another device supplied it', async () => {
  const {options,calls}=fixture(false,'provider-logout');
  assert.equal(await reconcileCloudProviderAuthSnapshots(options),'complete');
  assert.equal(calls.filter(method=>method==='DELETE').length,1);
  assert.equal(calls.includes('POST'),false);
});

test('successful explicit local authentication refreshes Cloud provider material', async () => {
  const {options,calls}=fixture(true,'oauth-completed');
  assert.equal(await reconcileCloudProviderAuthSnapshots(options),'complete');
  assert.deepEqual(calls,['POST']);
});

test('an authentication intent from a previous account or device cannot mutate Cloud', async () => {
  for(const scope of [{accountId:'acct_old'}, {deviceId:'device-old'}]) {
    const {options,calls}=fixture(true,'oauth-completed');
    options.intent={...options.intent,...scope};
    assert.equal(await reconcileCloudProviderAuthSnapshots(options),'stale');
    assert.deepEqual(calls,[]);
  }
});
