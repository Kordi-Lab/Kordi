import type { ComponentType } from 'react';
import { Atom, Bot, Code2, Compass, Cpu, Globe2, Server, Sparkles, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuthProviderGlyphProps = {
  providerId: string;
  label: string;
  size?: 'sm' | 'md' | 'lg';
};

const providerGlyphMeta: Record<string, { icon: ComponentType<{ className?: string }>; className: string }> = {
  anthropic: {
    icon: Bot,
    className: 'bg-[linear-gradient(180deg,rgba(196,163,110,0.32),rgba(92,69,35,0.22))] text-amber-100 border-amber-200/18',
  },
  openai: {
    icon: Sparkles,
    className: 'bg-[linear-gradient(180deg,rgba(108,210,182,0.28),rgba(40,96,83,0.24))] text-emerald-100 border-emerald-200/18',
  },
  'openai-codex': {
    icon: Sparkles,
    className: 'bg-[linear-gradient(180deg,rgba(108,210,182,0.28),rgba(40,96,83,0.24))] text-emerald-100 border-emerald-200/18',
  },
  'github-copilot': {
    icon: Code2,
    className: 'bg-[linear-gradient(180deg,rgba(139,154,255,0.3),rgba(53,62,130,0.24))] text-indigo-100 border-indigo-200/18',
  },
  'lm-studio': {
    icon: Cpu,
    className: 'bg-[linear-gradient(180deg,rgba(251,191,36,0.28),rgba(120,53,15,0.24))] text-yellow-100 border-yellow-200/18',
  },
  ollama: {
    icon: Server,
    className: 'bg-[linear-gradient(180deg,rgba(148,163,184,0.28),rgba(51,65,85,0.24))] text-slate-100 border-slate-200/18',
  },
  google: {
    icon: Globe2,
    className: 'bg-[linear-gradient(180deg,rgba(117,153,255,0.24),rgba(57,82,138,0.22))] text-blue-100 border-blue-200/18',
  },
  groq: {
    icon: Zap,
    className: 'bg-[linear-gradient(180deg,rgba(214,129,255,0.26),rgba(102,55,124,0.24))] text-fuchsia-100 border-fuchsia-200/18',
  },
  openrouter: {
    icon: Compass,
    className: 'bg-[linear-gradient(180deg,rgba(122,188,255,0.24),rgba(46,83,121,0.24))] text-cyan-100 border-cyan-200/18',
  },
  xai: {
    icon: Atom,
    className: 'bg-[linear-gradient(180deg,rgba(180,187,203,0.22),rgba(79,87,100,0.24))] text-slate-100 border-slate-200/18',
  },
};

export function AuthProviderGlyph({ providerId, label, size = 'md' }: AuthProviderGlyphProps) {
  const meta = providerGlyphMeta[providerId] ?? providerGlyphMeta[label.toLowerCase()] ?? providerGlyphMeta.openai;
  const Icon = meta.icon;

  return (
    <div
      data-provider-glyph={providerId}
      className={cn(
        'app-auth-provider-glyph grid shrink-0 place-items-center rounded-[14px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
        meta.className,
        size === 'sm' && 'h-8 w-8 rounded-[10px]',
        size === 'md' && 'h-9 w-9',
        size === 'lg' && 'h-11 w-11 rounded-[16px]',
      )}
    >
      <Icon className={cn(size === 'sm' && 'h-4 w-4', size === 'md' && 'h-[18px] w-[18px]', size === 'lg' && 'h-5 w-5')} />
    </div>
  );
}
