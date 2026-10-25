import type { ErrorEvent } from '@sentry/cloudflare';
import { describe, expect, it } from 'vitest';
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

it('drops the query string and masks phone numbers in the URL path', () => {
  const e = base();
  e.request!.url = 'https://x/api/v1/stores/s1/contacts/201001234567?hub.verify_token=secret&hub.challenge=1';
  expect(scrubEvent(e).request?.url).toBe('https://x/api/v1/stores/s1/contacts/[phone]');
});

it('keeps only allowlisted headers (drops IP-carrying headers)', () => {
  const e = base();
  e.request!.headers = { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'content-type': 'application/json', 'cf-ray': 'abc', 'user-agent': 'ua' };
  expect(scrubEvent(e).request?.headers).toEqual({ 'content-type': 'application/json', 'cf-ray': 'abc', 'user-agent': 'ua' });
});

it('masks phone numbers written with separators or Arabic-Indic digits', () => {
  const e = base();
  e.message = 'failed for 20 100 123 4567 and ٠١٠٠١٢٣٤٥٦٧';
  expect(scrubEvent(e).message).toBe('failed for [phone] and [phone]');
});

it('masks the contact segment of the URL by position', () => {
  const e = base();
  e.request!.url = 'https://x/api/v1/stores/s1/contacts/%2B20%20100%20123%204567';
  expect(scrubEvent(e).request?.url).toBe('https://x/api/v1/stores/s1/contacts/[phone]');
});

it('scrubs breadcrumbs and drops extra, contexts and tags', () => {
  const e = base();
  e.breadcrumbs = [{ message: 'sent to +201001234567', data: { body: 'secret' } }];
  e.extra = { phone: '+201001234567' };
  e.tags = { to: '201001234567' };
  const out = scrubEvent(e);
  expect(out.breadcrumbs).toEqual([{ message: 'sent to [phone]' }]);
  expect(out.extra).toBeUndefined();
  expect(out.tags).toBeUndefined();
});

it('masks phone numbers interleaved with bidi or zero-width format characters', () => {
  const e = base();
  e.message = 'to +20‎100‏123⁦456⁩7 and 01​00‍1234567';
  expect(scrubEvent(e).message).toBe('to [phone] and [phone]');
});

describe('errClass / safeMessage', () => {
  it('reports a class (and a short code), never the text', async () => {
    const { errClass } = await import('../src/core/observability');
    expect(errClass(new TypeError('call +20 100 123 4567'))).toBe('TypeError');
    expect(errClass(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('Error:ECONNRESET');
    expect(errClass(Object.assign(new Error('x'), { code: 'has spaces and a+201001234567' }))).toBe('Error');
    expect(errClass('thrown string +201001234567')).toBe('string');
    expect(errClass(null)).toBe('null');
    expect(errClass({ message: 'a@b.com' })).toBe('object');
  });

  it('masks phones (separators, Arabic digits, format characters) and e-mails in stored text', async () => {
    const { safeMessage } = await import('../src/core/observability');
    const text = safeMessage(new Error('to +20 100 123 4567 or ٠١٠٠١٢٣٤٥٦٧ or 0100‎1234567, mail ahmad@example.co.uk'));
    expect(text).toBe('to [phone] or [phone] or [phone], mail [email]');
    expect(safeMessage('plain +201001234567')).toBe('plain [phone]');
    expect(safeMessage(undefined).length).toBeLessThanOrEqual(200);
  });
});
