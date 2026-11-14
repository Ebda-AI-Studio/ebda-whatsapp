/**
 * Versioned prompt + tool config and the release id (plan 4 Task A11, gap 9). `computeReleaseId` hashes everything that changes what
 * the assistant does (system prompt, each tool's name / description / policy / undo, the model routing, the budget) so a turn, an audit
 * row and an eval run can all name the exact configuration that produced them. Hashing is `crypto.subtle` (Workers + Node 20).
 */
import { BUDGET } from './plan/budget';
import type { ModelRouting } from './models';
import { FENCE_RULE } from './rails/fence';
import type { Locale, ToolSpec } from './types';

export const PROMPT_VERSION = 'sl-prompt-1';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const COMMON = [
  'You are the in-product assistant for merchants. Always call the products by their full names ("Ebda Store", "Ebda Chat"), never shortened to the brand alone. Never mention the infrastructure or the model that runs you.',
  'You can answer how-to questions from the help articles you are given and call the tools you are offered. A change to the merchant data only ever happens through a preview the merchant approves in the app: never say or imply that something was changed, sent, deleted or paid unless a tool result in this conversation says it was applied.',
  FENCE_RULE,
  'Point to a screen only with [[cap:<capability id>]] and to a help article only with [[help:<article id>]], using ids you were given. Never write app paths, URLs of your own, or quote button names in « » or quotation marks.',
  'Never ask for, accept, repeat or forward a password, one-time code, card number, API key or token. If the merchant needs to enter one, point to the secure screen with [[cap:...]] and do the rest of the task without it.',
  'Never state a price, a fee, a percentage, a duration, a plan name or a refund / legal term unless it comes from a tool result or a help article you were given in this turn.',
  'Keep replies short (a few sentences or a numbered list of steps).',
].join('\n');

const REGISTER: Record<Locale, string> = {
  ar: 'اكتب بالعربي المصري في جمل كاملة وبسيطة ("هتلاقيه في صفحة الكوبونات"، "دوس على إضافة")، مش بالفصحى الرسمية ومن غير "يرجى" أو "سوف". ابدأ دايمًا بالعربي.',
  en: 'Reply in plain, friendly English.',
};

export function buildSystemPrompt(locale: Locale): string {
  return `[${PROMPT_VERSION}]\n${COMMON}\n${REGISTER[locale]}`;
}

export async function computeReleaseId(parts: {
  systemPrompt: string;
  tools: Array<Pick<ToolSpec, 'name' | 'description' | 'policy' | 'undo'>>;
  models: ModelRouting;
  budget: typeof BUDGET;
}): Promise<string> {
  const tools = parts.tools.map((t) => ({ name: t.name, description: t.description, policy: t.policy, undo: t.undo })).sort((a, b) => a.name.localeCompare(b.name));
  return (await sha256Hex(canonicalJson({ systemPrompt: parts.systemPrompt, tools, models: parts.models, budget: parts.budget }))).slice(0, 12);
}
