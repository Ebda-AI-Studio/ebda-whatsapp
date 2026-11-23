import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import { useApiKey } from '../helpers/api';
import { setup } from './harness';

useApiKey();
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

type Agent = { tone: string; notifyPhone: string | null; recommendProducts: boolean };
const status = async (r: Response) => ((await r.json()) as { status: string }).status;

describe('agent_tone_set (preview, reversible)', () => {
  it('the turn changes nothing; Apply sets the tone; Undo puts the old one back; the same tone builds no card', async () => {
    const t = await setup(9801);
    const before = ((await t.get('/agent')) as Agent).tone;
    const out = await t.ask('خلي الموظف الذكي مرح', { name: 'agent_tone_set', args: { tone: 'playful' } });
    expect(out.previews[0]).toMatchObject({ policy: 'preview', undo: 'reversible' });
    expect(((await t.get('/agent')) as Agent).tone).toBe(before);
    const applied = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string; appliedId: string };
    expect(applied.status).toBe('applied');
    expect(((await t.get('/agent')) as Agent).tone).toBe('playful');
    expect(await status(await t.undo(applied.appliedId))).toBe('undone');
    expect(((await t.get('/agent')) as Agent).tone).toBe(before);
    expect((await t.ask('خلي الموظف الذكي دافي', { name: 'agent_tone_set', args: { tone: before } })).previews).toEqual([]);
  });
  it('a value outside the three presets is refused by the schema and builds no card', async () => {
    const t = await setup(9802);
    expect((await t.ask('نبرة غريبة', { name: 'agent_tone_set', args: { tone: 'angry' } })).previews).toEqual([]);
  });
});

describe('agent_notify_phone_set (preview, reversible, the number never shown in full)', () => {
  it('Apply stores the number, the card and the stored draft hold only the last 3 digits, Undo removes it', async () => {
    const t = await setup(9803);
    const out = await t.ask('نبهني على 01012345678', { name: 'agent_notify_phone_set', args: { phone: '+201012345678' } });
    const card = JSON.stringify(out.previews[0]);
    expect(card).toContain('678');
    expect(card).not.toContain('201012345678');
    const applied = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string; appliedId: string };
    expect(applied.status).toBe('applied');
    expect(((await t.get('/agent')) as Agent).notifyPhone).toBe('+201012345678');
    expect(await status(await t.undo(applied.appliedId))).toBe('undone');
    expect(((await t.get('/agent')) as Agent).notifyPhone).toBeNull();
  });
  it('a malformed number builds no card and nothing changes; removing when none is set builds none either', async () => {
    const t = await setup(9804);
    expect((await t.ask('نبهني', { name: 'agent_notify_phone_set', args: { phone: '0101234' } })).previews).toEqual([]);
    expect((await t.ask('شيل رقم التنبيه', { name: 'agent_notify_phone_set', args: { phone: null } })).previews).toEqual([]);
    expect(((await t.get('/agent')) as Agent).notifyPhone).toBeNull();
  });
});

describe('agent_recommendations_toggle (confirm: it can message a customer after an order)', () => {
  it('needs the merchant confirm press (not Apply); the press flips the setting; Undo restores it', async () => {
    const t = await setup(9805);
    const was = ((await t.get('/agent')) as Agent).recommendProducts;
    const out = await t.ask('خلي الموظف الذكي يقترح منتجات', { name: 'agent_recommendations_toggle', args: { enabled: !was } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('customer_message');
    expect(((await t.get('/agent')) as Agent).recommendProducts).toBe(was);
    const done = (await (await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    expect(((await t.get('/agent')) as Agent).recommendProducts).toBe(!was);
    const undo = (await (await t.undo(done.appliedId)).json()) as { status: string; approvals?: Array<{ approvalId: string; token: string }> };
    if (undo.status === 'needs_confirm') await t.confirm(undo.approvals![0]!.approvalId, undo.approvals![0]!.token);
    expect(((await t.get('/agent')) as Agent).recommendProducts).toBe(was);
  });
});

describe('owner-only: staff cannot build these cards (the owner screen\'s own route refuses the read)', () => {
  it('staff gets no card for tone, alert number or recommendations', async () => {
    const t = await setup(9806, 'staff');
    expect((await t.ask('نبرة', { name: 'agent_tone_set', args: { tone: 'playful' } })).previews).toEqual([]);
    expect((await t.ask('رقم', { name: 'agent_notify_phone_set', args: { phone: '+201012345678' } })).previews).toEqual([]);
    expect((await t.ask('اقتراحات', { name: 'agent_recommendations_toggle', args: { enabled: true } })).previews).toEqual([]);
  });
});
