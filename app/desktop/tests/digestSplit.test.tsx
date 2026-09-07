import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DigestSplit} from '../src/features/digest/DigestSplit';
import {DigestRelatedLinks} from '../src/features/digest/DigestRelatedLinks';

test('Digest sidebar supports pointer and keyboard resizing, bounds and persisted width',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example',pretendToBeVisual:true});
  const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT};
  const previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:dom.window.localStorage});
  const host=dom.window.document.getElementById('root')!;let root=createRoot(host);
  const longURL='https://example.zoom.us/meeting/'+('long-path-'.repeat(20))+'/ics';
  const tree=createElement(DigestSplit,{children:[createElement('main',{key:'main'},'Calendar'),createElement('aside',{key:'sidebar',className:'digest-agenda'},createElement(DigestRelatedLinks,{links:[longURL,'https://example.zoom.us/j/123?pwd=fixture']}))]});
  const handle=()=>host.querySelector('[role="separator"]') as HTMLElement;
  const width=()=>Number(handle().getAttribute('aria-valuenow'));
  async function key(key:string){await act(async()=>handle().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true})));}
  try{
    await act(async()=>root.render(tree));
    assert.equal(width(),320);
    Object.defineProperty(host.firstElementChild,'clientWidth',{value:1200});
    await key('ArrowLeft');assert.equal(width(),336);
    await key('End');assert.equal(width(),560);
    await key('Home');assert.equal(width(),240);
    const separator=handle();separator.setPointerCapture=()=>{};
    host.querySelector('.digest-agenda')!.getBoundingClientRect=()=>new dom.window.DOMRect(0,0,240,600);
    await act(async()=>separator.dispatchEvent(new dom.window.MouseEvent('pointerdown',{button:0,clientX:600,bubbles:true})));
    await act(async()=>separator.dispatchEvent(new dom.window.MouseEvent('pointermove',{clientX:440,bubbles:true})));
    await act(async()=>separator.dispatchEvent(new dom.window.MouseEvent('pointerup',{bubbles:true})));
    assert.equal(width(),400);
    await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(tree));
    assert.equal(width(),400);
    const links=host.querySelectorAll('a');
    assert.equal(links[0].getAttribute('href'),longURL);assert.equal(links[0].getAttribute('title'),longURL);
    assert.ok(links[0].querySelector('span')!.textContent!.length<=48);
    assert.equal(links[0].querySelector('strong')!.textContent,'Open link');
    assert.equal(links[1].querySelector('span')!.textContent,'example.zoom.us');
    assert.equal(links[1].getAttribute('href'),'https://example.zoom.us/j/123?pwd=fixture');
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else delete (globalThis as {localStorage?:Storage}).localStorage;dom.window.close();}
});
