import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import { applyCloudSyncEventsToSessionVisibility, hasCachedCloudSessionVisibility, loadCloudSessionVisibility, saveCloudSessionVisibility } from '../src/features/cloud/cloudDiffSync';

const visibility = {hiddenSessionIds:['archived'],deletedSessionIds:['deleted'],unreadSessionIds:[],pinnedSessionIds:[],mutedSessionIds:['muted'],pinnedGroupSpaceIds:[]};
const bootstrap = {protocol_version:2,conversations:[],latest_messages:[],next_cursor:'cursor-7',last_stream_seq:7,server_time:'2026-09-01T00:00:00Z'};

test('cold bootstrap publishes visibility ahead of rows and persists the same native batch', async () => {
  const state = new ChatSyncState(async () => {throw new Error('No second visibility request');},()=> 'acct_fixture',()=>{},()=>null);
  state.bootstrap = async () => ({...bootstrap,session_visibility:visibility});
  const result = await new ChatSyncSyncClient(state).syncCloudEvents('synthetic','0');
  assert.equal(result.events[0].eventType,'session.visibility.snapshot');
  assert.deepEqual(result.chat?.events[0].payload,{visibility});
  const next = applyCloudSyncEventsToSessionVisibility('acct_fixture',loadCloudSessionVisibility(null),result.events);
  assert.deepEqual([...next.deletedSessionIds],['deleted']);
  assert.deepEqual([...next.hiddenSessionIds],['archived']);
});

test('older-server fallback must load visibility before exposing the bootstrap', async () => {
  let finish!: (value: typeof visibility) => void;
  const pending = new Promise<typeof visibility>(resolve => {finish=resolve;});
  const state = new ChatSyncState(async <T>() => await pending as T,()=> 'acct_fixture',()=>{},()=>null);
  state.bootstrap = async () => bootstrap;
  let published=false;
  const result = new ChatSyncSyncClient(state).syncCloudEvents('synthetic','0').then(value=>{published=true;return value;});
  await Promise.resolve();
  assert.equal(published,false);
  finish(visibility);
  assert.equal((await result).events[0].eventType,'session.visibility.snapshot');
});

test('unknown visibility is not a known empty account snapshot', () => {
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)} as Storage;
  assert.equal(hasCachedCloudSessionVisibility('acct_a',storage),false);
  saveCloudSessionVisibility('acct_a',loadCloudSessionVisibility(null),storage);
  assert.equal(hasCachedCloudSessionVisibility('acct_a',storage),true);
  assert.equal(hasCachedCloudSessionVisibility('acct_b',storage),false);
});
