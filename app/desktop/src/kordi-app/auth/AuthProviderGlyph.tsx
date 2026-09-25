import { cn } from '@/lib/utils';

type AuthProviderGlyphProps = {
  providerId: string;
  label: string;
  size?: 'sm' | 'md' | 'lg';
};

// Keep aliases explicit: an OMP route is not always the name of its parent brand.
// SVGs are bundled locally in public/provider-logos and credited in LICENSES.md.
const providerLogo: Record<string, string> = {
  'alibaba-coding-plan': 'alibaba-color',
  'alibaba-token-plan': 'alibaba-color',
  'amazon-bedrock': 'bedrock-color',
  anthropic: 'claude-color',
  azure: 'azureai-color',
  baseten: 'baseten',
  'bedrock-mantle': 'bedrock-color',
  cerebras: 'cerebras-color',
  'cline-pass': 'cline',
  'cloudflare-ai-gateway': 'cloudflare-color',
  commandcode: 'commandcode',
  cursor: 'cursor',
  deepinfra: 'deepinfra-color',
  deepseek: 'deepseek-color',
  devin: 'devin-color',
  firepass: 'fireworks-color',
  fireworks: 'fireworks-color',
  'github-copilot': 'githubcopilot',
  'gitlab-duo': 'gitlab',
  'gitlab-duo-agent': 'gitlab',
  'gmi-cloud': 'gmicloud',
  google: 'google-color',
  'google-antigravity': 'antigravity-color',
  'google-gemini-cli': 'geminicli-color',
  'google-vertex': 'vertexai-color',
  groq: 'groq',
  huggingface: 'huggingface-color',
  kilo: 'kilocode',
  'kimi-code': 'kimi-color',
  'lm-studio': 'lmstudio',
  meta: 'meta-color',
  minimax: 'minimax-color',
  'minimax-cn': 'minimax-color',
  'minimax-code': 'minimax-color',
  'minimax-code-cn': 'minimax-color',
  mistral: 'mistral-color',
  moonshot: 'moonshot',
  'muse-code': 'meta-color',
  nanogpt: 'nanogpt',
  novita: 'novita-color',
  nvidia: 'nvidia-color',
  ollama: 'ollama',
  'ollama-cloud': 'ollama',
  openai: 'openai',
  'openai-codex': 'codex-color',
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  openrouter: 'openrouter-color',
  qianfan: 'baiducloud-color',
  'qwen-portal': 'qwen-color',
  sakana: 'sakana-color',
  stepfun: 'stepfun-color',
  together: 'together-color',
  venice: 'venice-color',
  'vercel-ai-gateway': 'vercel',
  'wafer-serverless': 'wafer',
  xai: 'xai',
  'xai-oauth': 'xai',
  xiaomi: 'xiaomimimo',
  'xiaomi-token-plan-ams': 'xiaomimimo',
  'xiaomi-token-plan-cn': 'xiaomimimo',
  'xiaomi-token-plan-sgp': 'xiaomimimo',
  zai: 'zai',
  zenmux: 'zenmux',
  'zhipu-coding-plan': 'zhipu-color',
};

export function AuthProviderGlyph({ providerId, label, size = 'md' }: AuthProviderGlyphProps) {
  const logo = providerLogo[providerId];
  const words = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  const initials = words.length > 1
    ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
    : (words[0] ?? '?').slice(0, 2).toUpperCase();

  return (
    <span
      data-provider-glyph={providerId}
      aria-hidden="true"
      className={cn(
        'app-auth-provider-glyph grid shrink-0 place-items-center text-slate-400',
        size === 'sm' && 'h-9 w-9',
        size === 'md' && 'h-10 w-10',
        size === 'lg' && 'h-12 w-12',
      )}
    >
      {logo ? (
        <img
          src={`/provider-logos/${logo}.svg`}
          alt=""
          loading="lazy"
          className={cn('object-contain', size === 'sm' && 'h-[22px] w-[22px]', size === 'md' && 'h-6 w-6', size === 'lg' && 'h-7 w-7')}
        />
      ) : (
        <span className="text-[11px] font-semibold tracking-tight">{initials}</span>
      )}
    </span>
  );
}
