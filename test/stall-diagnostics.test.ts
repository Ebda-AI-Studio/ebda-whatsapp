import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { clearOps, labelForUrl, pendingOps, track, watchStall } from './helpers/inflight';
import { workspace } from './helpers/workspace';

// WA-CI-STALL-1: when a test is about to hit its deadline, say WHICH awaited operation is still pending (never a body or a phone), so a CI stall is a diagnosis, not a timeout bump.
const never = () => new Promise<never>(() => undefined);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('a test that is about to time out prints ONE structured line naming the pending operations and their age', async () => {
  clearOps();
  const lines: string[] = [];
  const stop = watchStall({ name: 'a deliberately hanging test', timeoutMs: 400, marginMs: 150, emit: (l) => lines.push(l) });
  void track('fetch api.example.test/v1/hang', never());
  void track('do.runDueTasks', never());
  await wait(500);
  stop();
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.stall).toBe('a deliberately hanging test');
  expect(parsed.pending.map((p: { label: string }) => p.label).sort()).toEqual(['do.runDueTasks', 'fetch api.example.test/v1/hang']);
  expect(parsed.pending[0].ageMs).toBeGreaterThanOrEqual(200);
  clearOps();
});

it('a normal test prints nothing: finishing before the deadline cancels the watch, and settled operations are not listed', async () => {
  clearOps();
  const lines: string[] = [];
  const stop = watchStall({ name: 'a normal test', timeoutMs: 400, marginMs: 150, emit: (l) => lines.push(l) });
  await track('fetch api.example.test/v1/fast', Promise.resolve(1));
  expect(pendingOps()).toEqual([]);
  stop();
  await wait(500);
  expect(lines).toEqual([]);
});

it('a watch whose operations all settled before the deadline still says nothing is pending (the stall is then in the test itself)', async () => {
  clearOps();
  const lines: string[] = [];
  const stop = watchStall({ name: 'a test waiting on nothing', timeoutMs: 300, marginMs: 100, emit: (l) => lines.push(l) });
  await wait(350);
  stop();
  expect(JSON.parse(lines[0]!)).toEqual({ stall: 'a test waiting on nothing', pending: [] });
});

it('labels carry the host and path only: no query, no body, and no run of 8+ digits (a phone number, a wamid)', () => {
  expect(labelForUrl('https://graph.facebook.com/v25.0/1234567890123/messages?access_token=SECRETVALUE')).toBe('fetch graph.facebook.com/v25.0/[n]/messages');
  expect(labelForUrl('https://api.telegram.org/bot123456:AAF-token/sendMessage')).not.toContain('AAF-token');
  expect(labelForUrl('not a url')).toBe('fetch (unparsable url)');
});

it('a test can name its own operation (a Durable Object call cannot be wrapped: the native stub brand check rejects a Proxy)', async () => {
  clearOps();
  const call = track('do.runDueTasks', workspace('ws-stall-1').runDueTasks());
  expect(pendingOps().map((p) => p.label)).toContain('do.runDueTasks');
  await call;
  expect(pendingOps()).toEqual([]);
});

it('a stubGraph call is tracked while it is held open, and untracked once answered', async () => {
  clearOps();
  const { stubGraph } = await import('./helpers/graph');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const g = stubGraph(undefined, { before: () => gate });
  const p = fetch('https://graph.facebook.com/v25.0/123456789012/messages', { method: 'POST', body: '{}' });
  await wait(5);
  expect(pendingOps().map((o) => o.label)).toEqual(['fetch graph.facebook.com/v25.0/[n]/messages']);
  release();
  await p;
  expect(pendingOps()).toEqual([]);
  g.restore();
  void env;
});
