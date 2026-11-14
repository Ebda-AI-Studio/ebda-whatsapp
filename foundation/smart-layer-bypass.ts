import { createHash } from 'node:crypto';
import type { GuardConfig, Violation } from './capability';
import { stripComments } from './guards';

// Written so no pattern source matches itself: this file is vendored into products and scanned there.
// Detection is by import form + host + binding name, never by a bare package-name substring.

/** Provider SDK packages. Matched only in import forms (from 'x', require('x'), import('x')); `@ai-sdk/*` is any scoped sub-package. */
const SDK_MODULES = ['openai', '@anthropic-ai/sdk', '@google/genai', '@google/generative-ai', '@google-cloud/vertexai', 'groq-sdk', 'together-ai', '@mistralai/mistralai', 'cohere-ai', '@aws-sdk/client-bedrock-runtime', 'workers-ai-provider', 'ai'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const SDK_IMPORT = new RegExp(`(?:\\bfrom\\s+|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*)['"\`](?:${SDK_MODULES.map(esc).join('|')}|@ai-sdk\\/[\\w.-]+)['"\`]`);

export const MODEL_CALL_PATTERNS: readonly { name: string; re: RegExp }[] = [
  // Workers AI binding: env.AI, env["AI"], const { AI } = env / c.env, and the .run call
  { name: 'workers-ai', re: /\benv\.AI\b|\.AI\.run\(|\benv\s*\[\s*['"]AI['"]\s*\]|\{[^}]*\bAI\b[^}]*\}\s*=\s*[\w.]*\benv\b/ },
  { name: 'provider-sdk-import', re: SDK_IMPORT },
  { name: 'cloudflare-ai-gateway', re: /gateway\.ai\.cloudflare\.com/ },
  { name: 'gemini-rest', re: /generativelanguage\.googleapis\.com/ },
  { name: 'vertex-rest', re: /aiplatform\.googleapis\.com/ },
  { name: 'openai-rest', re: /api\.openai\.com/ },
  { name: 'anthropic-rest', re: /api\.anthropic\.com/ },
  { name: 'openrouter-rest', re: /openrouter\.ai/ },
  { name: 'groq-rest', re: /api\.groq\.com/ },
  { name: 'mistral-rest', re: /api\.mistral\.ai/ },
  { name: 'cohere-rest', re: /api\.cohere\.(?:com|ai)/ },
  { name: 'together-rest', re: /api\.together\.(?:xyz|ai)/ },
  { name: 'bedrock-rest', re: /bedrock-runtime\./ },
];
const WRANGLER_AI_JSON = { name: 'wrangler-ai-binding', re: /"ai"\s*:\s*\{/ };
const WRANGLER_AI_TOML = { name: 'wrangler-ai-binding', re: /^\[ai\]/ };

/**
 * Exempt only files that are tests BY NAME or by the jest convention dirs: *.test.*, *.spec.*, .d.ts, __tests__/, __mocks__/.
 * A directory called test/, tests/, e2e/ or fixtures/ under src/ is NOT exempt: production code can live there.
 */
const skipped = (p: string): boolean => /\.d\.ts$/.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /(?:^|\/)(?:__tests__|__mocks__)\//.test(p);
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** Direct model calls outside the Smart Layer (192.6). Keys are content hashes, never line numbers, so unrelated edits do not churn the baseline. */
export function checkModelBypass(files: { path: string; src: string }[], cfg: Pick<GuardConfig, 'smartLayerPaths'>): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (skipped(f.path) || cfg.smartLayerPaths.some((p) => f.path.startsWith(p))) continue;
    const patterns = /(?:^|\/)wrangler\.jsonc?$/.test(f.path) ? [...MODEL_CALL_PATTERNS, WRANGLER_AI_JSON] : /(?:^|\/)wrangler\.toml$/.test(f.path) ? [...MODEL_CALL_PATTERNS, WRANGLER_AI_TOML] : MODEL_CALL_PATTERNS;
    const seen = new Map<string, number>();
    for (const line of stripComments(f.src).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      for (const p of patterns) {
        if (!p.re.test(t)) continue;
        const base = `${f.path}|${p.name}|${sha(t)}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.push({ rule: 'model-call-outside-smart-layer', key: `${base}|${n}`, message: `${f.path}: direct model call (${p.name}) outside the Smart Layer` });
      }
    }
  }
  return out;
}
