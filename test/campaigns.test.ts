import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { campaignDto, listCampaignsResponse } from '../src/core/api/contract';
import { PAGE_SIZE, resolveParams } from '../src/core/campaigns/campaigns';
import { runCampaign } from '../src/core/campaigns/workflows';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import {
  PN, campaignMessages, fakeStep, holdAlarm, installWallet, makeCampaign, resetWallet, seedContacts, seedTemplate, setPageSize, setTier, stepsOf,
} from './helpers/campaigns';
import { exec, openChat, rows, workspace } from './helpers/workspace';

useApiKey();
afterEach(() => resetWallet());
const DAY = 86_400_000;
const page = (ws: string, id: string, attempt: number, n: number) => workspace(ws).campaignPage(id, attempt, n);
/** A campaign that has been sent (attempt 1) without starting the real workflow: tests drive the steps themselves. */
async function running(ws: string, c: { id: string }) {
  await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.id);
}

it('the default page is 500 recipients', () => expect(PAGE_SIZE).toBe(500));

it('resolveParams: text as given, name cleaned with its fallback', () => {
  expect(resolveParams([{ kind: 'name', fallback: 'عميلنا' }, { kind: 'text', value: '50%' }], '  Ali \n Hassan ')).toEqual(['Ali Hassan', '50%']);
  expect(resolveParams([{ kind: 'name', fallback: 'عميلنا' }], null)).toEqual(['عميلنا']);
});

it('create checks the template, parameters, audience and role; the draft shows an estimate', async () => {
  const ws = W(630);
  const api = await apiFor(ws);
  const staff = await apiFor(ws, 'staff');
  await seedTemplate(ws);
  await seedTemplate(ws, { name: 'pending_one', status: 'PENDING' });
  await seedTemplate(ws, { name: 'code', category: 'AUTHENTICATION' });
  await seedContacts(ws, 3);
  const body = { name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'text', value: '50%' }], audience: { criteria: { everyone: true } } };
  const ok = await api.call('POST', '/campaigns', body);
  expect(ok.status).toBe(201);
  const camp = campaignDto.parse(await ok.json());
  expect(camp).toMatchObject({ status: 'draft', category: 'MARKETING', estimate: { audience: 3, perMessageMinor: 0, totalMinor: 0 }, totals: { recipients: 0 } });
  expect((await staff.call('POST', '/campaigns', body)).status).toBe(403);
  expect((await api.call('POST', '/campaigns', { ...body, template: { name: 'pending_one', language: 'ar' } })).status).toBe(409);
  expect((await api.call('POST', '/campaigns', { ...body, template: { name: 'nope', language: 'ar' } })).status).toBe(409);
  const auth = await api.call('POST', '/campaigns', { ...body, template: { name: 'code', language: 'ar' } });
  expect(auth.status).toBe(400);
  expect(await auth.json()).toMatchObject({ message: 'wrong_category' });
  const wrongCount = await api.call('POST', '/campaigns', { ...body, params: [{ kind: 'text', value: 'one only' }] });
  expect(wrongCount.status).toBe(400);
  expect(((await wrongCount.json()) as { message: string }).message).toMatch(/needs 2 parameters/);
  expect((await api.call('POST', '/campaigns', { ...body, params: [{ kind: 'text', value: 'a\nb' }, { kind: 'text', value: 'c' }] })).status).toBe(400);
  expect(((await (await api.call('POST', '/campaigns', { ...body, audience: { criteria: { tags: { any: ['nobody'] } } } })).json()) as { message: string }).message).toBe('empty_audience');
  expect((await api.call('POST', '/campaigns', { ...body, audience: { segmentId: 999 } })).status).toBe(404);
  expect((await api.call('POST', '/campaigns', { ...body, audience: { criteria: {} } })).status).toBe(400);
  const seg = await api.call('POST', '/segments', { name: 'all', criteria: { everyone: true } });
  const viaSeg = campaignDto.parse(await (await api.call('POST', '/campaigns', { ...body, audience: { segmentId: ((await seg.json()) as { id: number }).id } })).json());
  expect(viaSeg.audience).toMatchObject({ segmentId: expect.any(Number), criteria: { everyone: true } });
  installWallet({ perMessage: 150 });
  expect(campaignDto.parse(await (await api.call('GET', `/campaigns/${camp.id}`)).json()).estimate).toEqual({ audience: 3, perMessageMinor: 150, totalMinor: 450 });
  expect((await api.call('GET', '/campaigns/not-a-uuid')).status).toBe(404);
  expect(listCampaignsResponse.parse(await (await api.call('GET', '/campaigns')).json()).items).toHaveLength(2);
});

it('a page queues one message per recipient under a stable key, with params, consent and a scheduler row each; cursor and page counter advance', async () => {
  const ws = W(631);
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 4);
  await exec(ws, "UPDATE contacts SET profile_name = NULL WHERE wa_id = '201010000002'");
  const c = await makeCampaign(ws);
  await running(ws, c);
  const calls = installWallet({ perMessage: 100 });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'done', count: 4 });
  const ids = (await rows<{ id: number; wa_id: string }>(ws, 'SELECT id, wa_id FROM contacts ORDER BY id'));
  expect(await campaignMessages(ws)).toEqual(ids.map((r) => ({ idempotency_key: `camp:${c.id}:${r.id}`, status: 'queued', error_reason: null })));
  const tasks = await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release' ORDER BY id");
  expect(tasks).toHaveLength(4);
  const job = JSON.parse(tasks[2]!.payload).job;
  expect(job).toMatchObject({ to: '201010000002', idempotencyKey: `camp:${c.id}:${ids[2]!.id}`, template: { name: 'promo', language: 'ar', components: [{ type: 'body', parameters: [{ type: 'text', text: 'عميلنا' }, { type: 'text', text: '50%' }] }] } });
  expect(JSON.parse(tasks[0]!.payload).job.template.components[0].parameters[0].text).toBe('Cust 0');
  expect(await rows(ws, 'SELECT campaign_id, page, count, done, reserve_ref, reserved_minor, settled FROM campaign_pages')).toEqual([{ campaign_id: c.id, page: 0, count: 4, done: 1, reserve_ref: `camp:${c.id}:p0`, reserved_minor: 400, settled: 1 }]);
  expect(calls.reserve).toEqual([{ ref: `camp:${c.id}:p0`, minor: 400 }]);
  expect(calls.settle).toEqual([{ ref: `camp:${c.id}:p0`, outcome: { recipients: 4, ended: 'completed' } }]);
  const done = campaignDto.parse(await workspace(ws).getCampaign(c.id));
  expect(done).toMatchObject({ status: 'completed', counts: { queued: 4 }, totals: { recipients: 4, pending: 4, sent: 0 } });
});

it('pages are in order: 5 contacts in pages of 2 are 2, 2, 1 (done); an exact multiple ends with an empty last page', async () => {
  const ws = W(632);
  await seedTemplate(ws);
  await seedContacts(ws, 5);
  await setPageSize(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws, c.id, 1, 2)).toEqual({ state: 'stop', reason: 'out_of_order' });
  expect(await page(ws, c.id, 1, 1)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws, c.id, 1, 2)).toEqual({ state: 'done', count: 1 });
  expect((await campaignMessages(ws))).toHaveLength(5);
  const ws2 = W(633);
  await seedTemplate(ws2);
  await seedContacts(ws2, 4);
  await setPageSize(ws2, 2);
  const c2 = await makeCampaign(ws2);
  await running(ws2, c2);
  expect(await page(ws2, c2.id, 1, 0)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws2, c2.id, 1, 1)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws2, c2.id, 1, 2)).toEqual({ state: 'done', count: 0 });
  expect((await workspace(ws2).getCampaign(c2.id))?.status).toBe('completed');
});

it('a step that runs again gets the stored answer and queues nothing twice, even if its reservation was retried first', async () => {
  const ws = W(634);
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  await setPageSize(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  let n = 0;
  const calls = installWallet({ perMessage: 10, refuse: () => false, onReserve: async () => { if (++n === 1) throw new Error('reserve call failed after the wallet took it'); } });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'retry', reason: 'wallet_unavailable' }); // nothing queued; the step is asked to try again
  expect(await campaignMessages(ws)).toEqual([]);
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 2 }); // a replayed step: stored answer
  expect(calls.reserve.map((r) => r.ref)).toEqual([`camp:${c.id}:p0`, `camp:${c.id}:p0`]); // the SAME ref both times; none on the replay
  expect(await campaignMessages(ws)).toHaveLength(2);
  expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toHaveLength(2);
  expect(await rows(ws, 'SELECT 1 FROM campaign_pages')).toHaveLength(1);
});

it('two overlapping calls for the same page queue it once and release nothing the winner holds', async () => {
  const ws = W(635);
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  const c = await makeCampaign(ws);
  await running(ws, c);
  const calls = installWallet({ perMessage: 5, reserveDelayMs: 20 });
  const [a, b] = await Promise.all([page(ws, c.id, 1, 0), page(ws, c.id, 1, 0)]);
  expect(a).toEqual(b);
  expect(await campaignMessages(ws)).toHaveLength(3);
  expect(calls.settle.filter((s) => s.outcome.ended === 'abandoned')).toEqual([]);
  expect(calls.settle).toHaveLength(1);
});

it('an old workflow generation, a paused or cancelled campaign, or a withdrawn template stop the instance', async () => {
  const ws = W(636);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  const c = await makeCampaign(ws);
  expect(await workspace(ws).campaignStart(c.id, 0)).toEqual({ state: 'stop', reason: 'draft' });
  await running(ws, c);
  expect(await page(ws, c.id, 0, 0)).toEqual({ state: 'stop', reason: 'superseded' });
  expect(await workspace(ws).campaignStart(c.id, 1)).toEqual({ state: 'go', scheduledAt: null, nextPage: 0 });
  await exec(ws, "UPDATE templates SET status = 'DISABLED'");
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'stop', reason: 'template_unavailable' });
  expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'template_unavailable' });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'stop', reason: 'paused' });
  expect(await campaignMessages(ws)).toEqual([]);
  expect(await workspace(ws).campaignStart('00000000-0000-4000-8000-000000000000', 1)).toEqual({ state: 'stop', reason: 'not_found' });
});

it('the wallet running dry pauses the campaign with wallet_empty; pages already reserved keep going; resume continues from the cursor', async () => {
  const ws = W(637);
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 5);
  await setPageSize(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  const calls = installWallet({ perMessage: 100, refuse: (ref) => ref.endsWith(':p1') });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws, c.id, 1, 1)).toEqual({ state: 'stop', reason: 'wallet_empty' });
  expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'wallet_empty', totals: { recipients: 2 } });
  expect(calls.reserve).toEqual([{ ref: `camp:${c.id}:p0`, minor: 200 }, { ref: `camp:${c.id}:p1`, minor: 200 }]);
  expect(await campaignMessages(ws)).toHaveLength(2); // nothing from the refused page
  // the first page was paid for: its sends are NOT parked
  const due = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(due.every((t) => t.due_at < Date.now() + 60_000 && JSON.parse(t.payload).reason !== 'campaign_paused')).toBe(true);
  // top up, resume: the refused page is asked for again and goes through
  calls.reserve.length = 0;
  installWallet({ perMessage: 100 });
  const resumed = await workspace(ws).resumeCampaign(c.id);
  expect(resumed.ok && resumed.campaign.status).toBe('running');
  const attempt = (await rows<{ attempt: number }>(ws, 'SELECT attempt FROM campaigns'))[0]!.attempt;
  expect(attempt).toBe(2);
  expect(await page(ws, c.id, attempt, 1)).toEqual({ state: 'next', count: 2 });
  expect(await page(ws, c.id, attempt, 2)).toEqual({ state: 'done', count: 1 });
  expect(await campaignMessages(ws)).toHaveLength(5);
});

it('a recipient who opts out while the page is being reserved is skipped, not messaged', async () => {
  const ws = W(638);
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  const c = await makeCampaign(ws);
  await running(ws, c);
  installWallet({ onReserve: () => exec(ws, "UPDATE contacts SET opted_out_at = 99 WHERE wa_id = '201010000001'") });
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'done', count: 2 });
  expect(await campaignMessages(ws)).toHaveLength(2);
  expect((await workspace(ws).getCampaign(c.id))?.counts).toMatchObject({ queued: 2, skipped: 1 });
  expect(await rows(ws, "SELECT skip_reason FROM campaign_recipients WHERE state = 'skipped'")).toEqual([{ skip_reason: 'opted_out' }]);
});

it('the number tier paces pages: a full tier waits for the oldest slot to expire, then the next page proceeds', async () => {
  const ws = W(639);
  await seedTemplate(ws);
  await seedContacts(ws, 5);
  await setTier(ws, 3);
  const c = await makeCampaign(ws);
  await running(ws, c);
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 3 }); // room is exactly the tier
  const soon = await page(ws, c.id, 1, 1);
  expect(soon.state).toBe('wait'); // 3 sends still on their way
  expect(soon.state === 'wait' && soon.until).toBeLessThan(Date.now() + 60_000);
  // Meta takes them: they use 3 slots, started 1 h ago
  const hourAgo = Date.now() - 3_600_000;
  await exec(ws, "UPDATE messages SET status = 'sent' WHERE idempotency_key LIKE 'camp:%'");
  await exec(ws, 'INSERT INTO tier_slots (phone_number_id, contact_id, started_at) SELECT ?, id, ? FROM contacts LIMIT 3', PN, hourAgo);
  const full = await page(ws, c.id, 1, 1);
  expect(full).toEqual({ state: 'wait', until: hourAgo + DAY + 1000 });
  await exec(ws, 'UPDATE tier_slots SET started_at = started_at - ?', DAY);
  expect(await page(ws, c.id, 1, 1)).toEqual({ state: 'done', count: 2 });
  expect((await campaignMessages(ws))).toHaveLength(5);
});

it('daily_send_limit caps how many are queued per rolling 24 h; the rest wait for the oldest of them to age out', async () => {
  const ws = W(640);
  await seedTemplate(ws);
  await seedContacts(ws, 5);
  const c = await makeCampaign(ws, { dailySendLimit: 2 });
  await running(ws, c);
  expect(await page(ws, c.id, 1, 0)).toEqual({ state: 'next', count: 2 });
  await exec(ws, "UPDATE messages SET status = 'sent' WHERE idempotency_key LIKE 'camp:%'");
  const wait = await page(ws, c.id, 1, 1);
  const first = (await rows<{ at: number }>(ws, 'SELECT min(at) AS at FROM campaign_recipients'))[0]!.at;
  expect(wait).toEqual({ state: 'wait', until: first + DAY + 1000 });
  await exec(ws, 'UPDATE campaign_recipients SET at = at - ?', DAY + 5000);
  expect(await page(ws, c.id, 1, 1)).toEqual({ state: 'next', count: 2 });
});

it('the workflow loop sleeps until the tier has room, replays a step without queueing twice, and ends when the audience is done', async () => {
  const ws = W(641);
  await seedTemplate(ws);
  await seedContacts(ws, 5);
  await setTier(ws, 3);
  const c = await makeCampaign(ws);
  await running(ws, c);
  const hourAgo = Date.now() - 3_600_000;
  const { step, sleeps, done } = fakeStep({
    replay: ['page-0', 'page-2'],
    onSleep: async (name) => {
      if (name === 'wait-1') {
        await exec(ws, "UPDATE messages SET status = 'sent' WHERE idempotency_key LIKE 'camp:%'");
        await exec(ws, 'INSERT INTO tier_slots (phone_number_id, contact_id, started_at) SELECT ?, id, ? FROM contacts LIMIT 3', PN, hourAgo);
      } else {
        await exec(ws, 'UPDATE tier_slots SET started_at = started_at - ?', DAY);
      }
    },
  });
  const out = await runCampaign(step, stepsOf(ws), { workspaceId: ws, campaignId: c.id, attempt: 1 });
  expect(out).toEqual({ ended: 'completed', pages: 2 });
  expect(done).toEqual(['start', 'page-0', 'page-1', 'page-2', 'page-3']);
  expect(sleeps.map((s) => s.name)).toEqual(['wait-1', 'wait-2']);
  expect(sleeps[1]!.ts).toBe(hourAgo + DAY + 1000);
  expect(await campaignMessages(ws)).toHaveLength(5);
  expect(await rows(ws, 'SELECT 1 FROM campaign_recipients')).toHaveLength(5);
});

it('a scheduled campaign sleeps until its time, then activates once; paused before then, it ends without sending', async () => {
  const ws = W(642);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  const c = await makeCampaign(ws);
  const at = Date.now() + 2 * 3_600_000;
  const sent = await workspace(ws).sendCampaign(c.id, at);
  expect(sent.ok && sent.campaign).toMatchObject({ status: 'scheduled', scheduledAt: at });
  const attempt = (await rows<{ attempt: number }>(ws, 'SELECT attempt FROM campaigns'))[0]!.attempt;
  const a = fakeStep();
  expect(await runCampaign(a.step, stepsOf(ws), { workspaceId: ws, campaignId: c.id, attempt })).toEqual({ ended: 'completed', pages: 1 });
  expect(a.sleeps).toEqual([{ name: 'scheduled', ts: at }]);
  expect(a.done.slice(0, 3)).toEqual(['start', 'activate', 'page-0']);
  expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'completed', startedAt: expect.any(Number) });
  // second campaign: the merchant pauses while the instance sleeps
  const ws2 = W(643);
  await seedTemplate(ws2);
  await seedContacts(ws2, 2);
  const c2 = await makeCampaign(ws2);
  await workspace(ws2).sendCampaign(c2.id, at);
  const attempt2 = (await rows<{ attempt: number }>(ws2, 'SELECT attempt FROM campaigns'))[0]!.attempt;
  const b = fakeStep({ onSleep: async () => { await workspace(ws2).pauseCampaign(c2.id); } });
  expect(await runCampaign(b.step, stepsOf(ws2), { workspaceId: ws2, campaignId: c2.id, attempt: attempt2 })).toEqual({ ended: 'paused', pages: 0 });
  expect(await campaignMessages(ws2)).toEqual([]);
});

it('the real workflow runs a campaign end to end (start, page, done) and a second generation retires the first', async () => {
  const ws = W(644);
  const api = await apiFor(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  const created = campaignDto.parse(await (await api.call('POST', '/campaigns', { name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'text', value: '50%' }], audience: { criteria: { everyone: true } } })).json());
  const instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `${created.id}-1`);
  try {
    await instance.modify(async (m) => { await m.disableRetryDelays(); });
    const res = await api.call('POST', `/campaigns/${created.id}/send`, {});
    expect(res.status).toBe(202);
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({ ended: 'completed', pages: 1 });
  } finally {
    await instance.dispose();
  }
  const done = campaignDto.parse(await (await api.call('GET', `/campaigns/${created.id}`)).json());
  expect(done).toMatchObject({ status: 'completed', totals: { recipients: 3 } });
  expect((await api.call('POST', `/campaigns/${created.id}/send`, {})).status).toBe(409); // already sent
});

it('pause parks unsent messages (even one already in the queue), resume releases them and starts a new generation', async () => {
  const ws = W(645);
  const api = await apiFor(ws);
  const staff = await apiFor(ws, 'staff');
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  await setPageSize(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  await page(ws, c.id, 1, 0);
  const jobs = (await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release' ORDER BY id")).map((t) => JSON.parse(t.payload).job);
  const paused = await staff.call('POST', `/campaigns/${c.id}/pause`);
  expect(paused.status).toBe(200);
  expect(campaignDto.parse(await paused.json())).toMatchObject({ status: 'paused', pauseReason: 'manual' });
  const parked = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(parked).toHaveLength(2);
  expect(parked.every((t) => t.due_at > Date.now() + 20 * DAY && JSON.parse(t.payload).reason === 'campaign_paused')).toBe(true);
  // a job that had already left the scheduler for the queue is parked when it comes back
  await exec(ws, "DELETE FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(await workspace(ws).claimSend(jobs[0])).toBe('deferred');
  expect((await campaignMessages(ws))[0]!.status).toBe('queued');
  expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toHaveLength(1);
  expect((await staff.call('POST', `/campaigns/${c.id}/resume`)).status).toBe(403);
  expect((await api.call('POST', `/campaigns/${c.id}/pause`)).status).toBe(409);
  const back = await api.call('POST', `/campaigns/${c.id}/resume`);
  expect(campaignDto.parse(await back.json())).toMatchObject({ status: 'running', pauseReason: null });
  const after = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(after.every((t) => t.due_at <= Date.now() && JSON.parse(t.payload).reason === 'event')).toBe(true);
  expect(await workspace(ws).claimSend(jobs[0])).toBe('claimed');
  expect((await rows<{ attempt: number }>(ws, 'SELECT attempt FROM campaigns'))[0]!.attempt).toBe(2);
});

it('cancel fails unsent messages, removes their scheduled sends, makes a late queue copy a no-op and settles the wallet', async () => {
  const ws = W(646);
  const api = await apiFor(ws);
  const staff = await apiFor(ws, 'staff');
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 4);
  await setPageSize(ws, 3);
  const c = await makeCampaign(ws);
  await running(ws, c);
  const calls = installWallet();
  await page(ws, c.id, 1, 0);
  const job = JSON.parse((await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release'"))[0]!.payload).job;
  await exec(ws, "UPDATE messages SET status = 'claimed' WHERE id = (SELECT min(id) FROM messages)"); // one is already with Meta
  const res = await staff.call('POST', `/campaigns/${c.id}/cancel`);
  expect(res.status).toBe(200);
  expect(campaignDto.parse(await res.json())).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Number) });
  expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toEqual([]);
  const msgs = await campaignMessages(ws);
  expect(msgs.map((m) => [m.status, m.error_reason])).toEqual([['claimed', null], ['failed', 'campaign_cancelled'], ['failed', 'campaign_cancelled']]);
  expect((await workspace(ws).getCampaign(c.id))?.counts).toMatchObject({ claimed: 1, failed: 2 });
  expect((await workspace(ws).getCampaign(c.id))?.totals).toMatchObject({ recipients: 3, failed: 2, pending: 1 });
  expect(await workspace(ws).claimSend(job)).toBe('in_flight'); // the claimed one is not touched
  expect(calls.settle).toEqual([{ ref: `camp:${c.id}:p0`, outcome: { recipients: 3, ended: 'cancelled' } }]);
  expect(await page(ws, c.id, 1, 1)).toEqual({ state: 'stop', reason: 'cancelled' });
  expect((await api.call('POST', `/campaigns/${c.id}/cancel`)).status).toBe(409);
  expect((await api.call('POST', `/campaigns/${c.id}/send`, {})).status).toBe(409);
  // a copy of a cancelled campaign's job that was already in the queue is acknowledged without sending
  const failedKey = (await campaignMessages(ws)).find((m) => m.status === 'failed')!.idempotency_key;
  expect(await workspace(ws).claimSend({ ...job, idempotencyKey: failedKey, to: '201010000001' })).toBe('already_sent');
});

it('a draft can be deleted by the owner, a sent campaign cannot', async () => {
  const ws = W(647);
  const api = await apiFor(ws);
  const staff = await apiFor(ws, 'staff');
  await seedTemplate(ws);
  await seedContacts(ws, 1);
  const a = await makeCampaign(ws);
  const b = await makeCampaign(ws);
  await exec(ws, "UPDATE campaigns SET status = 'running' WHERE id = ?", b.id);
  expect((await staff.call('DELETE', `/campaigns/${a.id}`)).status).toBe(403);
  expect((await api.call('DELETE', `/campaigns/${a.id}`)).status).toBe(204);
  expect((await api.call('DELETE', `/campaigns/${a.id}`)).status).toBe(404);
  expect((await api.call('DELETE', `/campaigns/${b.id}`)).status).toBe(409);
});

it('send refuses an empty audience or a withdrawn template at send time, and a schedule more than a year out', async () => {
  const ws = W(648);
  await seedTemplate(ws);
  await seedContacts(ws, 1);
  const c = await makeCampaign(ws);
  expect(await workspace(ws).sendCampaign(c.id, Date.now() + 400 * DAY)).toEqual({ ok: false, reason: 'invalid_schedule' });
  await exec(ws, 'UPDATE contacts SET opted_out_at = 5');
  expect(await workspace(ws).sendCampaign(c.id)).toEqual({ ok: false, reason: 'empty_audience' });
  await exec(ws, 'UPDATE contacts SET opted_out_at = NULL');
  await exec(ws, "UPDATE templates SET status = 'REJECTED'");
  expect(await workspace(ws).sendCampaign(c.id)).toEqual({ ok: false, reason: 'template_not_approved' });
  expect(await workspace(ws).sendCampaign('00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
});

it('a STOP after the message was queued still wins at send time', async () => {
  const ws = W(649);
  await holdAlarm(ws);
  await seedTemplate(ws);
  await openChat(ws, '201000000001');
  await exec(ws, "UPDATE contacts SET consent_source = 'import:x', consent_at = 1");
  const c = await makeCampaign(ws);
  await running(ws, c);
  await page(ws, c.id, 1, 0);
  const job = JSON.parse((await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release'"))[0]!.payload).job;
  await workspace(ws).ingest({ phoneNumberId: PN, inbound: [{ wamid: 'stop.649', from: '201000000001', ts: Math.floor(Date.now() / 1000), type: 'text', text: 'stop' }], statuses: [], receivedAt: 1 });
  expect(await workspace(ws).claimSend(job)).toBe('dropped');
  expect(await campaignMessages(ws)).toEqual([expect.objectContaining({ status: 'failed', error_reason: 'opted_out' })]);
});

it('erasing a recipient removes its campaign rows and a leftover queue copy is dropped', async () => {
  const ws = W(650);
  const api = await apiFor(ws);
  await holdAlarm(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  await page(ws, c.id, 1, 0);
  const job = JSON.parse((await rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release' ORDER BY id"))[0]!.payload).job;
  expect((await api.call('DELETE', `/contacts/${job.to}`)).status).toBe(200);
  expect(await rows(ws, 'SELECT 1 FROM campaign_recipients')).toHaveLength(1);
  expect((await workspace(ws).getCampaign(c.id))?.totals.recipients).toBe(1);
  expect(await workspace(ws).claimSend(job)).toBe('dropped');
  expect(await campaignMessages(ws)).toHaveLength(1);
});

it('the sweep restarts a campaign whose workflow is gone, pauses one that keeps dying, and retries a failed wallet settlement', async () => {
  const ws = W(651);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  const c = await makeCampaign(ws);
  await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 7 WHERE id = ?", c.id); // no instance `<id>-7` exists
  await workspace(ws).schedule('campaign_step', Date.now() - 1);
  await workspace(ws).runDueTasks();
  expect((await rows<{ attempt: number }>(ws, 'SELECT attempt FROM campaigns'))[0]!.attempt).toBe(8);
  expect((await env.CAMPAIGN_WORKFLOW.get(`${c.id}-8`).then((i) => i.status())).status).toMatch(/queued|running|complete|waiting/);
  const next = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'campaign_step'");
  expect(next).toHaveLength(1);
  expect(next[0]!.due_at).toBeGreaterThan(Date.now() + 5 * 60_000); // watches again while the campaign is active
  // dying forever -> paused with internal_error
  await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 30 WHERE id = ?", c.id);
  await workspace(ws).schedule('campaign_step', Date.now() - 1);
  await workspace(ws).runDueTasks();
  expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'internal_error' });
  // a settlement that failed is retried
  const ws2 = W(652);
  await seedTemplate(ws2);
  await seedContacts(ws2, 1);
  const c2 = await makeCampaign(ws2);
  await running(ws2, c2);
  const calls = installWallet({ failSettleTimes: 1 });
  expect(await page(ws2, c2.id, 1, 0)).toEqual({ state: 'done', count: 1 }); // the failed release does not fail the step
  expect(calls.settle).toEqual([]);
  expect((await workspace(ws2).getCampaign(c2.id))?.status).toBe('completed'); // queued and finished; only the wallet release is owed
  expect(await rows(ws2, 'SELECT settled FROM campaign_pages')).toEqual([{ settled: 0 }]);
  await workspace(ws2).schedule('campaign_step', Date.now() - 1);
  await workspace(ws2).runDueTasks();
  expect(calls.settle).toEqual([{ ref: `camp:${c2.id}:p0`, outcome: { recipients: 1, ended: 'completed' } }]);
  expect(await rows(ws2, "SELECT 1 FROM scheduled_tasks WHERE kind = 'campaign_step'")).toEqual([]); // nothing left to watch
});

it('campaigns, pages and recipients survive a backup and restore, and a restored running campaign is picked up by the sweep', async () => {
  const ws = W(653);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  const c = await makeCampaign(ws);
  await running(ws, c);
  await page(ws, c.id, 1, 0);
  await exec(ws, "UPDATE campaigns SET status = 'running'");
  const m = await workspace(ws).exportSnapshot('2026-10-25');
  expect([m.tables.campaigns?.rows, m.tables.campaign_pages?.rows, m.tables.campaign_recipients?.rows]).toEqual([1, 1, 2]);
  const ws2 = W(654);
  expect(await workspace(ws2).importSnapshot(`backups/${ws}/2026-10-25/`)).toMatchObject({ ok: true });
  expect(await rows(ws2, 'SELECT id, status FROM campaigns')).toEqual([{ id: c.id, status: 'running' }]);
  expect(await rows(ws2, "SELECT 1 FROM scheduled_tasks WHERE kind = 'campaign_step'")).toHaveLength(1);
  void runInDurableObject;
});
