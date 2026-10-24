import { SELF, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { PROOF_URL_TTL_MS, signProofUrl } from '../src/core/ordering/proof-url';
import { configureStoreLink } from '../src/core/store-link';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, openChat, rows } from './helpers/workspace';

useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000046${String(n).padStart(2, '0')}`;

async function withScreenshot(ws: string, mime = 'image/jpeg') {
  await storeWorkspace(ws);
  await openChat(ws, WA_1);
  const key = `media/${ws}/shot`;
  await env.MEDIA.put(key, new Uint8Array([9, 8, 7]), { httpMetadata: { contentType: mime } });
  await exec(ws, "INSERT INTO messages (wamid, conversation_id, direction, type, media_mime, media_r2_key, media_size, created_at, updated_at) VALUES ('wamid.shot', 1, 'in', 'image', ?, ?, 3, 1, 1)", mime, key);
  const [m] = await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE wamid = 'wamid.shot'");
  return m!.id;
}
const signed = (ws: string, id: number, now = Date.now()) => signProofUrl({ baseUrl: 'https://wa.test', secret: 'proof-test-secret', workspaceId: ws, messageId: id, now });
const get = (url: string) => SELF.fetch(url.replace('https://wa.test', 'https://x'));

it('serves exactly the signed screenshot, privately', async () => {
  const ws = W(1);
  const id = await withScreenshot(ws);
  const res = await get(await signed(ws, id));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 8, 7]);
});

it('refuses a wrong signature, another message, another workspace, an expired link and a tampered expiry', async () => {
  const ws = W(2);
  const id = await withScreenshot(ws);
  const url = await signed(ws, id);
  expect((await get(url.replace(/sig=[0-9a-f]/, 'sig=0'))).status).toBe(404);
  expect((await get(url.replace(`/${id}?`, `/${id + 1}?`))).status).toBe(404);
  expect((await get(url.replace(ws, W(3)))).status).toBe(404);
  expect((await get(await signed(ws, id, Date.now() - PROOF_URL_TTL_MS - 120_000))).status).toBe(404);
  expect((await get(url.replace(/exp=\d+/, `exp=${Date.now() + PROOF_URL_TTL_MS * 5}`))).status).toBe(404);
});

it('serves images only, and nothing while no signing key is configured', async () => {
  const ws = W(4);
  const id = await withScreenshot(ws, 'application/pdf');
  expect((await get(await signed(ws, id))).status).toBe(404);
  const ws2 = W(5);
  const id2 = await withScreenshot(ws2);
  const url = await signed(ws2, id2);
  const prev = configureStoreLink({ proof: () => null });
  try {
    expect((await get(url)).status).toBe(404);
  } finally {
    configureStoreLink(prev);
  }
});
