import type { ComponentType } from 'react';
import { Asterisk, Atom, Code2, Cpu, Gem, Orbit, Route, Server, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuthProviderGlyphProps = {
  providerId: string;
  label: string;
  size?: 'sm' | 'md' | 'lg';
};

const providerGlyphMeta: Record<string, { icon: ComponentType<{ className?: string }>; toneClassName: string }> = {
  anthropic: {
    icon: Asterisk,
    toneClassName: 'text-amber-200',
  },
  openai: {
    icon: Orbit,
    toneClassName: 'text-emerald-200',
  },
  'openai-codex': {
    icon: Orbit,
    toneClassName: 'text-emerald-200',
  },
  'github-copilot': {
    icon: Code2,
    toneClassName: 'text-indigo-200',
  },
  'lm-studio': {
    icon: Cpu,
    toneClassName: 'text-amber-200',
  },
  ollama: {
    icon: Server,
    toneClassName: 'text-slate-200',
  },
  google: {
    icon: Gem,
    toneClassName: 'text-blue-200',
  },
  groq: {
    icon: Zap,
    toneClassName: 'text-fuchsia-200',
  },
  openrouter: {
    icon: Route,
    toneClassName: 'text-cyan-200',
  },
  xai: {
    icon: Atom,
    toneClassName: 'text-slate-200',
  },
};

export function AuthProviderGlyph({ providerId, label, size = 'md' }: AuthProviderGlyphProps) {
  const meta = providerGlyphMeta[providerId] ?? providerGlyphMeta[label.toLowerCase()] ?? providerGlyphMeta.openai;
  const Icon = meta.icon;

  return (
    <div
      data-provider-glyph={providerId}
      aria-hidden="true"
      className={cn(
        'app-auth-provider-glyph grid shrink-0 place-items-center opacity-80 transition-[color,opacity] duration-150',
        meta.toneClassName,
        size === 'sm' && 'h-8 w-8',
        size === 'md' && 'h-9 w-9',
        size === 'lg' && 'h-11 w-11',
      )}
    >
      <Icon className={cn(size === 'sm' && 'h-[18px] w-[18px]', size === 'md' && 'h-5 w-5', size === 'lg' && 'h-6 w-6')} />
    </div>
  );
}
