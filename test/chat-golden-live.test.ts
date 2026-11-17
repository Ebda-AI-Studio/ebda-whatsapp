import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
    const restBinding: AiBinding = {
      async run(model, rawInputs) {
        // Until foundation fdn#100 is vendored, WorkersAiProvider sends content:null on tool-calling turns and Workers AI answers 400; coerce so the eval measures the MODEL.
        const inputs = { ...rawInputs, messages: (rawInputs.messages as { content: unknown }[]).map((m) => (m.content === null ? { ...m, content: '' } : m)) };
        const res = await realFetch(`${e.CHAT_EVAL_BASE_URL!.replace(/\/v1\/?$/, '')}/run/${model}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.CHAT_EVAL_API_KEY!}` }, body: JSON.stringify(inputs) });
        if (!res.ok) console.log(`CHAT_EVAL_HTTP ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
        if (!res.ok) throw new Error(`workers-ai ${res.status} ${(await res.text()).slice(0, 200)}`);
        return ((await res.json()) as { result: unknown }).result;
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
    const verdicts: Verdict[] = [];
    for (const [i, c] of CASES.entries()) {
      if (e.CHAT_EVAL_ONLY && c.group !== e.CHAT_EVAL_ONLY) continue;
      const v = await runCase(c, { fake: link.fake, agent, other }, i, make);
      if (!v.pass) console.log(`CHAT_EVAL_FAIL ${JSON.stringify({ id: v.id, failed: v.failed, outcome: v.run.outcome, tools: v.run.tools.map((t) => t.name), reply: v.run.replies.join(' | ').slice(0, 200) })}`);
      verdicts.push(v);
    }
    const board = scoreboard(verdicts);
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
