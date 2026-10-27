import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ERASURE_TARGETS } from '../src/core/erasure-targets';
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

describe('what a purge leaves behind (review)', () => {
  const pending = (ws: string) => rows<{ key: string }>(ws, 'SELECT key FROM r2_pending_deletes').then((r) => r.map((x) => x.key));

  it('an R2 object two messages share is kept until the LAST one is purged, then queued once', async () => {
    const ws = W(4010);
    await own(ws);
    const nowS = Math.floor(Date.now() / 1000);
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [
      { wamid: `wamid.x.${ws}`, from: A, ts: nowS - 400 * 86400, type: 'text', text: 'قديمة' },
      { wamid: `wamid.y.${ws}`, from: A, ts: nowS - 40 * 86400, type: 'text', text: 'أحدث' },
    ], statuses: [], receivedAt: Date.now() });
    await env.MEDIA.put(`media/${ws}/shared`, 'campaign image');
    await exec(ws, "UPDATE messages SET media_r2_key = ?, media_mime = 'image/jpeg' WHERE wamid LIKE 'wamid.%'", `media/${ws}/shared`);
    await exec(ws, "INSERT INTO uploads (id, meta_media_id, mime, size, r2_key, created_at) VALUES ('u-shared', 'm', 'image/jpeg', 3, ?, 1)", `media/${ws}/shared`);
    await workspace(ws).setRetention(90); // purges the 400-day-old one only
    expect(await workspace(ws).retentionPurge(Date.now())).toMatchObject({ deleted: 1 });
    expect(await pending(ws)).toEqual([]); // not queued: the newer message still points at it
    expect(await env.MEDIA.get(`media/${ws}/shared`)).not.toBeNull();
    expect(await rows(ws, 'SELECT 1 FROM uploads')).toHaveLength(1);
    expect(await rows(ws, 'SELECT media_r2_key FROM messages')).toEqual([{ media_r2_key: `media/${ws}/shared` }]);
    await workspace(ws).setRetention(30); // now the 40-day-old one goes too
    expect(await workspace(ws).retentionPurge(Date.now())).toMatchObject({ deleted: 1 });
    expect(await env.MEDIA.get(`media/${ws}/shared`)).toBeNull(); // queued once and drained
    expect(await rows(ws, 'SELECT 1 FROM uploads')).toEqual([]);
  });

  it('realtime events about a purged message go too (by message id and by age), and so does everything else in the shared list', async () => {
    const ws = W(4011);
    await seed(ws, 2, 1);
    await workspace(ws).setRetention(90);
    const old = await rows<{ id: number; wamid: string }>(ws, "SELECT id, wamid FROM messages WHERE wamid LIKE 'wamid.old.%'");
    const fresh = await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE wamid LIKE 'wamid.new.%'");
    for (const m of old) await exec(ws, "INSERT INTO agent_turns (message_id, outcome, at) VALUES (?, 'replied', 1)", m.id);
    await exec(ws, "INSERT INTO events (payload, at) VALUES (?, ?)", JSON.stringify({ type: 'message.status', conversationId: 1, messageId: old[0]!.id, status: 'read' }), Date.now());
    await exec(ws, "INSERT INTO events (payload, at) VALUES (?, ?)", JSON.stringify({ type: 'message.created', conversationId: 1, message: { id: old[1]!.id, text: 'سر قديم' } }), Date.now());
    await exec(ws, "INSERT INTO events (payload, at) VALUES (?, ?)", JSON.stringify({ type: 'message.status', conversationId: 1, messageId: fresh[0]!.id, status: 'read' }), Date.now());
    await exec(ws, "INSERT INTO events (payload, at) VALUES ('{\"type\":\"x\"}', ?)", Date.now() - 400 * DAY); // old by AGE, mentions no message
    await exec(ws, "INSERT INTO events (payload, at) VALUES ('{\"type\":\"y\"}', ?)", Date.now());
    await workspace(ws).retentionPurge(Date.now());

    const ids = old.map((m) => m.id);
    const wamidsOld = old.map((m) => m.wamid);
    for (const t of ERASURE_TARGETS.filter((x) => x.purge)) {
      const n = await rows<{ n: number }>(ws, t.by === 'wamid' ? `SELECT count(*) AS n FROM ${t.table} WHERE wamid IN (${wamidsOld.map(() => '?').join(',')})` : t.by === 'message_id' ? `SELECT count(*) AS n FROM ${t.table} WHERE message_id IN (${ids.map(() => '?').join(',')})`
        : t.by === 'event_payload' ? `SELECT count(*) AS n FROM events WHERE json_extract(payload, '$.messageId') IN (${ids.map(() => '?').join(',')}) OR json_extract(payload, '$.message.id') IN (${ids.map(() => '?').join(',')}) OR json_extract(payload, '$.type') IN ('x')`
          : `SELECT count(*) AS n FROM ${t.table} WHERE id IN (${ids.map(() => '?').join(',')})`,
      ...(t.by === 'wamid' ? wamidsOld : t.by === 'event_payload' ? [...ids, ...ids] : ids));
      expect(n[0]!.n, `${t.table} still holds a purged message`).toBe(0);
    }
    const left = await rows<{ payload: string }>(ws, 'SELECT payload FROM events');
    expect(left.map((e) => JSON.parse(e.payload).type)).toContain('y'); // an unrelated fresh event survives
    expect(JSON.stringify(left)).not.toContain('سر قديم');
    expect(left.some((e) => JSON.parse(e.payload).messageId === fresh[0]!.id)).toBe(true); // and the fresh message's own event
  });
});
