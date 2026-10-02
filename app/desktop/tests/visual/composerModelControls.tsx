import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerModelControls } from '../../src/kordi-app/components/composer';
import type { ComposerSelectorType } from '../../src/kordi-app/types';
import '../../src/index.css';

const providers = [
  { value: 'openai::work', providerId: 'openai', label: 'ChatGPT', detail: 'Work', selectionLabel: 'ChatGPT · Work' },
  { value: 'anthropic::research', providerId: 'anthropic', label: 'Claude', detail: 'Research subscription', selectionLabel: 'Claude · Research subscription' },
];
const models = [
  { value: 'openai/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'openai/long-model', label: 'A much longer model display name', provider: 'openai', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'anthropic/claude-fable-5', label: 'claude-fable-5', provider: 'anthropic', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
];

function Fixture() {
  const compact = new URLSearchParams(location.search).has('compact');
  const [selection, setSelection] = useState({ mode: 'agent', model: models[0].value, thinking: 'medium', authProvider: 'openai', authChoice: 'work' });
  const [openSelector, setOpenSelector] = useState<{ scope: 'chat'; type: ComposerSelectorType } | null>(null);
  return <main className="kordi-app theme-light" style={{ minHeight: '100vh', padding: 24, background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
    <div style={{ position: 'fixed', bottom: 24, left: 24, right: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
      <ComposerModelControls scope="chat" compact={compact} selection={selection} openSelector={openSelector}
        authLabel="Synthetic account" authOptions={[]} onSelectAuthChoice={() => undefined}
        providerOptions={providers} modelOptions={models}
        onToggleSelector={(_scope, type) => setOpenSelector(current => current?.type === type ? null : { scope: 'chat', type })}
        onSelectValue={(_scope, type, value) => { setSelection(current => ({ ...current, [type]: value })); setOpenSelector(null); }}
        onSelectProviderChoice={(_scope, option) => {
          setSelection(current => ({ ...current, authProvider: option.providerId, authChoice: option.value.split('::')[1], model: models.find(model => model.provider === option.providerId)!.value }));
          setOpenSelector(null);
        }} />
      <span data-neighbor="project" style={{ flexShrink: 0 }}>Project</span>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
