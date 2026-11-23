import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import explainJson from '../../assistant/explain.generated.json';
import { recordAudit } from '../../src/core/audit';
import { explainTools, type ExplainData } from '../../src/core/smart-layer/tools/explain.tools';
import { configureAssistant } from '../../src/routes/assistant';
import { useApiKey } from '../helpers/api';
import { PN, makeCampaign, seedContacts, seedTemplate } from '../helpers/campaigns';
import { exec, rows } from '../helpers/workspace';
import { scriptedAi, setup } from './harness';

useApiKey();
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

async function readOnce(t: Awaited<ReturnType<typeof setup>>, text: string, call: { name: string; args: unknown }) {
  const ai = scriptedAi([{ call }, { text: 'تمام.' }]);
  await t.ask(text, undefined, ai);
  return ai.seen.join(' ').replace(/\\"/g, '"');
}

describe('compliance reads through the assistant (free, owner only, counts never numbers)', () => {
  it('campaign_report answers from the report route: totals and skip reasons, no phone number', async () => {
    const t = await setup(9501);
    await seedTemplate(t.s);
    await seedContacts(t.s, 2);
    const camp = await makeCampaign(t.s);
    const ids = await rows<{ id: number }>(t.s, 'SELECT id FROM contacts ORDER BY id');
    await exec(t.s, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, skip_reason, at) VALUES (?, ?, 0, 'q1', 'skipped', 'opted_out', 1)", camp.id, ids[0]!.id);
    const seen = await readOnce(t, 'عايز تقرير حملة Eid sale', { name: 'campaign_report', args: { campaign: 'Eid sale' } });
    expect(seen).toContain('"opted_out":1');
    expect(seen).toContain('onlyConsentedCustomersMessaged');
    expect(seen).not.toMatch(/2010\d{7}/);
    // a name that matches no campaign finds nothing, so nothing is guessed
    expect(await readOnce(t, 'تقرير حملة تانية', { name: 'campaign_report', args: { campaign: 'مفيش حملة بالاسم ده' } })).not.toContain('onlyConsentedCustomersMessaged');
  });
  it('consent_evidence_summary gives counts and never a customer number', async () => {
    const t = await setup(9502);
    await seedContacts(t.s, 3);
    const seen = await readOnce(t, 'عايز اثبات الموافقة', { name: 'consent_evidence_summary', args: {} });
    expect(seen).toContain('"withConsent":3');
    expect(seen).not.toMatch(/2010\d{7}/);
  });
  it('audit_trail_view shows what changed without a target', async () => {
    const t = await setup(9503);
    await recordAudit(env, { workspaceId: t.s, actor: 'u1', role: 'owner', action: 'PUT /stores/:storeId/agent', targetType: 'waId', targetId: '0123456789abcdef0123456789abcdef' });
    const seen = await readOnce(t, 'مين غيّر ايه', { name: 'audit_trail_view', args: {} });
    expect(seen).toContain('PUT /stores/:storeId/agent');
    expect(seen).not.toContain('0123456789abcdef');
  });
  it('staff get nothing from the owner-only routes', async () => {
    const t = await setup(9504, 'staff');
    await recordAudit(env, { workspaceId: t.s, actor: 'u1', role: 'owner', action: 'PUT /stores/:storeId/agent' });
    expect(await readOnce(t, 'مين غيّر ايه', { name: 'audit_trail_view', args: {} })).not.toContain('PUT /stores/:storeId/agent');
    expect(await readOnce(t, 'اثبات الموافقة', { name: 'consent_evidence_summary', args: {} })).not.toContain('withConsent');
  });
  it('numbers.migrate is answered from its guide (explain tool), with the template caveat', () => {
    const tool = explainTools(explainJson as unknown as ExplainData).find((x) => x.capabilityId === 'numbers.migrate');
    expect(tool).toBeTruthy();
    const e = (explainJson as unknown as ExplainData)['numbers.migrate']!;
    expect(e.steps.join(' ')).toContain('Templates do not move');
    expect(e.helpArticle).toBe('whatsapp/connect-your-own-number');
  });
});
