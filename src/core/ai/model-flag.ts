/**
 * Ruling WA-MODEL-FLAG-1: the platform's agent model is a flag with exactly two allowed values. Unset = the current default (nothing below changes
 * for it, byte for byte). `@cf/openai/gpt-oss-120b` additionally switches on the WhatsApp format strip, the English-ask language check and the
 * stricter Egyptian prompt block. The flag lives in D1 `platform_flags` (key `agent.model`) so it flips and reverts without a deploy.
 *
 * Staleness class: NEVER-stale (an operator kill-switch style flag): read from D1 on every AI turn, no cache. An unreadable or unrecognised value
 * falls back to the default model (the proven path), never to the new one.
 */
import type { Env } from '../../env';
import { PLATFORM_WORKSPACE, billingAudit } from '../audit-reason';
import { alert, errClass } from '../observability';
import { isPlainEnglish } from '../franco';
import { DEFAULT_WORKERS_AI_MODEL } from './config';

export const GPT_OSS_MODEL = '@cf/openai/gpt-oss-120b';
/** The ONLY ids the flag accepts. */
export const AGENT_MODEL_IDS = [DEFAULT_WORKERS_AI_MODEL, GPT_OSS_MODEL] as const;
export type AgentModelId = (typeof AGENT_MODEL_IDS)[number];
export const AGENT_MODEL_FLAG_KEY = 'agent.model';

export const isAgentModelId = (v: unknown): v is AgentModelId => typeof v === 'string' && (AGENT_MODEL_IDS as readonly string[]).includes(v);
/** The flagged path (format strip, language check, strict prompt) is on for this model id. */
export const isFlaggedModel = (id: string | null | undefined): boolean => id === GPT_OSS_MODEL;

/** The flag as stored, or null (unset, unreadable or not on the allow-list: all mean "the default"). */
export async function readAgentModelFlag(env: Pick<Env, 'DB'>): Promise<AgentModelId | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM platform_flags WHERE key = ?').bind(AGENT_MODEL_FLAG_KEY).first<{ value: string }>();
    if (!row) return null;
    const v: unknown = JSON.parse(row.value);
    return isAgentModelId(v) ? v : null;
  } catch (err) {
    alert('agent_model_flag_unreadable', { error: errClass(err) });
    return null;
  }
}

export type ModelFlagResult = { ok: true; model: AgentModelId | null } | { ok: false; reason: 'model_not_allowed' | 'reason_required' };

/** Sets (an allow-listed id) or clears (null = back to the default) the flag; every change is audited with its reason (AUDIT-REASONS-1). */
export async function setAgentModelFlag(env: Env, a: { model: string | null; actor: string; reason: string }, now = Date.now()): Promise<ModelFlagResult> {
  if (a.model !== null && !isAgentModelId(a.model)) return { ok: false, reason: 'model_not_allowed' };
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  const before = await readAgentModelFlag(env);
  if (a.model === null) await env.DB.prepare('DELETE FROM platform_flags WHERE key = ?').bind(AGENT_MODEL_FLAG_KEY).run();
  else {
    await env.DB.prepare('INSERT INTO platform_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .bind(AGENT_MODEL_FLAG_KEY, JSON.stringify(a.model), now, a.actor).run();
  }
  await billingAudit(env, { at: now, actor: a.actor, action: 'agent_model_set', workspaceId: PLATFORM_WORKSPACE, before: { model: before }, after: { model: a.model }, reason });
  return { ok: true, model: a.model };
}

// ---- WhatsApp formatting (flagged path only) ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>]*[^\s<>*.,;:!?)\]،؛؟]/g;

/**
 * Turns the Markdown a model likes to write into what WhatsApp renders. Pure. Every URL survives unchanged (the reply guard checks links after this).
 * `**x**` -> `*x*`, `~~x~~` -> `~x~`, `# heading` -> `heading`, `- x` / `* x` / `+ x` lists -> `• x`, `[text](url)` -> `text url` (just `url` when the text is the url),
 * rules (`---`) dropped. A single `*x*` (WhatsApp bold), `_x_` and numbered lists are left alone. Arabic / RTL text is untouched.
 */
export function whatsappFormat(input: string): string {
  let t = input.replace(/\r\n?/g, '\n');
  // links first: the target must stay visible as a bare URL
  t = t.replace(/!?\[([^\]\n]*)\]\(\s*([^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g, (_m, label: string, url: string) => {
    const l = label.trim();
    return !l || l === url ? url : `${l} ${url}`;
  });
  // protect URLs while emphasis is rewritten
  const urls: string[] = [];
  t = t.replace(URL_RE, (u) => `\u0000${urls.push(u) - 1}\u0000`);
  t = t.replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '*$1*');
  t = t.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '*$1*');
  t = t.replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~');
  t = t
    .split('\n')
    .flatMap((line) => {
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return []; // horizontal rule
      return [line.replace(/^(\s{0,3})#{1,6}[ \t]+/, '$1').replace(/^(\s*)[-*+][ \t]+/, '$1• ')];
    })
    .join('\n');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ---- reply language (flagged path only) --------------------------------------------------------------------------------

const ARABIC_LETTER = /[ء-يٱ-ۓ]/g;
const LATIN_LETTER = /[A-Za-z]/g;
/** An Arabic-script reply: more Arabic letters than Latin ones (a quoted Arabic product name inside an English answer does not count). */
export const isArabicScriptReply = (text: string): boolean => (text.match(ARABIC_LETTER)?.length ?? 0) > (text.match(LATIN_LETTER)?.length ?? 0);

export const LANGUAGE_RETRY_NOTE = 'Your last reply was in Arabic, but the customer wrote in English. Write the same reply again in English only: plain text, short, no markdown. Do not call any tool.';

export const EMPTY_RETRY_NOTE = 'Answer the customer now in one short reply, using the tool results above. Do not call any tool.';

/**
 * Is the customer's message real English (not Franco-Arabic the heuristic missed, such as "fe shanta gel bony?" or "ektebly code python")? The language correction fires only for
 * these: Latin letters only, not Franco, AND at least one common English function word. A Latin-only message without one is left alone (an Arabic reply to it is right).
 */
const ENGLISH_WORDS = new Set(['i', 'a', 'the', 'is', 'are', 'do', 'does', 'you', 'your', 'have', 'has', 'any', 'for', 'my', 'me', 'to', 'of', 'what', 'how', 'can', 'could', 'need', 'want', 'where', 'when', 'which', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'with', 'this', 'that', 'it', 'and', 'or', 'not', 'there', 'would', 'will', 'about', 'under', 'over', 'around', 'much', 'many']);
export const looksEnglishAsk = (text: string | null | undefined): boolean => isPlainEnglish(text) && (text ?? '').toLowerCase().split(/[^a-z]+/).some((w) => ENGLISH_WORDS.has(w));
