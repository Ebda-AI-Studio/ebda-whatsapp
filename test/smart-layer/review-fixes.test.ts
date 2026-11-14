// Independent review of PR 85 (Opus): every finding is pinned here first (red), then fixed.
import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import type { HelpDeps } from '../../src/core/smart-layer/help-index';
import { assistantEnabled } from '../../src/core/smart-layer/controls';
import { apiFor, apiKey, storeId, useApiKey } from '../helpers/api';
import { mint } from '../helpers/issuer';
import { rows, seedNumber, workspace } from '../helpers/workspace';

useApiKey();
type Msg = { content?: string };
function scriptedAi(text = 'تقدر تشحن المحفظة من شاشة المحفظة. [[cap:wallet.view]]') {
  const seen: Msg[][] = [];
  return { seen, ai: { run: async (_m: string, inputs: Record<string, unknown>) => {
    const msgs = inputs.messages as Msg[];
    if ((msgs[0]?.content ?? '').includes('Classify the merchant message')) return { choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    seen.push(msgs);
    return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  } } };
}
const help = (): HelpDeps => ({ db: env.DB, embed: async (t) => t.map(() => [0]), vectors: { upsert: async () => ({}), deleteByIds: async () => ({}), query: async () => ({ count: 1, matches: [{ id: 'a', score: 0.9, metadata: { articleId: 'whatsapp/wallet-top-ups-and-refunds', locale: 'ar', title: 'محفظة', url: 'https://help.ebda.app/whatsapp/wallet-top-ups-and-refunds/', appPath: '', text: 'المحفظة بتدفع رسوم Meta.' } }] }) } as never });
const post = (store: string, token: string, path: string, body: unknown) => SELF.fetch(`https://x/api/v1/stores/${store}/assistant${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const turn = (conversationId: string, text = 'ازاي أشحن المحفظة؟') => ({ conversationId, text, locale: 'ar' as const });
const STAFF = '7a2e3d2f-9b9f-4b4c-8a2f-2b3c4d5e6f71';
afterEach(() => configureAssistant({}));

describe('review #1: another member never gets, or plants, history through a reused conversation id', () => {
  it('owner turns then staff reuses the id: nothing of the owner is in the staff model context, and the reverse', async () => {
    const s = storeId(9201);
    const owner = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    const staff = await mint(apiKey(), { sub: STAFF, stores: [{ id: s, role: 'staff' }] });
    const conv = crypto.randomUUID();
    configureAssistant({ ai: scriptedAi().ai, help: help() });
    expect((await post(s, owner.token, '/turn', turn(conv, 'ازاي أشحن المحفظة؟ OWNERSECRETMARK'))).status).toBe(200);
    const b = scriptedAi();
    configureAssistant({ ai: b.ai, help: help() });
    expect((await post(s, staff, '/turn', turn(conv, 'STAFFPLANTMARK ازاي أشحن المحفظة؟'))).status).toBe(200);
    expect(JSON.stringify(b.seen)).not.toContain('OWNERSECRETMARK');
    const c = scriptedAi();
    configureAssistant({ ai: c.ai, help: help() });
    expect((await post(s, owner.token, '/turn', turn(conv, 'تاني ازاي أشحن المحفظة؟'))).status).toBe(200);
    expect(JSON.stringify(c.seen)).not.toContain('STAFFPLANTMARK');
    const get = async (t: string) => ((await (await SELF.fetch(`https://x/api/v1/stores/${s}/assistant/conversations/${conv}`, { headers: { authorization: `Bearer ${t}` } })).json()) as { items: Array<{ text: string }> }).items.map((x) => x.text).join(' ');
    expect(await get(staff)).not.toContain('OWNERSECRET');
    expect(await get(owner.token)).not.toContain('STAFFPLANT');
  });
});

describe('review #2: a malformed kill switch fails CLOSED', () => {
  for (const key of ['sl.global', 'sl.product.chat']) {
    it(`unparseable ${key} turns the assistant off`, async () => {
      const s = storeId(key === 'sl.global' ? 9202 : 9203);
      const { token } = await apiFor(s);
      await workspace(s).setAssistantMode('answer-only');
      await env.DB.prepare('INSERT INTO platform_flags (key, value, updated_at) VALUES (?, ?, 0)').bind(key, '{kill:true').run();
      const a = scriptedAi();
      configureAssistant({ ai: a.ai, help: help() });
      const body = (await (await post(s, token, '/turn', turn(crypto.randomUUID()))).json()) as { status: string };
      await env.DB.prepare('DELETE FROM platform_flags WHERE key = ?').bind(key).run();
      expect(body.status).toBe('off');
      expect(a.seen.length).toBe(0);
    });
  }
});

describe('review #3: /me survives an assistant read error', () => {
  it('assistantEnabled answers false (never throws) when D1 errors', async () => {
    const broken = { DB: { prepare: () => { throw new Error('d1 down'); } }, WORKSPACE_DO: env.WORKSPACE_DO } as never;
    await expect(assistantEnabled(broken, storeId(9204))).resolves.toBe(false);
  });
});

describe('review #4: feedback must belong to the caller', () => {
  it('refuses a turn id that is not the caller\'s, accepts their own once, caps the rate', async () => {
    const s = storeId(9205);
    const owner = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    const staff = await mint(apiKey(), { sub: STAFF, stores: [{ id: s, role: 'staff' }] });
    configureAssistant({ ai: scriptedAi().ai, help: help() });
    const mine = (await (await post(s, owner.token, '/turn', turn(crypto.randomUUID()))).json()) as { turnId: string };
    expect((await post(s, owner.token, '/feedback', { turnId: crypto.randomUUID(), thumb: 'up' })).status).toBe(404); // not a turn at all
    expect((await post(s, staff, '/feedback', { turnId: mine.turnId, thumb: 'up' })).status).toBe(404); // another member's turn
    expect((await post(s, owner.token, '/feedback', { turnId: mine.turnId, thumb: 'up' })).status).toBe(200);
    expect((await post(s, owner.token, '/feedback', { turnId: mine.turnId, thumb: 'down' })).status).toBe(200); // idempotent
    const fb = await rows(s, "SELECT json_extract(json, '$.rails.thumb') AS t FROM sl_audit WHERE json_extract(json, '$.releaseId') = 'feedback'");
    expect(fb).toEqual([{ t: 'up' }]); // one row per turn and user, the first thumb stands
  });
  it('rate-limits feedback per user', async () => {
    const s = storeId(9206);
    const owner = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    let last = 200;
    for (let i = 0; i < 40; i++) last = (await post(s, owner.token, '/feedback', { turnId: crypto.randomUUID(), thumb: 'up' })).status;
    expect(last).toBe(429);
  });
});

describe('review #5: a handoff never writes transcript text to a log', () => {
  it('logs ids and sizes only', async () => {
    const { chatHandoff } = await import('../../src/core/smart-layer/handoff');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await chatHandoff()({ storeId: 's', userId: 'u' } as never, { reason: 'asked_human', maskedTranscript: 'merchant: العميلة منى السيد عايزة ترجع', journalIds: ['t1'] });
    const out = err.mock.calls.map((c) => String(c[0])).join('\n');
    err.mockRestore();
    expect(out).toContain('assistant_handoff');
    expect(out).not.toContain('منى');
    expect(out).not.toContain('transcript"');
  });
});

