import { CASES, type Case, type Expect } from './golden-cases';
import { applyPreset } from './store';
import { type LlmProvider, type LlmRequest, type LlmResponse } from '../../src/core/ai/provider';
import { ScriptedProvider } from '../helpers/agent';
import { agentWorkspace, say, text } from '../helpers/agent-chat';
import { stubGraph } from '../helpers/graph';
import type { FakeStore } from '../helpers/fake-store';
import { rows, workspace } from '../helpers/workspace';

/** Records every tool call a model asked for (what the rubric inspects), whatever model sits behind it. */
export class Recorder implements LlmProvider {
  readonly tools: { name: string; args: unknown }[] = [];
  constructor(private readonly inner: LlmProvider) {}
  get byoKey() { return this.inner.byoKey; }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const out = await this.inner.complete(req);
    for (const t of out.toolCalls ?? []) this.tools.push({ name: t.name, args: t.arguments });
    return out;
  }
}

export type Run = { replies: string[]; outcome: string; tools: { name: string; args: unknown }[] };
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
  if (e.noTools && run.tools.length) failed.push('used_tools_off_topic');
  if (e.searchMaxPrice !== undefined && !run.tools.some((x) => x.name === 'search_catalog' && (x.args as { maxPrice?: number })?.maxPrice === e.searchMaxPrice)) failed.push('budget_not_used');
  if (e.script === 'ar' && arabicShare(said) < 0.5) failed.push('wrong_script');
  if (e.script === 'en' && arabicShare(said) > 0.1) failed.push('wrong_script');
  for (const re of e.mention ?? []) if (!re.test(said)) failed.push(`missing:${re.source}`);
  for (const re of e.avoid ?? []) if (re.test(said)) failed.push(`forbidden:${re.source}`);
  return failed;
}

export type Env = { fake: FakeStore; agent: { model: LlmProvider }; /** Lets a live run's model calls through the Graph stub (a real fetch for the model host only). */ other?: (url: string, init: RequestInit | undefined) => Promise<Response> | Response | undefined };

/** Runs one case in its own workspace: earlier turns are sent first, the LAST turn is what is graded. `makeModel` builds the model for the case. */
export async function runCase(c: Case, env: Env, n: number, makeModel: (c: Case) => LlmProvider): Promise<Verdict> {
  applyPreset(env.fake, c.store);
  const ws = `00000000-0000-4000-8000-00000000${String(7600 + n).padStart(4, '0')}`;
  const pn = await agentWorkspace(ws, { language: 'auto' });
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'eval', credits: 1000 });
  const rec = new Recorder(makeModel(c));
  env.agent.model = rec;
  const g = stubGraph(undefined, { other: env.other });
  let replies: string[] = [];
  let before = 0;
  for (const turn of c.turns) {
    before = rec.tools.length;
    replies = (await say(ws, pn, text(turn), g)).map((s) => s.text ?? '').filter(Boolean);
  }
  const outcome = (await rows<{ outcome: string }>(ws, 'SELECT outcome FROM agent_turns ORDER BY rowid DESC LIMIT 1'))[0]?.outcome ?? 'none';
  g.restore();
  const run: Run = { replies, outcome, tools: rec.tools.slice(before) };
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
