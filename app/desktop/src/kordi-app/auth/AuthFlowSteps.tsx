import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AuthFlowStepState = 'pending' | 'active' | 'done';

export type AuthFlowStep = {
  label: string;
  state: AuthFlowStepState;
};

type AuthFlowStepsProps = {
  steps: AuthFlowStep[];
};

function StepDot({ state }: { state: AuthFlowStepState }) {
  if (state === 'done') {
    return (
      <div className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-white">
        <Check className="h-3 w-3" />
      </div>
    );
  }

  if (state === 'active') {
    return <div className="h-5 w-5 rounded-full border border-white/20 bg-[color:var(--app-chip-active-bg)]" />;
  }

  return <div className="h-5 w-5 rounded-full border border-white/16 bg-transparent" />;
}

export function AuthFlowSteps({ steps }: AuthFlowStepsProps) {
  return (
    <div className="rounded-[22px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-4 py-4">
      <div className="space-y-3">
        {steps.map((step, index) => (
          <div key={`${step.label}-${index}`} className="flex items-start gap-3">
            <div className="mt-0.5 flex flex-col items-center">
              <StepDot state={step.state} />
              {index < steps.length - 1 && <div className="mt-1 h-6 w-px bg-white/10" />}
            </div>
            <div className={cn('text-[13px] leading-6', step.state === 'done' ? 'text-slate-200' : step.state === 'active' ? 'text-white' : 'text-slate-500')}>
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
