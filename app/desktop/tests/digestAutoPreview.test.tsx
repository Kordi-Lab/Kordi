import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {digestClient} from '../src/features/digest/client';
import {useCalendarPreview} from '../src/features/digest/useCalendarPreview';

test('automatic dates discard stale requests, isolate accounts and retry without saving',async()=>{
  const dom=new JSDOM('<div id="root"></div>');
  const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  const original=digestClient.previewSeries;
  const calls:Array<{signal?:AbortSignal;resolve:()=>void;reject:(error:Error)=>void}>=[];
  digestClient.previewSeries=(_,event,signal)=>new Promise((resolve,reject)=>calls.push({signal,resolve:()=>resolve({events:[event]}),reject}));
  function View({account,request}:{account:string;request:string|null}){
    const preview=useCalendarPreview(account,request);
    return createElement('div',null,createElement('output',null,preview.loading?'Loading':preview.error??preview.events.map(event=>event.id).join(',')),createElement('button',{disabled:!preview.ready},'Confirm'),createElement('button',{onClick:preview.retry},'Retry'));
  }
  const host=dom.window.document.getElementById('root')!,root=createRoot(host);
  const render=async(account:string,id:string)=>act(async()=>root.render(createElement(View,{account,request:JSON.stringify({id})})));
  const wait=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,250));});
  const ready=()=>!host.querySelector('button')!.disabled;
  try{
    await render('first-account','old');assert.equal(ready(),false);await wait();assert.equal(calls.length,1);
    await render('first-account','new');assert.equal(calls[0].signal?.aborted,true);assert.equal(ready(),false);await wait();
    await act(async()=>calls[1].resolve());assert.equal(ready(),true);assert.equal(host.querySelector('output')!.textContent,'new');
    await act(async()=>calls[0].resolve());assert.equal(host.querySelector('output')!.textContent,'new');
    await render('second-account','new');assert.equal(ready(),false);await wait();
    await act(async()=>calls[2].reject(new Error('Network unavailable')));assert.equal(ready(),false);assert.match(host.textContent??'',/Network unavailable/);
    await act(async()=>host.querySelectorAll('button')[1].click());assert.equal(ready(),false);await wait();
    await act(async()=>calls[3].resolve());assert.equal(ready(),true);
  }finally{await act(async()=>root.unmount());digestClient.previewSeries=original;Object.assign(globalThis,previous);dom.window.close();}
});
