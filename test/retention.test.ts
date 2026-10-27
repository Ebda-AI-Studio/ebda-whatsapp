import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_DAYS } from '../src/core/retention';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { fund } from './helpers/billing';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
const DAY = 86_400_000;
const A = '201001234567';

/** One chat with `old` messages from 400 days ago (one with an R2 body, one with media + an upload row, status events, search text) and `fresh` from today. */
async function seed(ws: string, old = 3, fresh = 2) {
  await own(ws);
  const nowS = Math.floor(Date.now() / 1000);
  const inbound = [
    ...Array.from({ length: old }, (_, i) => ({ wamid: `wamid.old.${ws}.${i}`, from: A, ts: nowS - 400 * 86400 + i, type: 'text' as const, text: `قديمة ${i} كلمةفريدة` })),
    ...Array.from({ length: fresh }, (_, i) => ({ wamid: `wamid.new.${ws}.${i}`, from: A, ts: nowS - 10 + i, type: 'text' as const, text: `جديدة ${i}` })),
  ];
  await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound, statuses: old > 0 ? [{ wamid: `wamid.old.${ws}.0`, status: 'read', ts: 2000 }] : [], receivedAt: Date.now() });
  const oldMs = Date.now() - 400 * DAY;
  await exec(ws, "UPDATE messages SET created_at = ? WHERE wamid LIKE 'wamid.old.%'", oldMs);
  await env.MEDIA.put(`bodies/${ws}/old-body`, 'x'.repeat(2000));
  await env.MEDIA.put(`media/${ws}/old-media`, 'img');
  await exec(ws, "UPDATE messages SET body_r2_key = ? WHERE wamid = ?", `bodies/${ws}/old-body`, `wamid.old.${ws}.0`);
  await exec(ws, "UPDATE messages SET media_r2_key = ?, media_mime = 'image/jpeg' WHERE wamid = ?", `media/${ws}/old-media`, `wamid.old.${ws}.1`);
  await exec(ws, "INSERT INTO uploads (id, meta_media_id, mime, size, r2_key, created_at) VALUES ('u1', 'm1', 'image/jpeg', 3, ?, ?)", `media/${ws}/old-media`, oldMs);
}
const wamids = (ws: string) => rows<{ wamid: string }>(ws, 'SELECT wamid FROM messages ORDER BY id').then((r) => r.map((x) => x.wamid));

describe('the policy', () => {
  it('has a platform default, is set by the owner within bounds, and resets', async () => {
    const ws = W(4001);
    await own(ws);
    const owner = await apiFor(ws);
    expect(await (await owner.call('GET', '/retention')).json()).toEqual({ days: null, effectiveDays: DEFAULT_RETENTION_DAYS, defaultDays: DEFAULT_RETENTION_DAYS, minDays: 30, maxDays: 3650 });
    for (const bad of [29, 3651, 1.5, 'x', undefined]) expect((await owner.call('PUT', '/retention', { days: bad })).status, String(bad)).toBe(400);
    expect((await owner.call('PUT', '/retention', { days: 90 })).status).toBe(200);
    expect(await (await owner.call('GET', '/retention')).json()).toMatchObject({ days: 90, effectiveDays: 90 });
    expect((await owner.call('PUT', '/retention', { days: null })).status).toBe(200);
    expect(await (await owner.call('GET', '/retention')).json()).toMatchObject({ days: null, effectiveDays: DEFAULT_RETENTION_DAYS });
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('PUT', '/retention', { days: 90 })).status).toBe(403);
    expect((await staff.call('GET', '/retention')).status).toBe(403);
  });
});

describe('the purge', () => {
  it('deletes messages older than the window with their R2 bodies, media, uploads, status events and search rows; keeps newer ones, the contact and the money', async () => {
    const ws = W(4002);
    await seed(ws);
    await fund(ws, 1000);
    await workspace(ws).setRetention(90);
    const money = await rows(ws, 'SELECT count(*) AS n FROM wallet_ledger');
    const r = await workspace(ws).retentionPurge(Date.now());
    expect(r).toMatchObject({ deleted: 3, more: false });
    expect(await wamids(ws)).toEqual([`wamid.new.${ws}.0`, `wamid.new.${ws}.1`]);
    expect(await rows(ws, 'SELECT 1 FROM message_status_events')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM uploads')).toEqual([]);
    expect(await workspace(ws).search('كلمةفريدة', 10)).toEqual([]);
    expect(await env.MEDIA.get(`bodies/${ws}/old-body`)).toBeNull();
    expect(await env.MEDIA.get(`media/${ws}/old-media`)).toBeNull();
    expect(await rows(ws, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: A }]);
    expect(await rows(ws, 'SELECT count(*) AS n FROM wallet_ledger')).toEqual(money);
  });

  it('a window the owner shortened takes effect at once (a purge is scheduled), and a longer window keeps more', async () => {
    const ws = W(4003);
    await seed(ws, 2, 1);
    await exec(ws, 'UPDATE messages SET created_at = ? WHERE wamid = ?', Date.now() - 40 * DAY, `wamid.new.${ws}.0`);
    const owner = await apiFor(ws);
    expect((await owner.call('PUT', '/retention', { days: 3650 })).status).toBe(200);
    await workspace(ws).runDueTasks(Date.now() + 2 * 60_000);
    expect(await wamids(ws)).toHaveLength(3); // 3650 days keeps even the 400-day-old ones
    expect((await owner.call('PUT', '/retention', { days: 30 })).status).toBe(200);
    await workspace(ws).runDueTasks(Date.now() + 2 * 60_000);
    expect(await wamids(ws)).toEqual([]); // the 40-day-old and the 400-day-old are past 30 days; the fresh one was moved to 40 days too
  });

  it('is bounded per pass and continues: a big backlog is not one giant transaction', async () => {
    const ws = W(4004);
    await seed(ws, 250, 1);
    await workspace(ws).setRetention(90);
    const first = await workspace(ws).retentionPurge(Date.now(), { batch: 100, maxBatches: 2 });
    expect(first).toEqual({ deleted: 200, more: true });
    expect(await rows(ws, 'SELECT 1 FROM scheduled_tasks WHERE kind = ?', 'retention_purge')).toHaveLength(1); // continuation
    const second = await workspace(ws).retentionPurge(Date.now(), { batch: 100, maxBatches: 2 });
    expect(second).toEqual({ deleted: 50, more: false });
    expect(await wamids(ws)).toEqual([`wamid.new.${ws}.0`]);
  });

  it('runs on its own every day (a daily task is armed)', async () => {
    const ws = W(4005);
    await seed(ws, 1, 1);
    expect((await rows<{ kind: string }>(ws, "SELECT kind FROM scheduled_tasks WHERE kind = 'retention_purge'")).length).toBe(1);
  });

  it('a restore from a backup older than the window purges again, so deleted history does not come back', async () => {
    const ws = W(4006);
    await seed(ws, 2, 1);
    await workspace(ws).setRetention(90); // kept in store_state, so the backup carries it; the purge it schedules has not run yet
    await workspace(ws).exportSnapshot('2026-10-27');
    const target = `${ws}-restored`;
    expect((await workspace(target).importSnapshot(`backups/${ws}/2026-10-27/`)).ok).toBe(true);
    expect(await wamids(target)).toHaveLength(3);
    await workspace(target).runDueTasks(Date.now() + 2 * 60_000);
    expect(await wamids(target)).toEqual([`wamid.new.${ws}.0`]);
  });
});
