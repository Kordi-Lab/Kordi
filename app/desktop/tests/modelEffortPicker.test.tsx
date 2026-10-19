import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelEffortPicker, type ModelEffortPickerProps } from '../src/kordi-app/components/modelEffortPicker';
import { modelDisplayName } from '../src/lib/modelDisplayName';
import { authChoiceFromProviderOption, type ComposerRoute } from '../src/kordi-app/components/composerModelSelection';

const providers = [
  { value: 'openai::profile:work', providerId: 'openai', label: 'Work', active: true },
  { value: 'openai::profile:personal', providerId: 'openai', label: 'Personal' },
  { value: 'anthropic::profile:team', providerId: 'anthropic', label: 'Claude team' },
];
const models = [
  { value: 'openai/gpt-6-astra', label: 'gpt-6-astra', provider: 'openai', thinkingLevels: ['default','low','medium','high','xhigh','max'] },
  { value: 'openai/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai', thinkingLevels: ['default','low','medium','high','xhigh','max'] },
  { value: 'anthropic/claude-fable-5-1', label: 'claude-fable-5-1', provider: 'anthropic', thinkingLevels: ['default','minimal','low','medium','high','xhigh','max'] },
];
async function harness(options: { unavailable?: boolean; fail?: boolean; shared?: boolean; noEffort?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="kordi-app theme-light" style="--app-accent: rgb(135, 88, 55)"></div></body></html>', { pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.entries(replacements).forEach(([key,value]) => Object.defineProperty(globalThis,key,{ configurable:true,writable:true,value }));
  // React is imported before this per-test DOM; supply its legacy focus hooks.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const host = document.querySelector('.kordi-app')!;
  const root = createRoot(host);
  const saves: ComposerRoute[] = [];
  let fail = options.fail;
  function Harness() {
    const [selection,setSelection] = useState({ model:models[0].value,thinking:'high',authProvider:'openai',authChoice:options.unavailable ? 'profile:removed' : 'profile:work' });
    const apply: ModelEffortPickerProps['onApply'] = async (route) => {
      saves.push(route);
      if (fail) throw new Error('Route could not be saved');
      setSelection({ model:route.model,thinking:route.thinking,authProvider:route.providerOption!.providerId,authChoice:authChoiceFromProviderOption(route.providerOption!)! });
    };
    return <ModelEffortPicker selection={selection} providerOptions={providers}
      modelOptions={options.noEffort ? models.map(model => ({ ...model, thinkingLevels: [] })) : models}
      onApply={apply} confirmAccountChanges={options.shared ?? true} />;
  }
  await act(async () => root.render(<Harness />));
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button,selector); await act(async () => button.click());
  };
  const text = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(item => item.textContent?.trim() === label || item.textContent?.startsWith(label));
    assert.ok(button,label); await act(async () => button.click());
  };
  return { dom,saves,click,text,allowSave:()=>{fail=false;}, async cleanup() {
    await act(async()=>root.unmount()); dom.window.close();
    originals.forEach((descriptor,key)=>{ if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key); });
  } };
}

test('friendly names preserve protocol identifiers and supplied custom labels', () => {
  assert.equal(modelDisplayName('openai/gpt-6-astra'),'GPT-6 Astra');
  assert.equal(modelDisplayName('anthropic/claude-opus-4-8'),'Claude Opus 4.8');
  assert.equal(modelDisplayName('openrouter/anthropic/claude-fable-5-1'),'Claude Fable 5.1');
  assert.equal(modelDisplayName('custom/private-model','Research deployment'),'Research deployment');
});

test('model picks apply immediately; shared account picks wait for confirmation and cancellation preserves the route', async () => {
  const h = await harness();
  try {
    await h.click('[aria-label^="Select model,"]'); await h.text('GPT-6 Sol');
    assert.equal(h.saves.length,1); assert.equal(h.saves[0].model,models[1].value);
    assert.equal(document.querySelector('[role=dialog]'),null);
    await h.click('[aria-label^="Select model,"]'); await h.click('.app-model-picker-account'); await h.text('Personal');
    assert.equal(h.saves.length,1);
    assert.equal(document.querySelector('[role=dialog]')?.getAttribute('aria-label'),'Change shared account');
    await h.text('Cancel');
    await h.click('[aria-label^="Select model,"]'); await h.click('.app-model-picker-account'); await h.text('Personal'); await h.text('Change account');
    assert.equal(h.saves.length,2); assert.equal(h.saves[1].providerOption?.value,'openai::profile:personal');
    assert.equal(h.saves[1].model,models[1].value);
  } finally { await h.cleanup(); }
});

test('cross-provider picks select an account and keep the requested model through confirmation', async () => {
  const h=await harness();
  try {
    await h.click('[aria-label^="Select model,"]'); await h.text('Claude Fable 5.1');
    assert.equal(h.saves.length,0); await h.text('Claude team');
    assert.equal(h.saves.length,0); await h.text('Change account');
    assert.equal(h.saves[0].model,models[2].value);
    assert.equal(h.saves[0].providerOption?.providerId,'anthropic');
  } finally { await h.cleanup(); }
});

test('removed accounts are explicit and recovery never silently switches providers', async () => {
  const h=await harness({unavailable:true});
  try {
    assert.equal(h.saves.length,0);
    await h.click('[aria-label^="Select model,"]'); await h.click('.app-model-picker-account');
    assert.ok(document.querySelector('[role=dialog]')?.textContent?.includes('Account unavailable'));
    assert.ok(!document.querySelector('[role=dialog]')?.textContent?.includes('Claude team'));
    await h.text('Personal'); assert.equal(h.saves.length,0); await h.text('Change account');
    assert.equal(h.saves[0].providerOption?.value,'openai::profile:personal');
  } finally { await h.cleanup(); }
});

test('effort menu has supported steps, no captions, reset, keyboard commit, and Escape focus restoration', async () => {
  const h=await harness();
  try {
    await h.click('[aria-label^="Adjust effort,"]');
    const menu=document.querySelector<HTMLElement>('[role=dialog]')!;
    assert.equal(menu.style.width,'232px');
    assert.ok(!menu.textContent?.includes('More effort'));
    const slider=menu.querySelector<HTMLInputElement>('input[type=range]')!;
    assert.equal(slider.max,'4'); assert.equal(slider.getAttribute('aria-valuetext'),'High');
    await act(async()=>{
      slider.focus();
      slider.value='4';
      slider.dispatchEvent(new h.dom.window.KeyboardEvent('keyup',{key:'End',bubbles:true}));
    });
    assert.equal(h.saves[0].thinking,'max');
    await h.click('[aria-label="Reset effort to model default"]');
    assert.equal(h.saves[1].thinking,'default');
    await act(async()=>document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(document.querySelector('[role=dialog]'),null);
    assert.equal(document.activeElement?.getAttribute('aria-label'),'Adjust effort, current Default');
    assert.equal(h.saves.length,2,'closing default effort must not accidentally save Low');
  } finally { await h.cleanup(); }
});

test('failed saves keep the old route and a retryable error', async () => {
  const h=await harness({fail:true});
  try {
    await h.click('[aria-label^="Select model,"]'); await h.text('GPT-6 Sol');
    assert.ok(document.querySelector('[role=alert]')?.textContent?.includes('Route could not be saved'));
    assert.ok(document.querySelector('[aria-label="Select model, current GPT-6 Astra"]'));
    h.allowSave(); await h.text('Retry');
    assert.ok(document.querySelector('[aria-label="Select model, current GPT-6 Sol"]'));
    assert.equal(document.querySelector('[role=dialog]'),null);
  } finally { await h.cleanup(); }
});

test('an explicitly empty effort capability never invents slider steps', async () => {
  const h = await harness({ noEffort: true });
  try {
    await h.click('[aria-label^="Adjust effort,"]');
    assert.equal(document.querySelector('input[type=range]'), null);
    assert.equal(h.saves.length, 0);
  } finally { await h.cleanup(); }
});
