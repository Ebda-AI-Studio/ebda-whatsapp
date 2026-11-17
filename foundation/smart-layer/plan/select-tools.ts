/**
 * Planning rail 5: tool retrieval (plan 4 Task A6). The model never sees the whole catalogue (185 / 172 capabilities): per turn it is
 * offered at most 15 tools, chosen by lexical overlap of the (Franco-folded) question with the capability title, its example questions
 * and the tool description, plus optional vector scores. A tool is dropped when its capability is not `live`, is `forbidden`, is not in
 * the registry at all, or is killed; `answer-only` keeps only `free`; untrusted content in context keeps only `free` (plus `always`).
 */
import { indexTokens } from '../../text';
import { francoToArabic } from '../rails/franco';
import { strongerPolicy } from '../exec/policy';
import type { Mode, RegistryView, ToolSpec } from '../types';

export interface SelectOpts {
  max?: number;
  always?: string[];
  mode: Mode;
  untrustedInContext: boolean;
  vectorScores?: Map<string, number>;
  killed?: ReadonlySet<string>;
}
export const MAX_TOOLS = 15;
const DEFAULT_ALWAYS = ['help_search', 'show_me_where'];
const STOP = new Set(['ازاي', 'عايز', 'عايزه', 'اعمل', 'اضيف', 'على', 'علي', 'في', 'من', 'ده', 'دي', 'انا', 'ان', 'هو', 'هي', 'the', 'a', 'an', 'to', 'do', 'i', 'how', 'my', 'is', 'of', 'and', 'for', 'ال', 'او', 'مش', 'عن', 'مع']);

const tokens = (s: string): string[] => indexTokens(francoToArabic(s)).split(' ').map((t) => t.replace(/^(?:وال|بال|لل|ال)/, '')).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
const matches = (q: string, d: string): boolean => q === d || (q.length >= 3 && d.length >= 3 && (d.startsWith(q) || q.startsWith(d)));

export function selectTools(q: string, tools: ToolSpec[], reg: RegistryView, o: SelectOpts): ToolSpec[] {
  if (o.mode === 'off') return [];
  const max = Math.min(o.max ?? MAX_TOOLS, MAX_TOOLS);
  const always = new Set(o.always ?? DEFAULT_ALWAYS);
  const qt = [...new Set(tokens(q))];
  const eligible = tools.filter((t) => {
    const cap = reg.caps.get(t.capabilityId);
    if (!cap || cap.status !== 'live' || cap.policy === 'forbidden') return false;
    if (strongerPolicy(t.policy, cap.policy) !== t.policy) return false; // the tool declares less than the registry demands: drift fails closed, never open
    if (o.killed?.has(t.name)) return false;
    if (o.mode === 'answer-only' && t.policy !== 'free') return false;
    if (o.untrustedInContext && t.policy !== 'free') return false;
    return true;
  });
  const scored = eligible.map((t) => {
    const cap = reg.caps.get(t.capabilityId)!;
    const doc = new Set(tokens([cap.title.ar, cap.title.en, ...cap.examples, t.description, t.name.replace(/_/g, ' ')].join(' ')));
    let score = 0;
    for (const w of qt) for (const d of doc) if (matches(w, d)) { score++; break; }
    score += (o.vectorScores?.get(t.name) ?? 0) * 3;
    return { t, score };
  });
  const pinned = scored.filter((s) => always.has(s.t.name));
  const rest = scored.filter((s) => !always.has(s.t.name) && s.score > 0).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  // Relevant tools first; the pinned helpers are always kept (they take their slots before the cut).
  return [...rest.slice(0, Math.max(0, max - pinned.length)).map((s) => s.t), ...pinned.slice(0, max).map((s) => s.t)];
}
