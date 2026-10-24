import type { ErrorEvent } from '@sentry/cloudflare';
import { expect, it } from 'vitest';
import { scrubEvent } from '../src/core/observability';

const base = (): ErrorEvent => ({
  type: undefined,
  message: 'send failed for +201001234567',
  request: { url: 'https://x/meta/webhook', data: '{"text":"secret"}', cookies: { a: 'b' }, headers: { authorization: 'Bearer t', 'x-hub-signature-256': 'sha256=x', 'user-agent': 'ua' } },
  user: { id: 'u', ip_address: '1.2.3.4' },
  exception: { values: [{ type: 'Error', value: 'to 201001234567 failed', stacktrace: { frames: [{ filename: 'index.ts', lineno: 3 }] } }] },
});

it('drops request bodies, cookies, auth headers and the user', () => {
  const e = scrubEvent(base());
  expect(e.request?.data).toBeUndefined();
  expect(e.request?.cookies).toBeUndefined();
  expect(e.request?.headers).toEqual({ 'user-agent': 'ua' });
  expect(e.user).toBeUndefined();
});

it('masks phone numbers in messages and exception values', () => {
  const e = scrubEvent(base());
  expect(e.message).toBe('send failed for [phone]');
  expect(e.exception?.values?.[0]?.value).toBe('to [phone] failed');
});

it('keeps the stack frames', () => {
  expect(scrubEvent(base()).exception?.values?.[0]?.stacktrace?.frames).toEqual([{ filename: 'index.ts', lineno: 3 }]);
});
