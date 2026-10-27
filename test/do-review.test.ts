import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { referencedElsewhereSql } from '../src/core/retention';
import { COOLING_OFF_MS, runOffboarding } from '../src/core/ops/offboarding';
import { OP1, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const W = (n: number) => W0(2700 + n);
const nowS = () => Math.floor(Date.now() / 1000);
const CONTACTS = ['201001110001', '201001110002', '201001110003'];

/** One campaign image (a single R2 key + uploads row) sent to three contacts. */
async function campaignImage(ws: string) {
  await own(ws);
  const key = `media/${ws}/campaign-img`;
  await env.MEDIA.put(key, 'img');
  for (const [i, wa] of CONTACTS.entries()) {
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.ci.${ws}.${i}`, from: wa, ts: nowS() - 50 + i, type: 'text', text: `hi ${i}` }], statuses: [], receivedAt: Date.now() });
    await exec(ws, "UPDATE messages SET media_r2_key = ?, media_mime = 'image/jpeg' WHERE wamid = ?", key, `wamid.ci.${ws}.${i}`);
  }
  await exec(ws, "INSERT INTO uploads (id, meta_media_id, mime, size, r2_key, created_at) VALUES ('u-ci', 'm', 'image/jpeg', 3, ?, 1)", key);
  return key;
}

describe('item 4: a shared R2 object survives the erasure of ONE contact', () => {
  it('one campaign image across 3 contacts: erase one -> the key and uploads row stay and the other chats resolve; erasing the last one deletes it', async () => {
    const ws = W(1);
    const key = await campaignImage(ws);
    const api = await apiFor(ws);
    expect((await api.call('DELETE', `/contacts/${CONTACTS[0]}`)).status).toBe(200);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(await rows(ws, 'SELECT r2_key FROM uploads')).toEqual([{ r2_key: key }]);
    expect(await rows(ws, 'SELECT key FROM r2_pending_deletes')).toEqual([]);
    expect((await rows<{ media_r2_key: string }>(ws, 'SELECT media_r2_key FROM messages')).map((m) => m.media_r2_key)).toEqual([key, key]);
    expect((await api.call('DELETE', `/contacts/${CONTACTS[1]}`)).status).toBe(200);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect((await api.call('DELETE', `/contacts/${CONTACTS[2]}`)).status).toBe(200); // nobody references it now
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await rows(ws, 'SELECT 1 FROM uploads')).toEqual([]);
  });

  it('a restore keeps the uploads row that kept messages still reference (and drops it when no kept message does)', async () => {
    const ws = W(2);
    const key = await campaignImage(ws);
    await workspace(ws).exportSnapshot('2026-10-27');
    expect((await (await apiFor(ws)).call('DELETE', `/contacts/${CONTACTS[0]}`)).status).toBe(200);
    const t = `${ws}-restored`;
    expect((await workspace(t).importSnapshot(`backups/${ws}/2026-10-27/`)).ok).toBe(true);
    expect(await rows(t, 'SELECT wamid FROM messages ORDER BY id')).toHaveLength(2);
    expect(await rows(t, 'SELECT r2_key FROM uploads')).toEqual([{ r2_key: key }]);

    // when EVERY referencing contact is erased the upload row goes with them
    const w2 = W(3);
    await campaignImage(w2);
    await workspace(w2).exportSnapshot('2026-10-27');
    const api = await apiFor(w2);
    for (const wa of CONTACTS) await api.call('DELETE', `/contacts/${wa}`);
    const t2 = `${w2}-restored`;
    expect((await workspace(t2).importSnapshot(`backups/${w2}/2026-10-27/`)).ok).toBe(true);
    expect(await rows(t2, 'SELECT 1 FROM uploads')).toEqual([]);
  });
});

describe('item 5: the "still referenced" check is indexed', () => {
  it('EXPLAIN QUERY PLAN uses the two partial indexes and never scans messages', async () => {
    const ws = W(10);
    await own(ws);
    const plan = await runInDurableObject(workspace(ws), (_i, state) => {
      const p = (q: string, ...a: SqlStorageValue[]) => state.storage.sql.exec(`EXPLAIN QUERY PLAN ${q}`, ...a).toArray().map((r) => String(r.detail)).join(' | ');
      return { plain: p(referencedElsewhereSql(false), 'k'), except: p(referencedElsewhereSql(true), 'k', 1) };
    });
    for (const text of [plan.plain, plan.except]) {
      expect(text).toMatch(/messages_body_r2/);
      expect(text).toMatch(/messages_media_r2/);
      expect(text).not.toMatch(/SCAN messages/);
    }
  });
});

describe('item 8: merging two contacts that were in the same campaign', () => {
  it('does not 500; one campaign link/recipient survives per campaign', async () => {
    const ws = W(20);
    await own(ws);
    for (const wa of CONTACTS.slice(0, 2)) await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.mg.${wa}`, from: wa, ts: nowS(), type: 'text', text: 'x' }], statuses: [], receivedAt: Date.now() });
    const [a, b] = await rows<{ id: number }>(ws, 'SELECT id FROM contacts ORDER BY id');
    await exec(ws, "INSERT INTO campaigns (id, name, template_name, template_language, category, params, criteria, phone_number_id, status, created_at, updated_at) VALUES ('c1', 'n', 't', 'ar', 'MARKETING', '[]', '{}', 'pn-x', 'completed', 1, 1)");
    for (const [i, id] of [a!.id, b!.id].entries()) {
      await exec(ws, "INSERT INTO campaign_links (code, campaign_id, contact_id, clicks, created_at) VALUES (?, 'c1', ?, ?, 1)", `code-${i}`, id, i);
      await exec(ws, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, at) VALUES ('c1', ?, 0, ?, 'queued', 1)", id, `idem-${i}`);
    }
    const r = await (await apiFor(ws)).call('POST', '/contacts/merge', { fromWaId: CONTACTS[0], intoWaId: CONTACTS[1] });
    expect(r.status).toBe(200);
    expect(await rows(ws, 'SELECT contact_id FROM campaign_links')).toEqual([{ contact_id: b!.id }]);
    expect(await rows(ws, 'SELECT contact_id FROM campaign_recipients')).toEqual([{ contact_id: b!.id }]);
    expect(await rows(ws, 'SELECT id FROM contacts')).toEqual([{ id: b!.id }]);
  });
});

describe('item 10: a backup in flight cannot write after the deletion listed the backups', () => {
  it('the wipe waits for the snapshot; nothing is left under backups/<ws>/ when the run is done', async () => {
    const ws = W(30);
    await own(ws);
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.bk.${ws}`, from: CONTACTS[0]!, ts: nowS(), type: 'text', text: 'x' }], statuses: [], receivedAt: Date.now() });
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: 'legal request by e-mail', immediate: true })).status).toBe(202);
    const realPut = env.BACKUPS.put.bind(env.BACKUPS);
    vi.spyOn(env.BACKUPS, 'put').mockImplementation(async (...a: Parameters<typeof realPut>) => { await new Promise((r) => setTimeout(r, 40)); return realPut(...a); });
    let snap: Promise<unknown> = Promise.resolve();
    const out = await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS, {
      beforeStep: async (step) => { if (step === 'wipe_do') snap = workspace(ws).exportSnapshot('2026-10-27').catch(() => undefined); },
    });
    expect(out).toBe('done');
    await snap;
    await new Promise((r) => setTimeout(r, 400));
    expect((await env.BACKUPS.list({ prefix: `backups/${ws}/` })).objects).toEqual([]);
  });
});
