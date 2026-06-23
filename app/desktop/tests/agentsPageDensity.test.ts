import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const agentsPageSource = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
const agentsSidebarSource = readFileSync(new URL('../src/kordi-app/agents/AgentsSidebar.tsx', import.meta.url), 'utf8');
const agentDetailSource = readFileSync(new URL('../src/kordi-app/agents/AgentDetailPane.tsx', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../src/kordi-app/agents/shared.tsx', import.meta.url), 'utf8');
const shellPagesCss = readFileSync(new URL('../src/styles/shell-pages.css', import.meta.url), 'utf8');

test('agents page fills the workspace instead of floating as a rounded dashboard card', () => {
  assert.match(agentsPageSource, /app-agents-page[^"']*p-0/);
  assert.doesNotMatch(agentsPageSource, /app-agents-page[^"']*p-4/);
  assert.match(agentsPageSource, /app-agent-shell[^"']*rounded-none[^"']*border-0/);
  assert.doesNotMatch(agentsPageSource, /app-agent-shell[^"']*rounded-\[22px\]/);
});

test('agents sidebar header uses compact product copy and dense list rows', () => {
  assert.match(agentsSidebarSource, /\{agents\.length\} identities/);
  assert.doesNotMatch(agentsSidebarSource, /choose one to inspect in the middle and edit files on the right/);
  assert.match(agentsSidebarSource, /app-agent-list-row[^"']*rounded-\[12px\][^"']*py-2\.5/);
  assert.match(agentsSidebarSource, /app-agent-row-copy[^"']*line-clamp-1/);
});

test('agent detail header keeps the primary action neutral and prevents oversized hero wrapping', () => {
  assert.match(agentDetailSource, /app-agent-header-action/);
  assert.match(agentDetailSource, /<Button\s+variant="secondary"[^>]*className="app-agent-header-action h-8 rounded-\[10px\] px-3 text-\[12px\]"/s);
  assert.doesNotMatch(agentDetailSource, /Middle panel lists each item\. Click prompt or markdown files to open detail on the right\./);
  assert.match(agentDetailSource, /app-agent-hero-title[^"']*text-\[18px\]/);
});

test('model routing renders as an inline inspector group instead of another boxed card', () => {
  assert.match(agentDetailSource, /className="app-agent-routing-section"/);
  assert.match(agentDetailSource, /app-agent-routing-note/);
  assert.doesNotMatch(agentDetailSource, /app-agent-empty-callout rounded-\[14px\] border border-dashed px-4 py-3 text-\[13px\] leading-5/);
  assert.match(sharedSource, /app-agent-section rounded-\[18px\] border p-4/);
  assert.match(shellPagesCss, /\.app-agent-routing-section\s*{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;[^}]*padding:\s*0;/s);
  assert.match(shellPagesCss, /\.app-agent-routing-section \.[^{]*app-agent-section-detail\s*{[^}]*max-width:\s*42rem;/s);
});
