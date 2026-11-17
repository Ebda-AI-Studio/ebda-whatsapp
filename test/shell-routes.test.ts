import { createExecutionContext, env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const env = { ...testEnv, ASSETS: { fetch: async () => new Response('<html>shell</html>', { headers: { 'content-type': 'text/html' } }) } } as never;

describe('deep links to the Chat shell', () => {
  it.each(['/ops', '/templates', '/wallet', '/chat/42'])('%s returns the shell, not a 404', async (path) => {
    const res = await worker.fetch!(new Request(`https://wa.ebda.app${path}`), env, createExecutionContext());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('shell');
  });
  it('an unknown path still 404s and an API path is not shadowed', async () => {
        expect((await worker.fetch!(new Request('https://wa.ebda.app/nope'), env, createExecutionContext())).status).toBe(404);
    const api = await worker.fetch!(new Request('https://wa.ebda.app/api/operator/x'), env, createExecutionContext());
    expect(api.status).toBeGreaterThanOrEqual(401);
    expect(await api.text()).not.toContain('shell');
  });
});
