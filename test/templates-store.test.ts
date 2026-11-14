import { describe, expect, it } from 'vitest';
import { DO_MIGRATIONS } from '../src/core/do-migrations';
import { destructiveStatements } from './helpers/additive';
import { makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { storeId as W } from './helpers/api';
import { exec, openChat, rows, seedNumber, workspace } from './helpers/workspace';

const DAY = 86_400_000;
const comps = [{ type: 'BODY', text: 'أهلاً {{1}} طلبك خرج للشحن.', example: { body_text: [['أحمد']] } }];
async function ws(n: number) {
  const id = W(n);
  await seedNumber(`pn-${id}`, id);
  return { id, do: workspace(id) };
}
const save = (w: Awaited<ReturnType<typeof ws>>, o: Partial<{ name: string; category: string; status: string; metaId: string | null; label: string | null }> = {}) =>
  w.do.saveSubmittedTemplate({ name: o.name ?? 'tpl', language: 'ar', category: o.category ?? 'UTILITY', status: o.status ?? 'PENDING', components: comps, metaId: o.metaId === undefined ? 'm1' : o.metaId, label: o.label === undefined ? 'قالبي' : o.label });

describe('v42', () => {
  it('adds columns and the edit log, and keeps existing rows', async () => {
    const w = await ws(300);
    await seedTemplate(w.id, { name: 'old', status: 'APPROVED' });
    const cols = (await rows<{ name: string }>(w.id, 'PRAGMA table_info(templates)')).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['meta_id', 'label', 'submitted_at']));
    expect(await rows(w.id, 'SELECT name FROM template_edits')).toEqual([]);
    expect((await rows(w.id, "SELECT name, meta_id, label FROM templates WHERE name = 'old'"))[0]).toEqual({ name: 'old', meta_id: null, label: null });
  });
  it('template_edits is additive', () => {
    expect(DO_MIGRATIONS.length).toBeGreaterThanOrEqual(42);
    expect(destructiveStatements(DO_MIGRATIONS[41]!)).toEqual([]);
    expect(DO_MIGRATIONS[41]).toMatch(/template_edits/);
  });
});

describe('saveSubmittedTemplate / getTemplate', () => {
  it("stores Meta's confirmed category, not the requested one", async () => {
    const w = await ws(301);
    await save(w, { category: 'MARKETING' }); // service passes Meta's answer; requested UTILITY is gone
    const t = await w.do.getTemplate('tpl', 'ar');
    expect(t).toMatchObject({ category: 'MARKETING', status: 'PENDING', metaId: 'm1', label: 'قالبي', rejectedReason: null });
    expect((await rows<{ submitted_at: number }>(w.id, 'SELECT submitted_at FROM templates'))[0]!.submitted_at).toBeGreaterThan(0);
  });
  it('getTemplate is null for an unknown template', async () => expect(await (await ws(302)).do.getTemplate('nope', 'ar')).toBeNull());
  it('a re-save keeps the label when none is passed', async () => {
    const w = await ws(303);
    await save(w);
    await save(w, { label: null, metaId: null });
    expect(await w.do.getTemplate('tpl', 'ar')).toMatchObject({ label: 'قالبي', metaId: 'm1' });
  });
});

describe('editAllowance (Meta: APPROVED 1 per 24 h and 10 per 30 days; REJECTED/PAUSED unlimited)', () => {
  it('approved edited 5 s ago -> daily with retryAt = at + 24 h', async () => {
    const w = await ws(304);
    await save(w, { status: 'APPROVED' });
    const now = 10 * DAY;
    await w.do.recordTemplateEdit('tpl', 'ar', now - 5_000);
    expect(await w.do.editAllowance('tpl', 'ar', now)).toEqual({ allowed: false, reason: 'daily', retryAt: now - 5_000 + DAY });
  });
  it('10 edits in 30 days -> monthly with retryAt = oldest + 30 d', async () => {
    const w = await ws(305);
    await save(w, { status: 'APPROVED' });
    const now = 100 * DAY;
    for (let i = 0; i < 10; i++) await w.do.recordTemplateEdit('tpl', 'ar', now - (29 - i * 3) * DAY - 1000); // 29 d ago ... 2 d ago, all > 24 h apart and > 24 h old
    expect(await w.do.editAllowance('tpl', 'ar', now)).toEqual({ allowed: false, reason: 'monthly', retryAt: now - 29 * DAY - 1000 + 30 * DAY });
  });
  it('9 edits in 30 days and none in 24 h is allowed', async () => {
    const w = await ws(306);
    await save(w, { status: 'APPROVED' });
    const now = 100 * DAY;
    for (let i = 0; i < 9; i++) await w.do.recordTemplateEdit('tpl', 'ar', now - (29 - i * 3) * DAY);
    expect(await w.do.editAllowance('tpl', 'ar', now)).toEqual({ allowed: true });
  });
  it('REJECTED and PAUSED are never blocked, even after many edits', async () => {
    const w = await ws(307);
    await save(w, { status: 'REJECTED' });
    await save(w, { name: 'p', status: 'PAUSED' });
    for (let i = 0; i < 12; i++) { await w.do.recordTemplateEdit('tpl', 'ar', 5 * DAY - i); await w.do.recordTemplateEdit('p', 'ar', 5 * DAY - i); }
    expect(await w.do.editAllowance('tpl', 'ar', 5 * DAY)).toEqual({ allowed: true });
    expect(await w.do.editAllowance('p', 'ar', 5 * DAY)).toEqual({ allowed: true });
  });
  it.each(['PENDING', 'DISABLED', 'PENDING_DELETION'])('%s is not editable (reason status)', async (status) => {
    const w = await ws(308);
    await save(w, { status });
    expect(await w.do.editAllowance('tpl', 'ar', 1)).toEqual({ allowed: false, reason: 'status', retryAt: null });
  });
});

describe('applyTemplateStatus', () => {
  it('stores meta_id from the event and clears the reason on APPROVED', async () => {
    const w = await ws(309);
    await save(w, { status: 'REJECTED', metaId: null });
    await exec(w.id, "UPDATE templates SET rejected_reason = 'INVALID_FORMAT'");
    expect(await w.do.applyTemplateStatus('tpl', 'ar', 'APPROVED', 'INVALID_FORMAT', 'meta-77')).toEqual({ applied: true });
    expect(await w.do.getTemplate('tpl', 'ar')).toMatchObject({ status: 'APPROVED', rejectedReason: null, metaId: 'meta-77' });
  });
  it('maps Meta reason NONE or empty to null', async () => {
    const w = await ws(310);
    await save(w);
    await w.do.applyTemplateStatus('tpl', 'ar', 'REJECTED', 'NONE');
    expect((await w.do.getTemplate('tpl', 'ar'))!.rejectedReason).toBeNull();
    await w.do.applyTemplateStatus('tpl', 'ar', 'REJECTED', 'INVALID_FORMAT');
    expect((await w.do.getTemplate('tpl', 'ar'))!.rejectedReason).toBe('INVALID_FORMAT');
    await w.do.applyTemplateStatus('tpl', 'ar', 'REJECTED', '');
    expect((await w.do.getTemplate('tpl', 'ar'))!.rejectedReason).toBeNull();
  });
  it('an event without a template id keeps the stored one', async () => {
    const w = await ws(311);
    await save(w);
    await w.do.applyTemplateStatus('tpl', 'ar', 'APPROVED', null, null);
    expect((await w.do.getTemplate('tpl', 'ar'))!.metaId).toBe('m1');
  });
});

describe('templateInUse', () => {
  it('sees a scheduled campaign and a queued message, and nothing otherwise', async () => {
    const w = await ws(312);
    await seedTemplate(w.id, { name: 'promo', status: 'APPROVED' });
    expect(await w.do.templateInUse('promo', 'ar')).toBeNull();
    await seedContacts(w.id, 1);
    await makeCampaign(w.id); // draft campaign on 'promo'
    expect(await w.do.templateInUse('promo', 'ar')).toBe('campaign');
    await exec(w.id, "UPDATE campaigns SET status = 'completed'");
    expect(await w.do.templateInUse('promo', 'ar')).toBeNull();
    const conv = await openChat(w.id);
    await exec(w.id, "INSERT INTO messages (conversation_id, direction, type, preview, status, idempotency_key, template_name, template_lang, created_at, updated_at) VALUES (?, 'out', 'template', 'x', 'queued', 'k1', 'promo', 'ar', 1, 1)", conv);
    expect(await w.do.templateInUse('promo', 'ar')).toBe('queued');
  });
});

describe('removeTemplate / pendingTemplates', () => {
  it('removes one language only and reports it', async () => {
    const w = await ws(313);
    await save(w);
    await seedTemplate(w.id, { name: 'tpl' }); // same name, another row is impossible (unique) so use a second language below
    await exec(w.id, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('tpl', 'en', 'UTILITY', 'APPROVED', '[]', 1)");
    expect(await w.do.removeTemplate('tpl', 'ar')).toBe(true);
    expect(await w.do.removeTemplate('tpl', 'ar')).toBe(false);
    expect((await rows(w.id, 'SELECT language FROM templates')).map((r) => (r as { language: string }).language)).toEqual(['en']);
  });
  it('pendingTemplates returns only PENDING rows older than the cutoff', async () => {
    const w = await ws(314);
    await save(w, { name: 'old_p', status: 'PENDING' });
    await save(w, { name: 'fresh_p', status: 'PENDING' });
    await save(w, { name: 'done', status: 'APPROVED' });
    await exec(w.id, "UPDATE templates SET updated_at = 1000 WHERE name = 'old_p'");
    expect(await w.do.pendingTemplates(60_000)).toEqual([{ name: 'old_p', language: 'ar', metaId: 'm1' }]);
  });
});

describe('listTemplates', () => {
  it('carries label, components, updatedAt and the edit allowance', async () => {
    const w = await ws(315);
    await save(w, { status: 'APPROVED' });
    const [t] = await w.do.listTemplates();
    expect(t).toMatchObject({ name: 'tpl', label: 'قالبي', updatedAt: expect.any(Number), editAllowance: { allowed: true } });
    expect(t!.components).toEqual(comps);
  });
});
