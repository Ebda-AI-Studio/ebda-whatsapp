import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { brandPack } from '../src/brand';

it('GET /health returns ok and the commit', async () => {
  const res = await SELF.fetch('https://x/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, service: 'ebda-wa', commit: 'dev' });
});

it('/health names the service from the brand pack (the deployment\'s BRAND), and no pack leaves it empty', async () => {
  const { env, createExecutionContext } = await import('cloudflare:test');
  const worker = (await import('../src/index')).default as unknown as ExportedHandler<typeof env>;
  const body = (await (await worker.fetch!(new Request('https://x/health'), env, createExecutionContext())).json()) as { service: string };
  expect(body.service).toBe(brandPack((env as { BRAND?: string }).BRAND).service);
  expect(brandPack('ebda').service).toBe('ebda-wa');
  expect(brandPack('demo').service).toMatch(/^[a-z][a-z0-9-]+$/);
  expect(brandPack('demo').service).not.toMatch(/ebda/i); // a white-label tenant never answers as the suite brand
});

it('/health commit is never an empty string (an empty COMMIT_SHA must not look like a deployed commit)', async () => {
  const { env, createExecutionContext } = await import('cloudflare:test');
  const worker = (await import('../src/index')).default as unknown as ExportedHandler<typeof env>;
  const res = await worker.fetch!(new Request('https://x/health'), { ...env, COMMIT_SHA: '' }, createExecutionContext());
  expect(((await res.json()) as { commit: string }).commit).toBe('dev');
});
