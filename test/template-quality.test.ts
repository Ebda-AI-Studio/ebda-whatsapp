import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { extractTemplateQualityUpdates } from '../src/core/meta/webhook-schema';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { exec, rows, seedNumber } from './helpers/workspace';

useApiKey();

const payload = (waba: string, name: string, language: string, score: string) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: waba, time: 1_700_000_000, changes: [{ field: 'message_template_quality_update', value: { previous_quality_score: 'GREEN', new_quality_score: score, message_template_id: 1, message_template_name: name, message_template_language: language } }] }],
});

it('extractTemplateQualityUpdates: green / yellow / red pass through, anything else is UNKNOWN, a malformed change is skipped', () => {
  const e = (s: string) => extractTemplateQualityUpdates(JSON.parse(payload('w1', 't', 'ar', s)));
  expect(e('green')).toEqual([{ wabaId: 'w1', name: 't', language: 'ar', score: 'GREEN' }]);
  expect(e('YELLOW')[0]!.score).toBe('YELLOW');
  expect(e('RED')[0]!.score).toBe('RED');
  expect(e('SURPRISE')[0]!.score).toBe('UNKNOWN');
  expect(extractTemplateQualityUpdates({ object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: [{ field: 'message_template_quality_update', value: { message_template_name: 't' } }] }] })).toEqual([]);
});

it('the webhook stores the rating on the right workspace\'s template only; the templates route returns it; the status is untouched; a replay and an unknown template are harmless', async () => {
  await seedNumber('pn-tq', W(9701), 'active', 'waba-tq');
  await seedNumber('pn-tq2', W(9702), 'active', 'waba-tq2');
  for (const ws of [W(9701), W(9702)]) await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', '[{\"type\":\"BODY\",\"text\":\"hi\"}]', 1)");
  expect((await postWebhook(SELF, payload('waba-tq', 'promo', 'ar', 'RED'))).status).toBe(200);
  expect((await postWebhook(SELF, payload('waba-tq', 'promo', 'ar', 'RED'))).status).toBe(200);
  expect((await postWebhook(SELF, payload('waba-tq', 'nothing', 'ar', 'GREEN'))).status).toBe(200);
  expect(await rows(W(9701), 'SELECT status, quality, updated_at FROM templates')).toEqual([{ status: 'APPROVED', quality: 'RED', updated_at: 1 }]);
  expect(await rows(W(9702), 'SELECT quality FROM templates')).toEqual([{ quality: null }]);
  const list = (await (await (await apiFor(W(9701), 'staff', 'pn-tq')).call('GET', '/templates')).json()) as { items: Array<{ name: string; quality: string | null }> };
  expect(list.items.find((t) => t.name === 'promo')?.quality).toBe('RED');
  const other = (await (await (await apiFor(W(9702), 'owner', 'pn-tq2')).call('GET', '/templates')).json()) as { items: Array<{ quality: string | null }> };
  expect(other.items[0]!.quality).toBeNull();
});

it('an unsigned quality webhook changes nothing', async () => {
  await seedNumber('pn-tq3', W(9703), 'active', 'waba-tq3');
  await exec(W(9703), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', '[]', 1)");
  expect((await postWebhook(SELF, payload('waba-tq3', 'promo', 'ar', 'RED'), 'sha256=bad')).status).toBe(401);
  expect(await rows(W(9703), 'SELECT quality FROM templates')).toEqual([{ quality: null }]);
});
