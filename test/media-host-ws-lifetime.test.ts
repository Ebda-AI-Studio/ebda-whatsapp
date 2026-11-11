import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { downloadToR2, isMetaMediaUrl } from '../src/core/media';
import { WS_CLOSE_NO_SEAT, WS_CLOSE_TOKEN_EXPIRED, WS_MAX_LIFETIME_S, WS_SWEEP_MS } from '../src/core/workspace-do';
import { env } from 'cloudflare:test';
import { apiFor, apiKey, storeId as W, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { mint } from './helpers/issuer';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const OWNER = 'a0000000-0000-4000-8000-0000000000c1';

describe('WA-5: the Meta bearer token goes only to https Meta media hosts', () => {
  it('allows Meta hosts and refuses everything else', () => {
    expect(isMetaMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBe(true);
    expect(isMetaMediaUrl('https://scontent.xx.fbcdn.net/v/x')).toBe(true);
    for (const bad of ['http://lookaside.fbsbx.com/x', 'https://evil.example/x', 'https://fbsbx.com.evil.example/x', 'https://evilfbsbx.com/x', 'https://lookaside.fbsbx.com:8443/x', 'https://u:p@lookaside.fbsbx.com/x', 'https://169.254.169.254/x', 'not a url', '']) expect(isMetaMediaUrl(bad), bad).toBe(false);
  });
  it('a lookup that answers a foreign url never makes a second call and never sends the token there', async () => {
    const g = stubGraph((c) => (c.url.includes('/media-evil') ? { status: 200, json: { url: 'https://evil.example/steal', mime_type: 'image/jpeg', file_size: 1 } } : { status: 200, json: {} }));
    try {
      await expect(downloadToR2({ META_GRAPH_VERSION: 'v25.0', MEDIA: env.MEDIA }, 'SECRET-TOKEN', 'media-evil', 'k', 'image/jpeg')).rejects.toThrow(/refused/);
      expect(g.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    } finally { g.restore(); }
  });
});

describe('WA-6: an open socket is re-authorised on a timer and capped', () => {
  afterEach(() => configureSessionCheck(null));
  async function open(n: number, sub = OWNER) {
    const ws = W(5000 + n);
    await apiFor(ws);
    link.fake.setMembers(ws, [{ userId: sub, role: 'owner' }]);
    const token = await mint(apiKey(), { sub, stores: [{ id: ws, role: 'owner' }] });
    const res = await SELF.fetch(`https://x/api/v1/stores/${ws}/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `inbox.v1, bearer.${token}` } });
    expect(res.status).toBe(101);
    const sock = res.webSocket!;
    sock.accept();
    const closed = new Promise<number>((r) => sock.addEventListener('close', (e) => r(e.code)));
    return { ws, closed };
  }
  const sweep = (ws: string, plusMs = WS_SWEEP_MS + 1000) => workspace(ws).runDueTasks(Date.now() + plusMs);

  it('closes the socket of a member removed from the Store, at the next sweep', async () => {
    const { ws, closed } = await open(1);
    link.fake.setMembers(ws, []);
    await sweep(ws);
    expect(await closed).toBe(WS_CLOSE_NO_SEAT);
  });
  it('closes the socket of a revoked session', async () => {
    const { ws, closed } = await open(2);
    configureSessionCheck(async () => true);
    await sweep(ws);
    expect(await closed).toBe(WS_CLOSE_NO_SEAT);
  });
  it('closes every socket past the lifetime cap, whatever the token says', async () => {
    const { ws, closed } = await open(3);
    await sweep(ws, (WS_MAX_LIFETIME_S + 5) * 1000);
    expect(await closed).toBe(WS_CLOSE_TOKEN_EXPIRED);
  });
  it('refuses the upgrade of a revoked session', async () => {
    const ws = W(5100);
    await apiFor(ws);
    link.fake.setMembers(ws, [{ userId: OWNER, role: 'owner' }]);
    configureSessionCheck(async () => true);
    const token = await mint(apiKey(), { sub: OWNER, stores: [{ id: ws, role: 'owner' }] });
    const res = await SELF.fetch(`https://x/api/v1/stores/${ws}/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `inbox.v1, bearer.${token}` } });
    expect(res.status).toBe(403);
  });
});
