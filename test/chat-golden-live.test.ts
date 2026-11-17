import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/core/ai/provider';
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
    const make = () => new OpenAiCompatibleProvider({ baseUrl: e.CHAT_EVAL_BASE_URL!, apiKey: e.CHAT_EVAL_API_KEY!, model: e.CHAT_EVAL_MODEL! });
    const other = (url: string, init: RequestInit | undefined) => (new URL(url).host === host ? realFetch(url, init) : undefined);
    const verdicts: Verdict[] = [];
    for (const [i, c] of CASES.entries()) {
      if (e.CHAT_EVAL_ONLY && c.group !== e.CHAT_EVAL_ONLY) continue;
      verdicts.push(await runCase(c, { fake: link.fake, agent, other }, i, make));
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
