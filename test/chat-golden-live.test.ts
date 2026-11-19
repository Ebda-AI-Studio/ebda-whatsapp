import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GPT_OSS_MODEL, setAgentModelFlag } from '../src/core/ai/model-flag';
import type { Env } from '../src/env';
import { OpenAiCompatibleProvider, WorkersAiProvider, type AiBinding } from '../src/core/ai/provider';
import { CASES } from './eval/golden-cases';
import { runCase, scoreboard, type Verdict } from './eval/run';
import { useAgent } from './helpers/agent';
import { useStoreLink } from './helpers/store-link';

// The golden eval against a REAL model. It costs money, so it never runs in default CI: set CHAT_EVAL_LIVE=1 plus CHAT_EVAL_BASE_URL, CHAT_EVAL_API_KEY and
// CHAT_EVAL_MODEL (any OpenAI-compatible endpoint, e.g. Workers AI https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 with
// CHAT_EVAL_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast, the production model) in the shell, then:
//   CHAT_EVAL_LIVE=1 CHAT_EVAL_BASE_URL=... CHAT_EVAL_API_KEY=... CHAT_EVAL_MODEL=... npx vitest run test/chat-golden-live.test.ts
// Optional CHAT_EVAL_ONLY=<group> narrows the run, CHAT_EVAL_MIN=<0-1> makes it fail below a pass rate. The scoreboard is printed as one JSON line.
const e = env as unknown as Record<string, string | undefined>;
const LIVE = e.CHAT_EVAL_LIVE === '1' && !!e.CHAT_EVAL_BASE_URL && !!e.CHAT_EVAL_API_KEY && !!e.CHAT_EVAL_MODEL;
const realFetch = globalThis.fetch.bind(globalThis);

const link = useStoreLink();
const agent = useAgent();

describe.skipIf(!LIVE)('golden set against a real model (CHAT_EVAL_LIVE=1)', () => {
  it('scores every case with the rubric', async () => {
    const host = new URL(e.CHAT_EVAL_BASE_URL!).host;
    // Workers AI (the production path): the SAME WorkersAiProvider production runs, over a binding that calls the account's REST run endpoint (CHAT_EVAL_BASE_URL = .../accounts/<id>/ai/v1).
    const stats = { lat: [] as number[], inTok: 0, outTok: 0 };
    const reason = { calls: 0, length: 0, reasoningChars: 0, contentChars: 0 };
    let voidRun = ''; // set on the first 401/403 from the model endpoint: the run is aborted as VOID after the current case
    const calls: { id: string; ms: number; inTok: number; outTok: number; msgs: number; tools: number }[] = [];
    let curId = '';
    const restBinding: AiBinding = {
      async run(model, rawInputs) {
        // Until foundation fdn#100 is vendored, WorkersAiProvider sends content:null on tool-calling turns and Workers AI answers 400; coerce so the eval measures the MODEL.
        const inputs = { ...rawInputs, messages: (rawInputs.messages as { content: unknown }[]).map((m) => (m.content === null ? { ...m, content: '' } : m)) };
        const t0 = Date.now();
        // A per-minute inference limit (HTTP 429) is waited out so a slow-tier model is graded on its answers, not on the account's rate.
        let res!: Response;
        for (let attempt = 0; attempt < 6; attempt++) {
          res = await realFetch(`${e.CHAT_EVAL_BASE_URL!.replace(/\/v1\/?$/, '')}/run/${model}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.CHAT_EVAL_API_KEY!}` }, body: JSON.stringify(inputs) });
          if (res.status !== 429) break;
          await new Promise((r) => setTimeout(r, 15_000));
        }
        if (!res.ok) console.log(`CHAT_EVAL_SHAPE ${JSON.stringify({ model, tools: (rawInputs.tools as unknown[] | undefined)?.length ?? 0, max_tokens: rawInputs.max_tokens, messages: (inputs.messages as { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[]).map((m) => ({ role: m.role, len: typeof m.content === 'string' ? m.content.length : m.content === null ? null : 'x', calls: m.tool_calls?.length, id: m.tool_call_id ? 1 : undefined, name: m.name })) })}`); // request SHAPE only (roles, lengths, counts): no customer or model text, so no PII
        if (!res.ok) console.log(`CHAT_EVAL_HTTP ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
        if (res.status === 401 || res.status === 403) voidRun = `HTTP ${res.status}`; // the OAuth token expired mid-run: every later case would score as a provider error
        if (!res.ok) throw new Error(`workers-ai ${res.status} ${(await res.text()).slice(0, 200)}`);
        const result = ((await res.json()) as { result: { usage?: { prompt_tokens?: number; completion_tokens?: number } } }).result;
        const msg = (result as { choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string }[] })?.choices?.[0];
        reason.calls++; if (msg?.finish_reason === 'length') reason.length++;
        reason.reasoningChars += (msg?.message?.reasoning_content ?? msg?.message?.reasoning ?? '').length; reason.contentChars += (msg?.message?.content ?? '').length; // the provider reports the hidden reasoning as text, not as a token count: characters are the measure
        calls.push({ id: curId, ms: Date.now() - t0, inTok: result?.usage?.prompt_tokens ?? 0, outTok: result?.usage?.completion_tokens ?? 0, msgs: (inputs.messages as unknown[]).length, tools: (rawInputs.tools as unknown[] | undefined)?.length ?? 0 });
        stats.lat.push(Date.now() - t0); stats.inTok += result?.usage?.prompt_tokens ?? 0; stats.outTok += result?.usage?.completion_tokens ?? 0;
        return result;
      },
    };
    const make = () => host === 'api.cloudflare.com' ? new WorkersAiProvider(restBinding, e.CHAT_EVAL_MODEL!) : new OpenAiCompatibleProvider({ baseUrl: e.CHAT_EVAL_BASE_URL!, apiKey: e.CHAT_EVAL_API_KEY!, model: e.CHAT_EVAL_MODEL! });
    // A failing model call is logged (status + first 300 chars of the body) so a provider_error is never a mystery; the key is never printed.
    const other = (url: string, init: RequestInit | undefined) => {
      if (new URL(url).host !== host) return undefined;
      return realFetch(url, init).then(async (res) => {
        if (!res.ok) console.log(`CHAT_EVAL_HTTP ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
        return res;
      });
    };
    // Fail fast before spending anything: a one-token probe of the model endpoint (token expired = void run, not 78 failed cases).
    if (host === 'api.cloudflare.com') {
      const probe = await realFetch(`${e.CHAT_EVAL_BASE_URL!.replace(/\/v1\/?$/, '')}/run/${e.CHAT_EVAL_MODEL!}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.CHAT_EVAL_API_KEY!}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) });
      if (probe.status === 401 || probe.status === 403) { console.log(`CHAT_EVAL_VOID token rejected before the run (HTTP ${probe.status}): run wrangler whoami (or log in again) and rerun`); throw new Error('CHAT_EVAL_VOID: token rejected before the run'); }
    }
    const verdicts: Verdict[] = [];
    for (const [i, c] of CASES.entries()) {
      curId = c.id;
      if (e.CHAT_EVAL_ONLY && c.group !== e.CHAT_EVAL_ONLY) continue;
      if (e.CHAT_EVAL_ID && c.id !== e.CHAT_EVAL_ID) continue;
      // Production picks the gpt-oss prompt block, format strip and language check from the D1 flag `agent.model` (Ruling WA-MODEL-FLAG-1), NOT from the provider's model id: set it the way the operator does so the eval measures the path that ships.
      if (e.CHAT_EVAL_MODEL === GPT_OSS_MODEL) await setAgentModelFlag(env as unknown as Env, { model: GPT_OSS_MODEL, actor: 'eval', reason: 'live golden eval' });
      const v = await runCase(c, { fake: link.fake, agent, other }, i, make);
      console.log(`CHAT_EVAL_CASE ${JSON.stringify({ id: v.id, pass: v.pass, outcome: v.run.outcome, reply: v.run.replies.join(' | ').slice(0, 160) })}`);
      if (!v.pass) console.log(`CHAT_EVAL_FAIL ${JSON.stringify({ id: v.id, failed: v.failed, outcome: v.run.outcome, tools: v.run.tools.map((t) => t.name), modelTexts: (v.run.modelTexts ?? []).map((x) => x.slice(0, 700)), reply: v.run.replies.join(' | ').slice(0, 200) })}`);
      verdicts.push(v);
      if (voidRun) { console.log(`CHAT_EVAL_VOID token expired (${voidRun}) during case ${v.id}: run VOID, nothing below is a model result. Refresh the token (wrangler whoami) and rerun.`); throw new Error('CHAT_EVAL_VOID: token expired mid-run'); }
    }
    const board = scoreboard(verdicts);
    const l = [...stats.lat].sort((a, b) => a - b);
    console.log(`CHAT_EVAL_REASONING ${JSON.stringify({ ...reason, reasoningShareOfText: Number((reason.reasoningChars / Math.max(1, reason.reasoningChars + reason.contentChars)).toFixed(3)) })}`); // length = calls that stopped at the token cap
    console.log(`CHAT_EVAL_SLOW ${JSON.stringify([...calls].sort((a, b) => b.ms - a.ms).slice(0, 10))}`); // the ten slowest model calls: which case, how long, how big (messages = tool round-trips so far)
    console.log(`CHAT_EVAL_STATS ${JSON.stringify({ calls: l.length, p50: l[Math.floor(l.length * 0.5)], p95: l[Math.floor(l.length * 0.95)], inTok: stats.inTok, outTok: stats.outTok })}`);
    console.log(`CHAT_EVAL_SCOREBOARD ${JSON.stringify({ model: e.CHAT_EVAL_MODEL, ...board })}`);
    expect(board.rate).toBeGreaterThanOrEqual(Number(e.CHAT_EVAL_MIN ?? 0));
  }, 3_600_000);
});

describe('live eval wiring', () => {
  it('is off unless the flag AND all three settings are present (default CI sets none of them)', () => {
    if (!e.CHAT_EVAL_LIVE) expect(LIVE).toBe(false);
    if (e.CHAT_EVAL_LIVE === '1' && !(e.CHAT_EVAL_BASE_URL && e.CHAT_EVAL_API_KEY && e.CHAT_EVAL_MODEL)) expect(LIVE).toBe(false);
  });
});
