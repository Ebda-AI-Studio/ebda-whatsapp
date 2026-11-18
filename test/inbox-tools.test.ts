import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { quickReplyDto } from '../src/core/api/contract';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { openChat, rows } from './helpers/workspace';

useApiKey();

describe('quick replies (A25): a merchant-editable list per workspace', () => {
  it('owner and staff create, list, edit and delete; the shape is the contract', async () => {
    const ws = W(901);
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    const created = await staff.call('POST', '/quick-replies', { text: '  شكرًا ليك!  ' });
    expect(created.status).toBe(201);
    const qr = quickReplyDto.parse(await created.json());
    expect(qr.text).toBe('شكرًا ليك!');
    const list = (await (await owner.call('GET', '/quick-replies')).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    const upd = await owner.call('PUT', `/quick-replies/${qr.id}`, { text: 'أهلًا' });
    expect(upd.status).toBe(200);
    expect(quickReplyDto.parse(await upd.json()).text).toBe('أهلًا');
    expect((await staff.call('DELETE', `/quick-replies/${qr.id}`)).status).toBe(204);
    expect(await rows(ws, 'SELECT 1 FROM quick_replies')).toEqual([]);
    expect((await owner.call('DELETE', `/quick-replies/${qr.id}`)).status).toBe(404);
    expect((await owner.call('PUT', '/quick-replies/99999', { text: 'x' })).status).toBe(404);
  });

  it('Zod at the edge: empty, oversize, unknown keys and a non-numeric id are 400', async () => {
    const api = await apiFor(W(902));
    for (const bad of [{}, { text: '   ' }, { text: 'x'.repeat(501) }, { text: 'ok', extra: 1 }, { text: 5 }]) {
      expect((await api.call('POST', '/quick-replies', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api.call('PUT', '/quick-replies/abc', { text: 'x' })).status).toBe(400);
    expect((await api.call('PUT', '/quick-replies/1', {})).status).toBe(400);
  });

  it('at most 20 replies per workspace (409), and a duplicate text is refused (409)', async () => {
    const ws = W(903);
    const api = await apiFor(ws);
    for (let i = 0; i < 20; i++) expect((await api.call('POST', '/quick-replies', { text: `reply ${i}` })).status).toBe(201);
    expect((await api.call('POST', '/quick-replies', { text: 'one too many' })).status).toBe(409);
  });

  it('the same text twice is refused (409), also when an edit would collide', async () => {
    const api = await apiFor(W(907));
    const a = quickReplyDto.parse(await (await api.call('POST', '/quick-replies', { text: 'hello' })).json());
    expect((await api.call('POST', '/quick-replies', { text: 'hello' })).status).toBe(409);
    const b = quickReplyDto.parse(await (await api.call('POST', '/quick-replies', { text: 'bye' })).json());
    expect((await api.call('PUT', `/quick-replies/${b.id}`, { text: 'hello' })).status).toBe(409);
    expect((await api.call('PUT', `/quick-replies/${a.id}`, { text: 'hello' })).status).toBe(200); // its own text is not a collision
  });

  it('workspaces are separate: B never sees or changes A\'s replies; a token for B on A\'s path is refused', async () => {
    const a = await apiFor(W(904));
    const b = await apiFor(W(905));
    const made = quickReplyDto.parse(await (await a.call('POST', '/quick-replies', { text: 'only A' })).json());
    expect(((await (await b.call('GET', '/quick-replies')).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await b.call('PUT', `/quick-replies/${made.id}`, { text: 'hijack' })).status).toBe(404);
    expect((await b.call('DELETE', `/quick-replies/${made.id}`)).status).toBe(404);
    const res = await SELF.fetch(`https://x/api/v1/stores/${W(904)}/quick-replies`, { headers: { authorization: `Bearer ${b.token}` } });
    expect([403, 404]).toContain(res.status);
    expect(await rows(W(904), 'SELECT text FROM quick_replies')).toEqual([{ text: 'only A' }]);
  });

  it('every change is in the audit log with the actor, never the text', async () => {
    const ws = W(906);
    const api = await apiFor(ws);
    await api.call('POST', '/quick-replies', { text: 'secret wording' });
    const log = await env.DB.prepare('SELECT action, detail FROM audit_log WHERE workspace_id = ?').bind(ws).all<{ action: string; detail: string | null }>();
    expect(log.results.map((r) => r.action)).toContain('POST /stores/:storeId/quick-replies');
    expect(JSON.stringify(log.results)).not.toContain('secret wording');
  });
});

describe('notes, conversation tags, contact tags, segments: another workspace\'s ids are 404', () => {
  it('conversation notes and tags', async () => {
    const a = W(911);
    const b = await apiFor(W(912));
    const other = await apiFor(a);
    const convA = await openChat(a, '201000000011');
    expect((await other.call('POST', `/conversations/${convA}/notes`, { text: 'hello team' })).status).toBe(201);
    expect((await b.call('GET', `/conversations/${convA}/notes`)).status).toBe(404);
    expect((await b.call('POST', `/conversations/${convA}/notes`, { text: 'x' })).status).toBe(404);
    expect((await b.call('PUT', `/conversations/${convA}/tags`, { tags: ['vip'] })).status).toBe(404);
    expect(await rows(a, 'SELECT text FROM notes')).toEqual([{ text: 'hello team' }]);
    expect(await rows(a, 'SELECT tag FROM conversation_tags')).toEqual([]);
  });

  it('conversation tags are trimmed, de-duplicated case-insensitively and lower-cased like contact tags; bad input is 400', async () => {
    const ws = W(913);
    const api = await apiFor(ws);
    const conv = await openChat(ws, '201000000013');
    const ok = await api.call('PUT', `/conversations/${conv}/tags`, { tags: [' VIP ', 'vip', 'Eid'] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { tags: string[] }).tags.sort()).toEqual(['eid', 'vip']);
    for (const bad of [{ tags: ['   '] }, { tags: ['x'.repeat(33)] }, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, { tags: ['a'], extra: 1 }]) {
      expect((await api.call('PUT', `/conversations/${conv}/tags`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('contact tags and segments', async () => {
    const a = W(914);
    const b = await apiFor(W(915));
    const owner = await apiFor(a);
    await openChat(a, '201000000014');
    expect((await b.call('PUT', '/contacts/201000000014/tags', { tags: ['vip'] })).status).toBe(404);
    const seg = (await (await owner.call('POST', '/segments', { name: 'VIP', criteria: { tags: { any: ['vip'] } } })).json()) as { id: number };
    expect((await b.call('GET', `/segments/${seg.id}`)).status).toBe(404);
    expect((await b.call('PUT', `/segments/${seg.id}`, { name: 'x' })).status).toBe(404);
    expect((await b.call('DELETE', `/segments/${seg.id}`)).status).toBe(404);
    expect(await rows(a, 'SELECT name FROM segments')).toEqual([{ name: 'VIP' }]);
  });
});
