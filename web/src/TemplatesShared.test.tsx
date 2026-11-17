import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedRequestDto, SharedTemplateDto } from '../../src/core/api/contract';
import { App } from './App';
import { TemplatesScreen } from './components/TemplatesScreen';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { TemplatesApi } from './data/source';
import { STRINGS } from './i18n';
import { fakeApi } from './templates-fixtures';
import type { View } from './components/Rail';

afterEach(cleanup);
const t = STRINGS.ar;
const sharedList: SharedTemplateDto[] = [{ name: 'order_update', language: 'ar', category: 'UTILITY', bodyText: 'طلبك {{1}} اتحدّث', paramCount: 1 }];
const req = (over: Partial<SharedRequestDto> = {}): SharedRequestDto => ({ id: 'r1', name: 'order_ready', language: 'ar', category: 'UTILITY', body: 'أهلاً {{1}} طلبك جاهز.', status: 'open', createdAt: Date.UTC(2026, 10, 13), decidedAt: null, ...over });
const sharedOnly = (over: Partial<NonNullable<TemplatesApi['shared']>> = {}, api: Partial<TemplatesApi> = {}): TemplatesApi => fakeApi({
  list: vi.fn(async () => { throw new ApiError('not_found', 404, 'no_active_number'); }),
  shared: { list: vi.fn(async () => sharedList), requests: vi.fn(async () => [req()]), request: vi.fn(async (r) => req({ ...r, id: 'r2' })), ...over },
  ...api,
});
const show = async (api: TemplatesApi, role: 'owner' | 'staff' = 'owner', go?: (v: View) => void) => {
  render(<TemplatesScreen t={t} lang="ar" source={{ ...createSampleSource(), role }} api={api} {...(go ? { onNavigate: go } : {})} />);
  await act(async () => undefined);
};

describe('a store on the shared number', () => {
  it('sees the banner that explains marketing needs its own number, with a button to Numbers', async () => {
    const go = vi.fn();
    await show(sharedOnly(), 'owner', go);
    expect(screen.getByText('إنت شغّال على الرقم المشترك: تقدر تستخدم القوالب الجاهزة هنا، لكن الرسائل التسويقية والحملات محتاجة رقمك الخاص')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اربط رقمك الخاص' }));
    expect(go).toHaveBeenCalledWith('numbers');
  });

  it('lists the platform templates read-only (no new-template button, no edit)', async () => {
    await show(sharedOnly());
    expect(screen.getByRole('table', { name: 'القوالب الجاهزة على الرقم المشترك' })).toBeTruthy();
    expect(screen.getByText('طلبك {{1}} اتحدّث')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'قالب جديد' })).toBeNull();
    expect(screen.queryByRole('button', { name: /فتح/ })).toBeNull();
  });

  it('the request form submits and shows "اتبعت للفريق"; the marketing option is absent', async () => {
    const api = sharedOnly();
    await show(api);
    const category = screen.getByLabelText('نوع القالب') as HTMLSelectElement;
    expect([...category.options].map((o) => o.value)).toEqual(['UTILITY', 'AUTHENTICATION']);
    fireEvent.change(screen.getByLabelText('اسم القالب (حروف إنجليزي صغيرة وشرطة سفلية)'), { target: { value: 'order_ready_2' } });
    fireEvent.change(screen.getByLabelText('نص الرسالة اللي محتاجها'), { target: { value: 'أهلاً {{1}}، طلبك رقم {{2}} جاهز للاستلام.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ابعت الطلب للفريق' })));
    expect(api.shared!.request).toHaveBeenCalledWith({ name: 'order_ready_2', language: 'ar', category: 'UTILITY', body: 'أهلاً {{1}}، طلبك رقم {{2}} جاهز للاستلام.' });
    expect(screen.getAllByRole('status').map((x) => x.textContent).join(' ')).toContain('اتبعت للفريق');
    expect((api.shared!.requests as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // reloaded
  });

  it('a bad name never reaches the API', async () => {
    const api = sharedOnly();
    await show(api);
    fireEvent.change(screen.getByLabelText('اسم القالب (حروف إنجليزي صغيرة وشرطة سفلية)'), { target: { value: 'Bad Name' } });
    fireEvent.change(screen.getByLabelText('نص الرسالة اللي محتاجها'), { target: { value: 'نص' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ابعت الطلب للفريق' })));
    expect(api.shared!.request).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('حروف إنجليزي صغيرة');
  });

  it('shows the store\'s own requests with their status in words', async () => {
    await show(sharedOnly({ requests: vi.fn(async () => [req(), req({ id: 'r2', name: 'done_one', status: 'done' }), req({ id: 'r3', name: 'no_one', status: 'declined' })]) }));
    const mine = screen.getByRole('region', { name: 'طلباتك' });
    expect(within(mine).getByText('مستني الفريق')).toBeTruthy();
    expect(within(mine).getByText('اتعمل')).toBeTruthy();
    expect(within(mine).getByText('اتّرفض')).toBeTruthy();
  });

  it('the sixth open request says why it was refused', async () => {
    await show(sharedOnly({ request: vi.fn(async () => { throw new ApiError('rate_limited', 429, 'too_many_open_requests'); }) }));
    fireEvent.change(screen.getByLabelText('اسم القالب (حروف إنجليزي صغيرة وشرطة سفلية)'), { target: { value: 'another_one' } });
    fireEvent.change(screen.getByLabelText('نص الرسالة اللي محتاجها'), { target: { value: 'نص الرسالة' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ابعت الطلب للفريق' })));
    expect(screen.getByRole('alert').textContent).toContain('عندك 5 طلبات مفتوحة');
  });

  it('staff may read but get no request form', async () => {
    await show(sharedOnly(), 'staff');
    expect(screen.getByRole('table', { name: 'القوالب الجاهزة على الرقم المشترك' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ابعت الطلب للفريق' })).toBeNull();
    expect(screen.queryByLabelText('نص الرسالة اللي محتاجها')).toBeNull();
    expect(screen.getByRole('region', { name: 'طلباتك' })).toBeTruthy();
  });
});

describe('neither own nor shared number', () => {
  it('a 404 from the shared list too leaves the connect prompt', async () => {
    await show(sharedOnly({ list: vi.fn(async () => { throw new ApiError('not_found', 404); }) }));
    expect(screen.getByText('اربط رقم واتساب الأول')).toBeTruthy();
  });
  it('a build without the shared API shows the connect prompt for a missing number', async () => {
    await show(fakeApi({ list: vi.fn(async () => { throw new ApiError('not_found', 404, 'no_active_number'); }) }));
    expect(screen.getByText('اربط رقم واتساب الأول')).toBeTruthy();
  });
});

describe('through the app', () => {
  it('the Rail still opens the screen for a shared-only store', async () => {
    render(<App source={{ ...createSampleSource(), templatesApi: sharedOnly() }} now={() => Date.UTC(2026, 10, 14)} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'القوالب' })));
    expect(await screen.findByText(/إنت شغّال على الرقم المشترك/)).toBeTruthy();
  });
});

describe('operator console', () => {
  it('shows what stores asked for, with the workspace id and status', async () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    source.sharedTemplates!.requests = vi.fn(async () => [{ ...req(), workspaceId: 'ws-123' }]);
    render(<App source={source} now={() => Date.UTC(2026, 10, 14)} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: STRINGS.ar.opNav })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: STRINGS.ar.opTabs.shared! })));
    const region = await screen.findByRole('region', { name: STRINGS.ar.opSharedRequestsTitle });
    expect(within(region).getByText('ws-123')).toBeTruthy();
    expect(within(region).getByText('order_ready')).toBeTruthy();
  });
});
