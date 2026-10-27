import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { campaignDto } from '../src/core/api/contract';
import { buyerKey } from '../src/core/buyer-key';
import { configureCampaignLinks, isAutomatedFetch, newSignedCode, parseCode, validateTrackedUrl, withUtm, type LinkConfig } from '../src/core/campaigns/links';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { BUYER_SECRET } from './helpers/store-link';
import { holdAlarm, registerWorkspace, seedContacts, seedTemplate } from './helpers/campaigns';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
const BASE = 'https://wa.test';
let previous: LinkConfig | undefined;
const LINK_SECRET = 'link-signing-secret-for-tests-0123456789';
beforeEach(() => { previous = configureCampaignLinks({ baseUrl: () => BASE, buyerSecret: () => BUYER_SECRET, signingSecret: () => LINK_SECRET }); });
afterEach(() => { if (previous) configureCampaignLinks(previous); });

const BODY_LINK = JSON.stringify([{ type: 'BODY', text: 'أهلا {{1}} شوف العرض {{2}}' }]);
const BUTTON_LINK = JSON.stringify([{ type: 'BODY', text: 'أهلا {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'افتح', url: 'https://wa.test/t/{{1}}' }] }]);
const DEST = 'https://shop.example.com/eid?ref=wa';

it('destination rules: https, a real host, no credentials, not this service', () => {
  expect(validateTrackedUrl('https://shop.example.com/eid?x=1#top', BASE)).toBe('https://shop.example.com/eid?x=1#top');
  expect(validateTrackedUrl('https://متجر.example.com/a', BASE)).not.toBeNull();
  for (const bad of ['http://shop.example.com', 'javascript:alert(1)', 'https://user:pw@shop.example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://intranet/x', 'https://x.internal/a', 'https://printer.local/a', 'https://shop.example.com:8443/x', 'https://wa.test/loop', 'not a url', `https://shop.example.com/${'a'.repeat(2000)}`]) {
    expect(validateTrackedUrl(bad, BASE), bad).toBeNull();
  }
});

it('UTM is added where missing and the merchant\'s own values are kept; Arabic names slug, empty ones fall back to the id', () => {
  expect(withUtm('https://shop.example.com/a?ref=wa', 'Eid Sale 2026!', 'abcdef12-0000')).toBe('https://shop.example.com/a?ref=wa&utm_source=whatsapp&utm_medium=campaign&utm_campaign=eid_sale_2026');
  expect(withUtm('https://shop.example.com/a?utm_source=mine&utm_campaign=keep', 'x', 'id')).toBe('https://shop.example.com/a?utm_source=mine&utm_campaign=keep&utm_medium=campaign');
  expect(new URL(withUtm('https://shop.example.com/', 'عرض العيد', 'id')).searchParams.get('utm_campaign')).toBe('عرض_العيد');
  expect(new URL(withUtm('https://shop.example.com/', '!!!', 'abcdef12-0000')).searchParams.get('utm_campaign')).toBe('abcdef12');
});

it('codes are 128 random bits plus a MAC, unique, unguessable in shape and carry the workspace', async () => {
  const ws = W(660);
  const codes = new Set(await Promise.all(Array.from({ length: 2000 }, () => newSignedCode(ws, LINK_SECRET))));
  expect(codes.size).toBe(2000);
  const one = [...codes][0]!;
  const parsed = parseCode(one)!;
  expect(parsed.workspaceId).toBe(ws);
  const [, rand, mac] = one.split('.') as [string, string, string];
  expect(rand).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(mac).toMatch(/^[A-Za-z0-9_-]{22}$/);
  for (const bad of ['', 'nodot', `${ws}.short`, `${ws}.${'a'.repeat(22)}`, `${ws}.${'a'.repeat(23)}.${'b'.repeat(22)}`, `.${'a'.repeat(22)}.${'b'.repeat(22)}`, `${ws}.${'a'.repeat(21)}!.${'b'.repeat(22)}`]) expect(parseCode(bad), bad).toBeNull();
});

it('automated fetches (link previews, crawlers, HEAD) are told apart from people', () => {
  expect(isAutomatedFetch('WhatsApp/2.23.20 A', 'GET')).toBe(true);
  expect(isAutomatedFetch('facebookexternalhit/1.1', 'GET')).toBe(true);
  expect(isAutomatedFetch('Mozilla/5.0 (iPhone) Safari', 'HEAD')).toBe(true);
  expect(isAutomatedFetch('Mozilla/5.0 (iPhone; CPU iPhone OS 17) AppleWebKit Mobile Safari', 'GET')).toBe(false);
  expect(isAutomatedFetch(undefined, 'GET')).toBe(false);
});

it('a campaign with links needs a destination and a link parameter together, a safe URL, and this service\'s public origin', async () => {
  const ws = W(661);
  const api = await apiFor(ws);
  await seedTemplate(ws, { components: BODY_LINK });
  await seedContacts(ws, 2);
  const body = { name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'link' }], audience: { criteria: { everyone: true } }, linkUrl: DEST };
  const ok = await api.call('POST', '/campaigns', body);
  expect(ok.status).toBe(201);
  expect(campaignDto.parse(await ok.json())).toMatchObject({ linkUrl: DEST, clicks: { unique: 0, total: 0 } });
  const msg = async (b: unknown) => ((await (await api.call('POST', '/campaigns', b)).json()) as { message?: string }).message;
  expect(await msg({ ...body, linkUrl: undefined })).toBe('link_url_required');
  expect(await msg({ ...body, params: [{ kind: 'name', fallback: 'x' }, { kind: 'text', value: 'plain' }] })).toBe('link_param_required');
  expect(await msg({ ...body, linkUrl: 'http://shop.example.com/' })).toBe('link_url_invalid');
  expect(await msg({ ...body, linkUrl: 'https://wa.test/t/x' })).toBe('link_url_invalid');
  configureCampaignLinks({ baseUrl: () => null, buyerSecret: () => BUYER_SECRET, signingSecret: () => LINK_SECRET });
  expect(await msg(body)).toBe('tracking_unavailable');
});

it('each recipient gets their own link in the body or in a URL button; skipped recipients get none; rows are keyed by recipient', async () => {
  const ws = W(662);
  await holdAlarm(ws);
  await seedTemplate(ws, { components: BODY_LINK });
  await seedTemplate(ws, { name: 'btn', components: BUTTON_LINK });
  await seedContacts(ws, 3);
  await exec(ws, "UPDATE contacts SET opted_out_at = 5 WHERE wa_id = '201010000001'");
  const created = await workspace(ws).createCampaign({ name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'link' }], audience: { criteria: { everyone: true } }, linkUrl: DEST, phoneNumberId: 'pn-x', actor: 'u' });
  if (!created.ok) throw new Error(created.reason);
  await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", created.campaign.id);
  expect(await workspace(ws).campaignPage(created.campaign.id, 1, 0)).toEqual({ state: 'done', count: 2 });
  const links = await rows<{ code: string; contact_id: number }>(ws, 'SELECT code, contact_id FROM campaign_links ORDER BY contact_id');
  expect(links).toHaveLength(2);
  expect(new Set(links.map((l) => l.code)).size).toBe(2);
  const jobs = (await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release' ORDER BY id")).map((t) => JSON.parse(t.payload).job);
  expect(jobs.map((j) => j.template.components[0].parameters[1].text)).toEqual(links.map((l) => `${BASE}/t/${l.code}`));
  // URL button flavour
  const b = await workspace(ws).createCampaign({ name: 'Btn', template: { name: 'btn', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'link_code' }], audience: { criteria: { everyone: true } }, linkUrl: DEST, phoneNumberId: 'pn-x', actor: 'u' });
  if (!b.ok) throw new Error(b.reason);
  await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", b.campaign.id);
  await workspace(ws).campaignPage(b.campaign.id, 1, 0);
  const btnJob = (await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release' AND payload LIKE '%\"btn\"%' ORDER BY id")).map((t) => JSON.parse(t.payload).job)[0];
  const code = (await rows<{ code: string }>(ws, 'SELECT code FROM campaign_links WHERE campaign_id = ? ORDER BY contact_id', b.campaign.id))[0]!.code;
  expect(btnJob.template.components[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
});

async function sentCampaign(ws: string, n = 3) {
  await registerWorkspace(ws);
  await holdAlarm(ws);
  await seedTemplate(ws, { components: BODY_LINK });
  await seedContacts(ws, n);
  const created = await workspace(ws).createCampaign({ name: 'Eid Sale', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'link' }], audience: { criteria: { everyone: true } }, linkUrl: DEST, phoneNumberId: 'pn-x', actor: 'u' });
  if (!created.ok) throw new Error(created.reason);
  await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", created.campaign.id);
  await workspace(ws).campaignPage(created.campaign.id, 1, 0);
  const links = await rows<{ code: string; wa_id: string }>(ws, 'SELECT l.code, c.wa_id FROM campaign_links l JOIN contacts c ON c.id = l.contact_id ORDER BY l.contact_id');
  return { campaign: created.campaign, links };
}
const hit = (code: string, headers: Record<string, string> = {}, method = 'GET') => SELF.fetch(`${BASE}/t/${code}`, { method, redirect: 'manual', headers });

it('/t/:code redirects with 302 and no-store, adds UTM, records one analytics point with the campaign and buyerKey but no phone, and counts clicks', async () => {
  const ws = W(663);
  const { campaign, links } = await sentCampaign(ws);
  const spy = vi.spyOn(env.LINK_CLICKS!, 'writeDataPoint');
  const res = await hit(links[0]!.code, { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://shop.example.com/eid?ref=wa&utm_source=whatsapp&utm_medium=campaign&utm_campaign=eid_sale');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  await hit(links[0]!.code);
  await hit(links[1]!.code);
  expect(spy).toHaveBeenCalledTimes(3);
  const key = await buyerKey(BUYER_SECRET, `+${links[0]!.wa_id}`);
  expect(spy.mock.calls[0]![0]).toEqual({ indexes: [ws], blobs: ['click', campaign.id, key, ws], doubles: [1] });
  expect(JSON.stringify(spy.mock.calls)).not.toContain(links[0]!.wa_id);
  expect(JSON.stringify(spy.mock.calls)).not.toContain(links[0]!.code);
  const view = campaignDto.parse(await workspace(ws).getCampaign(campaign.id));
  expect(view.clicks).toEqual({ unique: 2, total: 3 });
  expect(await rows(ws, 'SELECT clicks, first_click_at IS NOT NULL AS seen FROM campaign_links ORDER BY contact_id')).toEqual([{ clicks: 2, seen: 1 }, { clicks: 1, seen: 1 }, { clicks: 0, seen: 0 }]);
});

it('link-preview bots and HEAD requests are redirected but never counted', async () => {
  const ws = W(664);
  const { campaign, links } = await sentCampaign(ws, 1);
  const spy = vi.spyOn(env.LINK_CLICKS!, 'writeDataPoint');
  expect((await hit(links[0]!.code, { 'user-agent': 'WhatsApp/2.24.1 A' })).status).toBe(302);
  expect((await hit(links[0]!.code, {}, 'HEAD')).status).toBe(302);
  expect(spy).not.toHaveBeenCalled();
  expect((await workspace(ws).getCampaign(campaign.id))?.clicks).toEqual({ unique: 0, total: 0 });
});

it('without the buyer secret the click is still recorded, with an empty buyerKey', async () => {
  const ws = W(665);
  const { links } = await sentCampaign(ws, 1);
  configureCampaignLinks({ baseUrl: () => BASE, buyerSecret: () => undefined, signingSecret: () => LINK_SECRET });
  const spy = vi.spyOn(env.LINK_CLICKS!, 'writeDataPoint');
  expect((await hit(links[0]!.code)).status).toBe(302);
  expect(spy.mock.calls[0]![0]!.blobs![2]).toBe('');
});

it('unknown, malformed, other-workspace and erased codes are a plain 404 that never touches an unregistered workspace', async () => {
  const ws = W(666);
  const { links } = await sentCampaign(ws, 2);
  const notFound = async (code: string) => { const r = await hit(code); expect(r.status, code).toBe(404); expect(r.headers.get('location')).toBeNull(); expect(r.headers.get('cache-control')).toBe('no-store'); };
  await notFound('garbage');
  await notFound(`${ws}.${'A'.repeat(22)}`);
  await notFound(`${W(667)}.${'A'.repeat(22)}`); // a well-formed code for a workspace that does not exist
  await notFound(links[0]!.code.replace(ws, W(668)));
  await notFound(`${ws}.${links[0]!.code.slice(ws.length + 1).slice(0, 21)}`);
  const api = await apiFor(ws);
  expect((await api.call('DELETE', `/contacts/${links[0]!.wa_id}`)).status).toBe(200);
  expect(await rows(ws, 'SELECT 1 FROM campaign_links')).toHaveLength(1);
  await notFound(links[0]!.code);
  expect((await hit(links[1]!.code)).status).toBe(302);
});

it('a link keeps working after the campaign is cancelled', async () => {
  const ws = W(669);
  const { campaign, links } = await sentCampaign(ws, 1);
  await workspace(ws).cancelCampaign(campaign.id);
  expect((await hit(links[0]!.code)).status).toBe(302);
});

it('link rows survive a backup and restore', async () => {
  const ws = W(670);
  await sentCampaign(ws, 2);
  const m = await workspace(ws).exportSnapshot('2026-10-25');
  expect(m.tables.campaign_links?.rows).toBe(2);
  expect(await workspace(W(671)).importSnapshot(`backups/${ws}/2026-10-25/`)).toMatchObject({ ok: true });
  expect(await rows(W(671), 'SELECT 1 FROM campaign_links')).toHaveLength(2);
});
