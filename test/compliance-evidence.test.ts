import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { recordAudit } from '../src/core/audit';
import { csvCell } from '../src/core/campaigns/report';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { PN, makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { exec, rows } from './helpers/workspace';

useApiKey();

async function withCampaign(n: number) {
  const s = storeId(n);
  const owner = await apiFor(s, 'owner', PN);
  await seedTemplate(s);
  await seedContacts(s, 3);
  const camp = await makeCampaign(s);
  const ids = await rows<{ id: number }>(s, 'SELECT id FROM contacts ORDER BY id');
  await exec(s, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, skip_reason, at) VALUES (?, ?, 0, 'k1', 'skipped', 'opted_out', 1), (?, ?, 0, 'k2', 'skipped', 'opted_out', 1), (?, ?, 0, 'k3', 'skipped', 'no_consent', 1)", camp.id, ids[0]!.id, camp.id, ids[1]!.id, camp.id, ids[2]!.id);
  return { s, owner, camp };
}

describe('GET /campaigns/:id/report (campaigns.report-export)', () => {
  it('the owner gets counts and skip reasons, no phone number anywhere; the csv is a file', async () => {
    const { owner, camp } = await withCampaign(9401);
    const r = await owner.call('GET', `/campaigns/${camp.id}/report`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text) as { consentGated: boolean; totals: { skipped: number }; skippedByReason: Record<string, number>; campaign: { name: string } };
    expect(body.consentGated).toBe(true);
    expect(body.totals.skipped).toBe(3);
    expect(body.skippedByReason).toEqual({ opted_out: 2, no_consent: 1 });
    expect(text).not.toMatch(/2010\d{7}/);
    const csv = await owner.call('GET', `/campaigns/${camp.id}/report?format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    const csvText = await csv.text();
    expect(csvText).toContain('skipped_opted_out,2');
    expect(csvText).toContain('skipped_no_consent,1');
    expect(csvText).not.toMatch(/2010\d{7}/);
  });
  it('staff are refused; an unknown id and another store\'s campaign are 404; a bad format is 400', async () => {
    const { s, camp } = await withCampaign(9402);
    const staff = await apiFor(s, 'staff', PN);
    expect((await staff.call('GET', `/campaigns/${camp.id}/report`)).status).toBe(403);
    const owner = await apiFor(s, 'owner', PN);
    expect((await owner.call('GET', `/campaigns/${crypto.randomUUID()}/report`)).status).toBe(404);
    expect((await owner.call('GET', `/campaigns/${camp.id}/report?format=xml`)).status).toBe(400);
    const other = await apiFor(storeId(9403), 'owner', 'pn-other-9403');
    expect((await other.call('GET', `/campaigns/${camp.id}/report`)).status).toBe(404);
  });
});

describe('GET /contacts/consent-evidence (compliance.opt-out-evidence)', () => {
  it('counts by source, proof count and opt-outs; pages with nextAfter; staff refused; the read is audited without a number', async () => {
    const s = storeId(9411);
    const owner = await apiFor(s, 'owner', PN);
    await seedContacts(s, 3);
    await exec(s, "UPDATE contacts SET opted_out_at = 5000, consent_source = 'keyword_stop' WHERE wa_id = '201010000001'");
    await exec(s, "INSERT INTO consent_proofs (contact_id, source, attested_by, wording, at) SELECT id, 'import', 'u1', 'agreed to marketing', 7 FROM contacts WHERE wa_id = '201010000000'");
    const r = (await (await owner.call('GET', '/contacts/consent-evidence?limit=2')).json()) as { summary: { contacts: number; withConsent: number; withConsentProof: number; optedOut: number; consentBySource: Record<string, number> }; items: Array<{ waId: string; optedOutAt: number | null; proof: { wording: string } | null }>; nextAfter: number | null };
    expect(r.summary).toMatchObject({ contacts: 3, withConsent: 3, withConsentProof: 1, optedOut: 1 });
    expect(r.summary.consentBySource).toEqual({ 'import:x.csv': 2, keyword_stop: 1 });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.proof?.wording).toBe('agreed to marketing');
    expect(r.items[1]!.optedOutAt).toBe(5000);
    expect(r.nextAfter).not.toBeNull();
    const next = (await (await owner.call('GET', `/contacts/consent-evidence?limit=2&after=${r.nextAfter}`)).json()) as { items: unknown[]; nextAfter: number | null };
    expect(next.items).toHaveLength(1);
    expect(next.nextAfter).toBeNull();
    const staff = await apiFor(s, 'staff', PN);
    expect((await staff.call('GET', '/contacts/consent-evidence')).status).toBe(403);
    const audit = await env.DB.prepare("SELECT action, detail, target_id FROM audit_log WHERE workspace_id = ? AND action = 'contacts.consent-evidence'").bind(s).all<{ detail: string; target_id: string | null }>();
    expect(audit.results.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.results)).not.toMatch(/2010\d{7}/);
  });
  it('a name that would run as a spreadsheet formula is neutralised in the csv, and quoting is correct', async () => {
    const s = storeId(9412);
    const owner = await apiFor(s, 'owner', PN);
    await exec(s, "INSERT INTO contacts (wa_id, profile_name, consent_source, consent_at) VALUES ('201099999999', '=HYPERLINK(\"x\")', 'import:a,b.csv', 9)");
    const csv = await (await owner.call('GET', '/contacts/consent-evidence?format=csv')).text();
    expect(csv.split('\r\n')[0]).toBe('wa_id,name,consent_source,consent_at,opted_out_at,proof_source,proof_wording,proof_at');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"import:a,b.csv"');
  });
  it('csvCell', () => {
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
  });
});

describe('GET /audit (compliance.audit-trail)', () => {
  it('shows only this workspace, newest first, never a target id or a number; pages with nextBefore; staff refused', async () => {
    const a = storeId(9421);
    const b = storeId(9422);
    const owner = await apiFor(a, 'owner', PN);
    await apiFor(b, 'owner', 'pn-9422');
    for (let i = 0; i < 3; i++) await recordAudit(env, { workspaceId: a, actor: 'u-a', role: 'owner', action: `PUT /stores/:storeId/agent#${i}`, targetType: 'waId', targetId: '0123456789abcdef0123456789abcdef' });
    await recordAudit(env, { workspaceId: b, actor: 'u-b', role: 'owner', action: 'DELETE /stores/:storeId/templates/:name/:language' });
    const r = (await (await owner.call('GET', '/audit?limit=2')).json()) as { items: Array<Record<string, unknown>>; nextBefore: number | null };
    expect(r.items).toHaveLength(2);
    expect(r.items.map((x) => x.action)).toEqual(['PUT /stores/:storeId/agent#2', 'PUT /stores/:storeId/agent#1']);
    expect(Object.keys(r.items[0]!).sort()).toEqual(['action', 'actor', 'at', 'id', 'role', 'status']);
    expect(r.nextBefore).not.toBeNull();
    const more = (await (await owner.call('GET', `/audit?limit=2&before=${r.nextBefore! + 1}`)).json()) as { items: Array<{ action: string }> };
    expect(more.items.map((x) => x.action)).toContain('PUT /stores/:storeId/agent#0');
    expect(JSON.stringify([r, more])).not.toContain('DELETE /stores/:storeId/templates');
    expect(JSON.stringify([r, more])).not.toContain('0123456789abcdef');
    expect((await (await apiFor(a, 'staff', PN)).call('GET', '/audit')).status).toBe(403);
    expect((await owner.call('GET', '/audit?limit=500')).status).toBe(400);
  });
});
