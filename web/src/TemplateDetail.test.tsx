import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateDetail } from './components/TemplateDetail';
import { TemplatesScreen } from './components/TemplatesScreen';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { TemplatesApi } from './data/source';
import { STRINGS } from './i18n';
import { fakeApi, tpl } from './templates-fixtures';
import type { TemplateDto } from '../../src/core/api/contract';

afterEach(cleanup);
const t = STRINGS.ar;
const onBack = vi.fn();
const onEdit = vi.fn();
const onDeleted = vi.fn();
const open = async (template: TemplateDto, api: TemplatesApi = fakeApi({ detail: vi.fn(async () => template) }), owner = true) => {
  render(<TemplateDetail t={t} lang="ar" api={api} owner={owner} template={template} onBack={onBack} onEdit={onEdit} onDeleted={onDeleted} />);
  await act(async () => undefined);
  return api;
};
const REJECTED = tpl({ name: 'late_t', status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', advice: { kind: 'format', ar: 'ميتا رفضت القالب بسبب شكل المتغيّرات.', en: 'x' } });

describe('rejected', () => {
  it('shows the advice, the raw code in a details, and an edit-and-resubmit button that opens the editor', async () => {
    await open(REJECTED);
    expect(screen.getByText('ميتا رفضت القالب بسبب شكل المتغيّرات.')).toBeTruthy();
    const details = document.querySelector('details')!;
    expect(details.textContent).toContain('INVALID_FORMAT');
    expect(details.textContent).toContain('كود السبب من ميتا');
    expect(screen.getByText('ميتا رفضته. شوف السبب تحت وعدّل القالب.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'عدّل وابعت تاني' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ name: 'late_t' }));
  });
});

describe('approved', () => {
  it('locks the category and shows the 24 h wait text after a recent edit, with the edit button disabled', async () => {
    const retryAt = Date.UTC(2026, 10, 15, 12, 0);
    await open(tpl({ status: 'APPROVED', editAllowance: { allowed: false, reason: 'daily', retryAt } }));
    expect(screen.getByText('نوع القالب مقفول بعد موافقة ميتا.')).toBeTruthy();
    expect(screen.getByText(/تقدر تعدّل تاني بعد/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'عدّل القالب' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('an allowed approved template can be edited', async () => {
    await open(tpl({ status: 'APPROVED' }));
    expect((screen.getByRole('button', { name: 'عدّل القالب' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('PENDING cannot be edited and says why', async () => {
    await open(tpl({ status: 'PENDING', editAllowance: { allowed: false, reason: 'status', retryAt: null } }));
    expect((screen.getByRole('button', { name: 'عدّل وابعت تاني' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('مينفعش تعدّل القالب وهو تحت المراجعة.')).toBeTruthy();
  });
});

describe('delete', () => {
  it('asks for confirmation and mentions the 30-day rule and the campaigns for an approved template; nothing is deleted before confirm', async () => {
    const api = await open(tpl({ status: 'APPROVED' }));
    fireEvent.click(screen.getByRole('button', { name: 'امسح القالب' }));
    const dlg = screen.getByRole('alertdialog');
    expect(dlg.textContent).toContain('30 يوم');
    expect(dlg.textContent).toContain('كل الحملات اللي بتستخدمه');
    expect(api.remove).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، امسحه' })));
    expect(api.remove).toHaveBeenCalledWith('order_confirmation', 'ar');
    expect(onDeleted).toHaveBeenCalled();
  });

  it('a template that was never approved does not mention the 30 days', async () => {
    await open(REJECTED);
    fireEvent.click(screen.getByRole('button', { name: 'امسح القالب' }));
    expect(screen.getByRole('alertdialog').textContent).not.toContain('30 يوم');
  });

  it('409 in_use shows the campaign sentence and keeps the template', async () => {
    onDeleted.mockClear();
    const tp = tpl({ status: 'APPROVED' });
    await open(tp, fakeApi({ detail: vi.fn(async () => tp), remove: vi.fn(async () => { throw new ApiError('invalid_request', 409, 'in_use'); }) }));
    fireEvent.click(screen.getByRole('button', { name: 'امسح القالب' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، امسحه' })));
    expect(screen.getByRole('alert').textContent).toContain('لسه مستخدم في حملة');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('DISABLED has no delete button and no edit button, and says why', async () => {
    await open(tpl({ status: 'DISABLED' }));
    expect(screen.queryByRole('button', { name: 'امسح القالب' })).toBeNull();
    expect(screen.queryByRole('button', { name: /عدّل/ })).toBeNull();
    expect(screen.getAllByText(/متعطّل من ميتا ومينفعش يتمسح/).length).toBeGreaterThan(0);
  });
});

describe('staff', () => {
  it('see the detail read-only', async () => {
    await open(REJECTED, undefined, false);
    expect(screen.getByText('ميتا رفضت القالب بسبب شكل المتغيّرات.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'عدّل وابعت تاني' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'امسح القالب' })).toBeNull();
    expect(screen.getByText(/بتشوف القوالب للقراءة بس/)).toBeTruthy();
  });
});

describe('through the screen', () => {
  it('edit and resubmit calls api.edit with the checked hash and the list shows PENDING afterwards', async () => {
    let status = 'REJECTED';
    const api = fakeApi({
      list: vi.fn(async () => ({ items: [status === 'REJECTED' ? REJECTED : tpl({ name: 'late_t', status: 'PENDING', editAllowance: { allowed: false, reason: 'status', retryAt: null } })], starterInstalled: true })),
      detail: vi.fn(async () => REJECTED),
      edit: vi.fn(async () => { status = 'PENDING'; return { status: 'PENDING' }; }),
    });
    render(<TemplatesScreen t={t} lang="ar" source={{ ...createSampleSource(), role: 'owner' }} api={api} />);
    await act(async () => undefined);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /فتح/ })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'عدّل وابعت تاني' })));
    expect(screen.getByRole('heading', { name: 'تعديل القالب' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('نص الرسالة'), { target: { value: 'أهلاً {{1}} طلبك اتسجّل عندنا.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'راجع وابعت لميتا' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(api.edit).toHaveBeenCalledWith('late_t', 'ar', expect.objectContaining({ name: 'late_t' }), 'a'.repeat(64));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'تمام' })));
    expect(await screen.findByText('قيد مراجعة ميتا (لحد يوم)')).toBeTruthy();
  });
});
