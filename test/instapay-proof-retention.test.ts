import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROOF_RETENTION_MS, purgeInstapayProofs, readProof, signProofLink } from '../src/core/billing/instapay';
import { dailyBilling } from '../src/index';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { testKashier } from './helpers/kashier';
import { storeId as W0 } from './helpers/api';
import { seedNumber } from './helpers/workspace';

const W = (n: number) => W0(9950 + n);
const DAY = 86_400_000;
beforeEach(() => { configureSessionCheck(async () => false); configurePayments(() => testKashier()); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

async function proofRow(ws: string, id: string, state: string, decidedAt: number | null, withObject = true) {
  await seedNumber(`pn-pr-${ws.slice(-6)}`, ws);
  const key = `instapay-proof/${ws}/${id}.k.png`;
  if (withObject) await env.MEDIA.put(key, 'proof bytes');
  await env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, state, created_by, created_at, expires_at, proof_key, proof_mime, proof_bytes, proof_at, proof_sha256, decided_at) VALUES (?, ?, ?, 'topup', 20000, ?, 'm', 1, 2, ?, 'image/png', 11, 1, ?, ?)")
    .bind(id, `WA-${id.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(8, 'X').slice(0, 8)}`, ws, state, key, `${id}`.padEnd(64, '0'), decidedAt).run();
  return key;
}
const proofKey = (id: string) => env.DB.prepare('SELECT proof_key, proof_sha256 FROM instapay_requests WHERE id = ?').bind(id).first<{ proof_key: string | null; proof_sha256: string | null }>();

describe('InstaPay proof lifecycle (M-096)', () => {
  it('deletes the proof 180 days after the decision, keeps the hash, leaves younger and undecided proofs alone', async () => {
    const now = Date.now();
    const oldConfirmed = await proofRow(W(1), 'pr-old-c', 'confirmed', now - PROOF_RETENTION_MS - DAY);
    const oldRejected = await proofRow(W(2), 'pr-old-r', 'rejected', now - PROOF_RETENTION_MS - DAY);
    const young = await proofRow(W(3), 'pr-young', 'confirmed', now - 30 * DAY);
    const waiting = await proofRow(W(4), 'pr-wait', 'under_review', null); // never by the clock: it waits for a person
    const r = await purgeInstapayProofs(env, now);
    expect(r.deleted).toBe(2);
    for (const k of [oldConfirmed, oldRejected]) expect(await env.MEDIA.get(k)).toBeNull();
    for (const k of [young, waiting]) expect(await env.MEDIA.get(k)).not.toBeNull();
    expect(await proofKey('pr-old-c')).toEqual({ proof_key: null, proof_sha256: 'pr-old-c'.padEnd(64, '0') }); // the hash stays: duplicate detection must outlive the image
    expect((await proofKey('pr-young'))!.proof_key).toBe(young);
    expect(PROOF_RETENTION_MS).toBe(180 * DAY);
  });

  it('a purged proof can no longer be read through a signed link', async () => {
    const now = Date.now();
    await proofRow(W(5), 'pr-link', 'confirmed', now - PROOF_RETENTION_MS - DAY);
    const link = await signProofLink(env, 'pr-link', now);
    await purgeInstapayProofs(env, now);
    expect(await readProof(env, link!.url.split('/').pop()!, now)).toBeNull();
  });

  it('drains a backlog in pages and, when R2 refuses a delete, keeps the reference (retried tomorrow) and alerts', async () => {
    const now = Date.now();
    for (let i = 0; i < 7; i++) await proofRow(W(6), `pr-bk-${i}`, 'confirmed', now - PROOF_RETENTION_MS - DAY - i);
    const spy = vi.spyOn(console, 'error');
    const del = vi.spyOn(env.MEDIA, 'delete').mockRejectedValueOnce(new Error('r2 down'));
    const first = await purgeInstapayProofs(env, now, { page: 3 });
    expect(first.deleted).toBe(6);
    expect(first.failed).toBe(1);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('instapay_proof_purge_failed'))).toBe(true);
    del.mockRestore();
    expect((await purgeInstapayProofs(env, now, { page: 3 })).deleted).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM instapay_requests WHERE id LIKE 'pr-bk-%' AND proof_key IS NOT NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it('the daily pass runs it', async () => {
    const now = Date.now();
    const k = await proofRow(W(7), 'pr-daily', 'rejected', now - PROOF_RETENTION_MS - DAY);
    await dailyBilling(env);
    expect(await env.MEDIA.get(k)).toBeNull();
  });
});
