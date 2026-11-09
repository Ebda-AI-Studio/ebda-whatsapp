import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { runChecks } from '../scripts/verify-prod.mjs';

// Ruling WA-CARD-OFF-VERIFY-1: with card payments off (no Kashier keys) the Worker answers the webhook 503 "unavailable";
// verify-prod accepts exactly that, and nothing else in the 5xx range.
const fake = (status: number, body: string, type = 'text/plain') => async (url: string) => {
  const u = new URL(url);
  if (u.pathname === '/kashier/webhook') return new Response(body, { status, headers: { 'content-type': type } });
  if (u.pathname === '/health') return new Response(JSON.stringify({ ok: true, service: 'ebda-wa', commit: 'abc' }));
  return new Response('nf', { status: 404 });
};
const kashier = async (status: number, body: string, type?: string) =>
  (await runChecks({ base: 'https://wa.test', fetchImpl: fake(status, body, type) })).find((c: { name: string }) => c.name === 'kashier webhook is served by the Worker');

it('card off: the Worker\'s 503 "unavailable" passes', async () => {
  expect((await kashier(503, 'unavailable'))?.ok).toBe(true);
});
it('card on: an unsigned POST gets 401 and passes', async () => {
  expect((await kashier(401, 'unauthorized'))?.ok).toBe(true);
});
it('any other 503 or 5xx still fails', async () => {
  expect((await kashier(503, 'unconfirmed'))?.ok).toBe(false);
  expect((await kashier(500, 'unavailable'))?.ok).toBe(false);
});
it('the SPA answering (HTML) still fails, even with status 503', async () => {
  expect((await kashier(503, 'unavailable', 'text/html'))?.ok).toBe(false);
  expect((await kashier(200, '<!doctype html>', 'text/html'))?.ok).toBe(false);
});
