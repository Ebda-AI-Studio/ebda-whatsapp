import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { SendJob } from '../src/core/send-queue';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { consume } from './helpers/queue';
import { exec, openChat, rows, workspace } from './helpers/workspace';

useApiKey();
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const queuedJob = (): SendJob => {
  const calls = vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls;
  return ((calls[calls.length - 1]![0] as { body: SendJob }[])[0]!).body;
};

it('Final #2: a deferred marketing template is dropped as opted_out when the contact opted out meanwhile; utility still goes', async () => {
  const ws = W(500);
  const api = await apiFor(ws);
  const conv = await openChat(ws);
  await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', ?, 1), ('util', 'ar', 'UTILITY', 'APPROVED', ?, 1)", '[{"type":"BODY","text":"عرض"}]', '[{"type":"BODY","text":"طلبك"}]');
  await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: cid(1), name: 'promo', language: 'ar', params: [] });
  const promo = queuedJob();
  await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: cid(2), name: 'util', language: 'ar', params: [] });
  const util = queuedJob();
  // Meta's frequency cap defers the marketing job, then the contact opts out while it waits
  graphStub(() => ({ status: 400, json: { error: { code: 131049, message: 'frequency cap' } } }));
  await consume([promo]);
  await exec(ws, 'UPDATE contacts SET opted_out_at = ?', Date.now());
  const g = graphStub();
  const res = await consume([JSON.parse(JSON.stringify(promo)) as SendJob]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(g.calls).toHaveLength(0);
  expect(await rows(ws, "SELECT status, error_reason FROM messages WHERE idempotency_key = ?", promo.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'opted_out' }]);
  await consume([util]);
  expect(g.calls).toHaveLength(1);
});

it('Final #3: an AUTHENTICATION template (copy-code button shaped as type URL) is masked everywhere; the code only reaches the job', async () => {
  const ws = W(501);
  const api = await apiFor(ws);
  const conv = await openChat(ws);
  const stored = [
    { type: 'BODY', text: '{{1}} is your verification code.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Copy code', url: 'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}' }] },
  ];
  await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('otp', 'en', 'AUTHENTICATION', 'APPROVED', ?, 1)", JSON.stringify(stored));
  const res = await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: cid(3), name: 'otp', language: 'en', params: ['482913'] });
  expect(res.status).toBe(202);
  const body = JSON.stringify(await res.json());
  expect(body).not.toContain('482913');
  expect(body).toContain('••••••');
  const job = queuedJob();
  expect(JSON.stringify(job.template!.components)).toContain('482913'); // the one place it must go: the Graph call
  for (const q of ['SELECT preview, body FROM messages', 'SELECT payload FROM events', "SELECT text FROM messages_fts WHERE messages_fts MATCH '482913'"]) {
    expect(JSON.stringify(await rows(ws, q))).not.toContain('482913');
  }
  const list = await (await api.call('GET', '/templates')).json() as { items: { name: string; paramCount: number }[] };
  expect(list.items.find((t) => t.name === 'otp')!.paramCount).toBe(1);
});
