import { CASES, type Case, type Expect } from './golden-cases';
import { applyPreset } from './store';
import { type LlmProvider, type LlmRequest, type LlmResponse } from '../../src/core/ai/provider';
import { runInDurableObject } from 'cloudflare:test';
import { RECS_PER_DAY } from '../../src/core/ai/recommend';
import { ScriptedProvider } from '../helpers/agent';
import { agentWorkspace, say, text } from '../helpers/agent-chat';
import { stubGraph } from '../helpers/graph';
import type { FakeStore } from '../helpers/fake-store';
import { rows, workspace } from '../helpers/workspace';

/** Records every tool call a model asked for, and every product the Store let a turn SHOW (what the rubric inspects), whatever model sits behind it. */
export class Recorder implements LlmProvider {
  readonly tools: { name: string; args: unknown }[] = [];
  /** Products a show_products / recommend_products result carried (cards or text hits), with the price the customer saw, in store currency units. */
  readonly shown: { id: string; price: number }[] = [];
  /** Every text the model itself produced, in order (the guard may have replaced the last one with a handoff: this keeps what it TRIED to say). */
  readonly texts: string[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly inner: LlmProvider) {}
  get byoKey() { return this.inner.byoKey; }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    for (const m of req.messages) {
      if (m.role !== 'tool' || (m.name !== 'show_products' && m.name !== 'recommend_products') || this.seen.has(m.toolCallId)) continue;
      this.seen.add(m.toolCallId);
      try {
        const out = JSON.parse(m.content) as { products?: { id: string; price: number }[]; without_card?: { id: string; price: number }[] };
        for (const p of [...(out.products ?? []), ...(out.without_card ?? [])]) if (typeof p.price === 'number') this.shown.push({ id: p.id, price: p.price });
      } catch { /* not JSON: nothing shown */ }
    }
    let out: LlmResponse;
    try { out = await this.inner.complete(req); } catch (err) { console.log(`CHAT_EVAL_PROVIDER_ERR ${JSON.stringify({ name: err instanceof Error ? err.name : typeof err, msg: err instanceof Error ? err.message.slice(0, 160) : '', roles: req.messages.map((m) => m.role) })}`); throw err; } // roles + the platform's error text only: no customer text
    for (const t of out.toolCalls ?? []) this.tools.push({ name: t.name, args: t.arguments });
    if (out.text) this.texts.push(out.text);
    return out;
  }
}

export type Run = { replies: string[]; outcome: string; tools: { name: string; args: unknown }[]; /** Products shown in the graded turn (default: none). */ shown?: { id: string; price: number }[]; /** What the model said in the graded turn, even if the reply guard refused it (diagnostics only, never graded). */ modelTexts?: string[] };
export type Verdict = { id: string; pass: boolean; failed: string[]; run: Run };

const arabicShare = (s: string) => { const l = [...s].filter((ch) => /\p{L}/u.test(ch)); return l.length ? l.filter((ch) => /[؀-ۿ]/.test(ch)).length / l.length : 0; };
/** Outcomes that mean the agent could not do its job (a person was paged for the wrong reason). A deliberate handoff is `handoff:model` / `handoff:asked`. */
const BROKEN = /^handoff:(guarded|provider_error|no_answer|bad_output|misconfigured|no_credits|turn_cap)$/;

/** The rubric: deterministic checks, no judge model. */
export function grade(c: Case, run: Run): string[] {
  const failed: string[] = [];
  const e: Expect = c.expect;
  const said = run.replies.join('\n');
  if (run.outcome === 'handoff:guarded') failed.push('invented_fact'); // the reply guard refused a price, fee, link or promise no tool vouched for
  else if (BROKEN.test(run.outcome)) failed.push(`broken:${run.outcome}`);
  if (e.handoff === true && !/^handoff:(model|asked)$/.test(run.outcome)) failed.push('no_handoff');
  if (e.handoff === false && run.outcome !== 'reply' && run.outcome !== 'order') failed.push('handed_off_needlessly');
  for (const t of e.tools ?? []) if (!run.tools.some((x) => x.name === t)) failed.push(`missing_tool:${t}`);
  // Ruling GIFT-BUDGET-TOOL-1: a budget ask is graded on its OUTCOME, so either product tool may serve it.
  if (e.toolsAny && !run.tools.some((x) => e.toolsAny!.includes(x.name))) failed.push(`missing_tool:${e.toolsAny.join('|')}`);
  if (e.noTools && run.tools.length) failed.push('used_tools_off_topic');
  if (e.searchMaxPrice !== undefined) {
    const budget = e.searchMaxPrice;
    const carries = (x: { name: string; args: unknown }) => (x.args as { maxPrice?: number })?.maxPrice === budget;
    if (!run.tools.some((x) => (x.name === 'search_catalog' && carries(x)) || (x.name === 'recommend_products' && (x.args as { basis?: string })?.basis === 'budget' && carries(x)))) failed.push('budget_not_used');
    // ANY card or price shown above the budget is a money failure (CHAT-EVAL-BAR-1 hard gate "no invented money/promise facts").
    if ((run.shown ?? []).some((p) => p.price > budget)) failed.push('over_budget_shown');
    // An explicit ask must not end with nothing shown (a rationed or empty recommendation must fall back to the search).
    if (run.outcome === 'reply' && !(run.shown ?? []).length) failed.push('gave_up_on_explicit_ask');
  }
  if (e.script === 'ar' && arabicShare(said) < 0.5) failed.push('wrong_script');
  if (e.script === 'en' && arabicShare(said) > 0.1) failed.push('wrong_script');
  for (const re of e.mention ?? []) if (!re.test(said)) failed.push(`missing:${re.source}`);
  for (const re of e.avoid ?? []) if (re.test(said)) failed.push(`forbidden:${re.source}`);
  return failed;
}

export type Env = { fake: FakeStore; agent: { model: LlmProvider }; /** Lets a live run's model calls through the Graph stub (a real fetch for the model host only). */ other?: (url: string, init: RequestInit | undefined) => Promise<Response> | Response | undefined };

/**
 * Puts the customer at the daily recommendation limit (RECS_PER_DAY sets in the last 24 h) the way real turns would leave them: two scripted greetings create the contact, conversation and
 * messages, then one `recs:<message id>` ration row is written per set. The real model is not involved, so a live run starts from the same exhausted state.
 */
async function exhaustRation(ws: string, pn: string, env: Env, g: ReturnType<typeof stubGraph>): Promise<void> {
  env.agent.model = new ScriptedProvider([{ text: 'أهلاً بيك' }, { text: 'تحت أمرك' }]);
  await say(ws, pn, text('أهلاً'), g);
  await say(ws, pn, text('السلام عليكم'), g);
  await runInDurableObject(workspace(ws), (_i, state) => {
    const ids = state.storage.sql.exec<{ id: number }>('SELECT m.id FROM messages m ORDER BY m.id LIMIT ?', RECS_PER_DAY).toArray().map((r) => r.id);
    if (ids.length < RECS_PER_DAY) throw new Error(`exhaustRation: only ${ids.length} messages to hang the ration on`);
    for (const id of ids) state.storage.sql.exec('INSERT INTO agent_state (key, value) VALUES (?, ?)', `recs:${id}`, JSON.stringify({ at: Date.now(), ids: [] }));
  });
}

/** Runs one case in its own workspace: earlier turns are sent first, the LAST turn is what is graded. `makeModel` builds the model for the case. */
export async function runCase(c: Case, env: Env, n: number, makeModel: (c: Case) => LlmProvider): Promise<Verdict> {
  applyPreset(env.fake, c.store);
  const ws = `00000000-0000-4000-8000-00000000${String(7600 + n).padStart(4, '0')}`;
  const pn = await agentWorkspace(ws, { language: 'auto' });
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'eval', credits: 1000 });
  const g = stubGraph(undefined, { other: env.other }); // ONE Graph stub per case: a second one would restart the outgoing message ids and collide on messages.wamid
  if (c.rationed) await exhaustRation(ws, pn, env, g);
  const rec = new Recorder(makeModel(c));
  env.agent.model = rec;
  let replies: string[] = [];
  let before = 0;
  let shownBefore = 0;
  let textsBefore = 0;
  for (const turn of c.turns) {
    before = rec.tools.length;
    shownBefore = rec.shown.length;
    textsBefore = rec.texts.length;
    replies = (await say(ws, pn, text(turn), g)).map((s) => s.text ?? '').filter(Boolean);
  }
  const outcome = (await rows<{ outcome: string }>(ws, 'SELECT outcome FROM agent_turns ORDER BY rowid DESC LIMIT 1'))[0]?.outcome ?? 'none';
  g.restore();
  const run: Run = { replies, outcome, tools: rec.tools.slice(before), shown: rec.shown.slice(shownBefore), modelTexts: rec.texts.slice(textsBefore) };
  const failed = grade(c, run);
  return { id: c.id, pass: failed.length === 0, failed, run };
}

export const scriptedModel = (c: Case): LlmProvider => new ScriptedProvider(c.scripted.map((s) => ({ ...(s.text !== undefined ? { text: s.text } : {}), ...(s.tools ? { tools: s.tools } : {}) })));

export type Scoreboard = { total: number; passed: number; rate: number; byGroup: Record<string, { total: number; passed: number }>; failures: { id: string; failed: string[] }[] };
export function scoreboard(vs: Verdict[]): Scoreboard {
  const byGroup: Scoreboard['byGroup'] = {};
  for (const v of vs) {
    const g = CASES.find((x) => x.id === v.id)!.group;
    byGroup[g] ??= { total: 0, passed: 0 };
    byGroup[g]!.total++;
    if (v.pass) byGroup[g]!.passed++;
  }
  const passed = vs.filter((v) => v.pass).length;
  return { total: vs.length, passed, rate: vs.length ? passed / vs.length : 0, byGroup, failures: vs.filter((v) => !v.pass).map((v) => ({ id: v.id, failed: v.failed })) };
}
