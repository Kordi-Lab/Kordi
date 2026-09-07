import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {digestClient} from '../src/features/digest/client';
import type {CalendarEvent,DigestResponse} from '../src/features/digest/types';
const css=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {default:DigestPage}=await import('../src/features/digest/DigestPage');css.deregister();

test('a red series cancellation reviews all dates and deletes only after explicit confirmation',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true});dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const original={...digestClient};
 let events:CalendarEvent[]=[8,15,22].map((day,index)=>({id:'event-'+index,title:'Review',startAt:`2099-09-${String(day).padStart(2,'0')}T12:00:00Z`,allDay:false,sourceIds:[],description:'',revision:index+1,seriesId:'owned-series'}));
 const response:DigestResponse={accountId:'viewer',status:'ready',revision:1,updatedAt:'2026-09-07T00:00:00Z',partial:false,feedback:[],sources:[],snapshot:{claims:[],commitments:[],suggestions:[],calendarCandidates:[{id:'cancel-series',title:'Review',text:'A contextual request.',kind:'possible',sourceIds:[],calendarAction:'delete',calendarScope:'series',existingSeriesId:'owned-series'}]}};
 digestClient.read=async()=>structuredClone(response);digestClient.calendar=async()=>({events});
 let removed=0;digestClient.removeEvent=async()=>{assert.fail('A series cancellation must not delete only one occurrence');};
 digestClient.removeSeries=async(account,id,expected)=>{assert.equal(account,'viewer');assert.equal(id,'owned-series');assert.deepEqual(expected.map(event=>[event.id,event.revision]),[['event-0',1],['event-1',2],['event-2',3]]);removed++;events=[];};
 const host=dom.window.document.getElementById('root')!,root=createRoot(host);
 const click=async(label:string)=>{const button=[...host.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(button,label);await act(async()=>button.click());};
 try{
  await act(async()=>root.render(createElement(DigestPage,{accountId:'viewer'})));
  assert.match(host.querySelector('.digest-cancellation')?.textContent??'',/Cancellation to review/);
  await click('Review cancellation');assert.equal(removed,0);
  assert.equal(host.querySelectorAll('dialog .digest-import-list li').length,3);
  await click('Keep event');assert.equal(removed,0);
  await click('Review cancellation');await click('Confirm removal');assert.equal(removed,1);
  assert.equal(host.querySelector('.digest-cancellation'),null,'A stale snapshot must not display a red cancellation for a removed event');
 }finally{await act(async()=>root.unmount());Object.assign(digestClient,original);Object.assign(globalThis,previous);dom.window.close();}
});

test('withdrawing an unconfirmed arrangement closes its draft without deleting a saved event',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true});dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const original={...digestClient};
 const response:DigestResponse={accountId:'viewer',status:'ready',revision:1,updatedAt:'2026-09-07T00:00:00Z',partial:false,feedback:[],sources:[],snapshot:{claims:[],commitments:[],suggestions:[],calendarCandidates:[{id:'draft',title:'Unconfirmed meeting',text:'',kind:'possible',sourceIds:[],startAt:'2099-09-08T12:00:00Z'}]}};
 digestClient.read=async()=>structuredClone(response);digestClient.calendar=async()=>({events:[]});
 digestClient.refresh=async()=>{response.snapshot!.calendarCandidates=[];};
 digestClient.saveEvent=async()=>{assert.fail('Withdrawal must not save anything');};
 digestClient.removeEvent=async()=>{assert.fail('An unconfirmed proposal is not a saved event');};
 const host=dom.window.document.getElementById('root')!,root=createRoot(host);
 try{
  await act(async()=>root.render(createElement(DigestPage,{accountId:'viewer'})));
  const review=[...host.querySelectorAll('button')].find(button=>button.textContent==='Review & add')!;
  await act(async()=>review.click());assert.ok(host.querySelector('dialog'));
  await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="Refresh digest"]')!.click());
  assert.equal(host.querySelector('dialog'),null);assert.equal(host.querySelector('.digest-cancellation'),null);
  assert.equal(host.querySelector('.digest-proposal'),null);
 }finally{await act(async()=>root.unmount());Object.assign(digestClient,original);Object.assign(globalThis,previous);dom.window.close();}
});
