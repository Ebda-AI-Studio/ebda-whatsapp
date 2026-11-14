import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { View } from './components/Rail';
import { TemplatesScreen } from './components/TemplatesScreen';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { InboxSource, TemplatesApi } from './data/source';
import { STRINGS } from './i18n';
import { fakeApi, tpl } from './templates-fixtures';

afterEach(cleanup);
const now = () => Date.UTC(2026, 10, 14, 12, 0);
const source = (role: InboxSource['role'] = 'owner') => ({ ...createSampleSource(), role });
const t = STRINGS.ar;
const show = async (api: TemplatesApi, role: InboxSource['role'] = 'owner', onNavigate?: (v: View) => void) => {
  render(<TemplatesScreen t={t} lang="ar" source={source(role)} api={api} {...(onNavigate ? { onNavigate } : {})} />);
  await act(async () => undefined);
};

describe('templates list', () => {
  it('lists templates with Arabic status words, the label first and the raw name second', async () => {
    const api = fakeApi({ list: vi.fn(async () => ({ items: [
      tpl({ name: 'a_one', label: 'تأكيد الطلب بتاعي' }), tpl({ name: 'b_two', status: 'PENDING' }), tpl({ name: 'c_three', status: 'PAUSED' }), tpl({ name: 'd_four', status: 'DISABLED' }), tpl({ name: 'e_five', status: 'PENDING_DELETION' }),
    ], starterInstalled: true })) });
    await show(api);
    expect(screen.getByRole('heading', { name: 'قوالب الرسائل' })).toBeTruthy();
    const row = screen.getByRole('row', { name: /تأكيد الطلب بتاعي/ });
    expect(within(row).getByText('شغّال')).toBeTruthy();
    expect(within(row).getByText('a_one').getAttribute('dir')).toBe('ltr');
    expect(within(row).getByText('رسائل خدمة')).toBeTruthy();
    for (const w of ['قيد مراجعة ميتا (لحد يوم)', 'موقوف مؤقتًا', 'متعطّل', 'بيتمسح']) expect(screen.getByText(w)).toBeTruthy();
    for (const h of ['القالب', 'اللغة', 'النوع', 'الحالة']) expect(screen.getByRole('columnheader', { name: h }).getAttribute('scope')).toBe('col');
  });

  it('a rejected row shows the advice sentence under it', async () => {
    const api = fakeApi({ list: vi.fn(async () => ({ items: [tpl({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', advice: { kind: 'format', ar: 'ميتا رفضت القالب بسبب شكل المتغيّرات.', en: 'x' } })], starterInstalled: true })) });
    await show(api);
    expect(screen.getByText('اتّرفض')).toBeTruthy();
    expect(screen.getByText('ميتا رفضت القالب بسبب شكل المتغيّرات.')).toBeTruthy();
  });

  it('staff see no "new template" button and a read-only note', async () => {
    await show(fakeApi(), 'staff');
    expect(screen.queryByRole('button', { name: 'قالب جديد' })).toBeNull();
    expect(screen.getByText(/بتشوف القوالب للقراءة بس/)).toBeTruthy();
    cleanup();
    await show(fakeApi(), 'owner');
    expect(screen.getByRole('button', { name: 'قالب جديد' })).toBeTruthy();
  });

  it('an empty list with no starter marker triggers installDefaults exactly once, tells the merchant in a sentence, then reloads', async () => {
    let installed = false;
    const api = fakeApi({
      list: vi.fn(async () => (installed ? { items: [tpl()], starterInstalled: true } : { items: [], starterInstalled: false })),
      installDefaults: vi.fn(async () => { installed = true; return { submitted: ['order_confirmation'], skipped: [], failed: [] }; }),
    });
    await show(api);
    await act(async () => undefined);
    expect(api.installDefaults).toHaveBeenCalledTimes(1);
    expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByRole('row', { name: /order_confirmation/ })).toBeTruthy();
    expect(api.installDefaults).toHaveBeenCalledTimes(1);
  });

  it('an empty list whose starters are already installed does not install again, and staff never trigger it', async () => {
    const empty = fakeApi({ list: vi.fn(async () => ({ items: [], starterInstalled: true })) });
    await show(empty);
    expect(empty.installDefaults).not.toHaveBeenCalled();
    cleanup();
    const staffApi = fakeApi({ list: vi.fn(async () => ({ items: [], starterInstalled: false })) });
    await show(staffApi, 'staff');
    expect(staffApi.installDefaults).not.toHaveBeenCalled();
  });

  it('a failed starter install says so and offers a retry', async () => {
    const api = fakeApi({ list: vi.fn(async () => ({ items: [], starterInstalled: false })), installDefaults: vi.fn(async () => ({ submitted: [], skipped: [], failed: ['otp_code'] })) });
    await show(api);
    expect(await screen.findByRole('button', { name: 'جهّز قوالب البداية' })).toBeTruthy();
    expect(screen.getByText(/معرفناش نجهّز قوالب البداية/)).toBeTruthy();
  });

  it('no active number shows the connect prompt with a link to Numbers, not an empty table', async () => {
    const go = vi.fn();
    const api = fakeApi({ list: vi.fn(async () => { throw new ApiError('not_found', 404, 'no_active_number'); }) });
    await show(api, 'owner', go);
    expect(screen.getByText('اربط رقم واتساب الأول')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'روح لصفحة الأرقام' }));
    expect(go).toHaveBeenCalledWith('numbers');
  });

  it('an unusable token and a plain failure each get their own message; a failure offers a retry', async () => {
    await show(fakeApi({ list: vi.fn(async () => { throw new ApiError('rate_limited', 503, 'token_unavailable'); }) }));
    expect(screen.getByText('الربط مع واتساب محتاج تجديد')).toBeTruthy();
    cleanup();
    const list = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ items: [tpl()], starterInstalled: true });
    await show(fakeApi({ list }));
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.retry })));
    expect(await screen.findByRole('row', { name: /order_confirmation/ })).toBeTruthy();
  });

  it('the sync button says how many were synced and reloads', async () => {
    const api = fakeApi();
    await show(api);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'مزامنة مع ميتا' })));
    expect(api.sync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('اتزامن 3 قالب');
    expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('a failed sync says so in words', async () => {
    await show(fakeApi({ sync: vi.fn(async () => { throw new Error('x'); }) }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'مزامنة مع ميتا' })));
    expect(screen.getByText(t.tplSyncFailed)).toBeTruthy();
  });
});

describe('navigation and copy', () => {
  it('the Rail shows Templates and navigation renders the screen', async () => {
    const src = { ...createSampleSource(), templatesApi: fakeApi() };
    render(<App source={src} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'القوالب' })));
    expect(await screen.findByRole('heading', { name: 'قوالب الرسائل' })).toBeTruthy();
    expect(await screen.findByRole('row', { name: /order_confirmation/ })).toBeTruthy();
  });

  it('a source with no template API has no Templates entry', () => {
    render(<App source={createSampleSource()} now={now} />);
    expect(screen.queryByRole('link', { name: 'القوالب' })).toBeNull();
  });

  it('en strings exist for every ar key (the tpl group at runtime, the rest by the type)', () => {
    const arKeys = Object.keys(STRINGS.ar).filter((k) => k.startsWith('tpl')).sort();
    expect(arKeys.length).toBeGreaterThan(80);
    expect(Object.keys(STRINGS.en).filter((k) => k.startsWith('tpl')).sort()).toEqual(arKeys);
    for (const k of arKeys) {
      const a = (STRINGS.ar as Record<string, unknown>)[k];
      const e = (STRINGS.en as Record<string, unknown>)[k];
      expect(typeof e, k).toBe(typeof a);
      if (typeof a === 'string') { expect((e as string).length, k).toBeGreaterThan(0); expect(a.length, k).toBeGreaterThan(0); }
      if (typeof a === 'object') expect(Object.keys(e as object).sort(), k).toEqual(Object.keys(a as object).sort());
    }
  });

  it('Arabic copy never says a bare "Ebda" and never uses an orange hex', () => {
    const all = JSON.stringify(Object.entries(STRINGS.ar).filter(([k]) => k.startsWith('tpl')).map(([, v]) => (typeof v === 'function' ? '' : v)));
    expect(all).not.toMatch(/\bEbda\b/);
    expect(all).not.toMatch(/#ff6e01/i);
  });
});
