// "Add PiP, the plan helper" when creating a group. Off by default and shown
// only when the server runs PiP.
import { AI_ACCESS_COPY, createPipHelpText } from '@/features/agentTrust/aiAccessCopy';
import type { AgentTrustApi } from '@/features/agentTrust/agentTrustApi';
import { useAiFeatures } from '@/features/agentTrust/useAiFeatures';
import { AgentTrustSwitchRow } from './agentTrustControls';

export function PipCreateSwitch({ checked, onChange, api }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  api?: AgentTrustApi;
}) {
  const features = useAiFeatures(api);
  if (!features?.pip.available) return null;
  return (
    <div data-pip-create-switch="true" className="px-0.5">
      <AgentTrustSwitchRow
        label={AI_ACCESS_COPY.createPipLabel}
        help={createPipHelpText(features.pip.providerLabel)}
        checked={checked}
        onChange={onChange}
      />
    </div>
  );
}
