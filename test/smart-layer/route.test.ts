import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import type { HelpDeps } from '../../src/core/smart-layer/help-index';
import { apiFor, apiKey, storeId, useApiKey } from '../helpers/api';
import { mint } from '../helpers/issuer';
import { gateForRoute } from '../../src/core/identity/scopes';
import { rows, workspace } from '../helpers/workspace';
import { rpcStorage } from '../../src/core/smart-layer/storage-do';

useApiKey();

type Msg = { content?: string };
/** A Workers AI binding that answers from a script: the classifier call gets a fixed in-scope JSON, every other call the next scripted OpenAI-shaped reply. */
function scriptedAi(script: Array<{ text?: string; call?: { name: string; args: unknown } }>) {
  const calls: Array<{ model: string; system: string }> = [];
  let i = 0;
  return {
    calls,
    ai: {
      run: async (model: string, inputs: Record<string, unknown>) => {
        const system = ((inputs.messages as Msg[])[0]?.content ?? '') as string;
        calls.push({ model, system });
        if (system.includes('Classify the merchant message')) return { choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        const s = script[Math.min(i++, script.length - 1)]!;
        return { choices: [{ message: { content: s.text ?? null, ...(s.call ? { tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.call.name, arguments: JSON.stringify(s.call.args) } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    },
  };
}
const helpHits = (hits: Array<{ articleId: string; score: number; locale?: string }>): HelpDeps => ({
  db: env.DB,
  embed: async (t) => t.map(() => [0]),
  vectors: { upsert: async () => ({ mutationId: 'm' }), deleteByIds: async () => ({ mutationId: 'm' }), query: async () => ({ count: hits.length, matches: hits.map((h) => ({ id: h.articleId, score: h.score, metadata: { articleId: h.articleId, locale: h.locale ?? 'ar', title: 'محفظة واشتراك', url: 'https://help.ebda.app/whatsapp/wallet-top-ups-and-refunds/', appPath: '', text: 'المحفظة بتدفع رسوم Meta. تقدر تشحنها من شاشة المحفظة.' } })) }) } as never,
});

const U = { owner: '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f', other: '7a2e3d2f-9b9f-4b4c-8a2f-2b3c4d5e6f70' };
const post = (store: string, token: string | null, path: string, body: unknown) => SELF.fetch(`https://x/api/v1/stores/${store}/assistant${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const turn = (text = 'فين رصيد المحفظة؟', conversationId = crypto.randomUUID()) => ({ conversationId, text, locale: 'ar' as const });
const setMode = (store: string, mode: 'off' | 'answer-only') => workspace(store).setAssistantMode(mode);
afterEach(() => { configureAssistant({}); });

describe('assistant route: access', () => {
  it('401 without a session', async () => {
    const s = storeId(7001);
    await apiFor(s);
    expect((await post(s, null, '/turn', turn())).status).toBe(401);
  });

  it('403 for a member of another store: never an answer about a store you are not in (mutation: auth gate)', async () => {
    const a = storeId(7002);
    const b = storeId(7003);
    await apiFor(a);
    await apiFor(b);
    await setMode(b, 'answer-only');
    const tokenA = (await apiFor(a)).token;
    const { ai, calls } = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai, help: helpHits([{ articleId: 'whatsapp/wallet-top-ups-and-refunds', score: 0.9 }]) });
    const res = await post(b, tokenA, '/turn', turn());
    expect(res.status).toBe(403);
    expect(calls).toEqual([]); // no model call, and nothing written for the other store
    expect(await rows(b, 'SELECT count(*) AS n FROM sl_turns')).toEqual([{ n: 0 }]);
  });

  it('every assistant route is person-only: a merchant\'s own server token (integration) never reaches it', () => {
    for (const [m, p] of [['POST', '/stores/:storeId/assistant/turn'], ['GET', '/stores/:storeId/assistant/conversations/:conversationId'], ['POST', '/stores/:storeId/assistant/feedback']] as const) expect(gateForRoute(m, p)).toBe('person_only');
  });
});

describe('assistant route: turns', () => {
  it('default mode is off: 200 with status off and no model call', async () => {
    const s = storeId(7010);
    const { token } = await apiFor(s);
    const { ai, calls } = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai, help: helpHits([]) });
    const res = await post(s, token, '/turn', turn());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('off');
    expect(calls).toEqual([]);
  });

  it('answer-only: owner and staff both get a grounded answer with a "show me where" segment, audit rows are masked', async () => {
    const s = storeId(7011);
    for (const role of ['owner', 'staff'] as const) {
      const { token } = await apiFor(s, role);
      await setMode(s, 'answer-only');
      const { ai } = scriptedAi([{ text: 'تقدر تشحن المحفظة من شاشة المحفظة. [[cap:wallet.view]] [[help:whatsapp/wallet-top-ups-and-refunds]]' }]);
      configureAssistant({ ai, help: helpHits([{ articleId: 'whatsapp/wallet-top-ups-and-refunds', score: 0.9 }]) });
      const res = await post(s, token, '/turn', turn('ازاي أشحن المحفظة؟ رقمي 01012345678'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; segments: Array<{ kind: string; appPath?: string; capabilityId?: string }> };
      expect(body.status).toBe('answered');
      expect(body.segments.find((x) => x.kind === 'cap')).toMatchObject({ capabilityId: 'wallet.view', appPath: '/wallet' });
      expect(body.segments.some((x) => x.kind === 'cite')).toBe(true);
    }
    const audits = await rows(s, 'SELECT json FROM sl_audit');
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const a of audits) expect(String(a.json)).not.toContain('01012345678');
  });

  it('a read tool runs through the merchant\'s own route and its answer reaches the reply', async () => {
    const s = storeId(7012);
    const { token } = await apiFor(s);
    await setMode(s, 'answer-only');
    const { ai } = scriptedAi([{ call: { name: 'wallet_view', args: {} } }, { text: 'المحفظة هنا. [[cap:wallet.view]]' }]);
    configureAssistant({ ai, help: helpHits([{ articleId: 'whatsapp/wallet-top-ups-and-refunds', score: 0.9 }]) });
    const res = await post(s, token, '/turn', turn('رصيدي كام؟'));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('answered');
    expect(await rows(s, "SELECT json_extract(json, '$.toolCalls') AS t FROM sl_audit")).toEqual([{ t: '["wallet_view"]' }]);
  });

  it('the 151st turn of the day is limited with a plain message, not an error', async () => {
    const s = storeId(7013);
    const { token } = await apiFor(s);
    await setMode(s, 'answer-only');
    const st = rpcStorage((op, args) => workspace(s).smartLayer(op, args));
    for (let i = 0; i < 150; i++) await st.bump(`free:${s}`, 86_400_000, Date.now());
    const { ai, calls } = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai, help: helpHits([]) });
    const body = (await (await post(s, token, '/turn', turn())).json()) as { status: string };
    expect(body.status).toBe('limited');
    expect(calls).toEqual([]);
  });

  it('refuses a malformed body and an over-long message with 400', async () => {
    const s = storeId(7014);
    const { token } = await apiFor(s);
    expect((await post(s, token, '/turn', { text: 'x' })).status).toBe(400);
    expect((await post(s, token, '/turn', turn('x'.repeat(2001)))).status).toBe(400);
  });
});

describe('assistant route: conversation and feedback', () => {
  it('a conversation id never opens another member\'s chat', async () => {
    const s = storeId(7020);
    const owner = await apiFor(s);
    await setMode(s, 'answer-only');
    const other = await mint(apiKey(), { sub: U.other, stores: [{ id: s, role: 'owner' }] });
    const { ai } = scriptedAi([{ text: 'تمام. [[cap:wallet.view]]' }]);
    configureAssistant({ ai, help: helpHits([{ articleId: 'whatsapp/wallet-top-ups-and-refunds', score: 0.9 }]) });
    const conv = crypto.randomUUID();
    expect((await post(s, owner.token, '/turn', turn('ازاي أشحن المحفظة؟', conv))).status).toBe(200);
    const get = (t: string) => SELF.fetch(`https://x/api/v1/stores/${s}/assistant/conversations/${conv}`, { headers: { authorization: `Bearer ${t}` } });
    const mine = (await (await get(owner.token)).json()) as { items: unknown[] };
    const theirs = (await (await get(other)).json()) as { items: unknown[] };
    expect(mine.items.length).toBe(2);
    expect(theirs.items).toEqual([]);
  });

  it('a thumb is written into sl_audit rails.thumb', async () => {
    const s = storeId(7021);
    const { token } = await apiFor(s);
    const turnId = crypto.randomUUID();
    expect((await post(s, token, '/feedback', { turnId, thumb: 'down' })).status).toBe(200);
    expect(await rows(s, "SELECT json_extract(json, '$.rails.thumb') AS t, json_extract(json, '$.turnId') AS turn FROM sl_audit")).toEqual([{ t: 'down', turn: turnId }]);
    expect((await post(s, token, '/feedback', { turnId, thumb: 'sideways' })).status).toBe(400);
  });
});
