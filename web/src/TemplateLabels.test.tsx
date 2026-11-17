import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import type { TemplateDto } from '../../src/core/api/contract';
import { tpl } from './templates-fixtures';
import { templateTitle } from './lib/format';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const marketing = (over: Partial<TemplateDto> = {}) => tpl({ name: 'eid_offer', category: 'MARKETING', status: 'APPROVED', bodyText: 'كل سنة وانت طيب يا {{1}}! عرض {{2}}', paramCount: 2, label: null, ...over });
function sourceWith(templates: TemplateDto[]) {
  const s = createSampleSource();
  s.templates = async () => templates;
  return s;
}

describe('templateTitle', () => {
  const t = STRINGS.ar;
  it('is the merchant label first, then the shipped Arabic name, then the raw name', () => {
    expect(templateTitle(t, { name: 'eid_offer', label: 'عرض العيد بتاعي' })).toBe('عرض العيد بتاعي');
    expect(templateTitle(t, { name: 'otp_code', label: null })).toBe('كود التحقق');
    expect(templateTitle(t, { name: 'custom_x', label: '   ' })).toBe('custom_x');
  });
});

describe('labels where templates are used', () => {
  const labelled = () => sourceWith([marketing({ label: 'عرض العيد بتاعي' }), tpl({ name: 'my_ship', label: 'شحنتي', status: 'APPROVED' })]);

  it('a custom template with a label shows the label in the chat template popover', async () => {
    const src = labelled();
    render(<App source={src} now={now} />);
    const conv = await screen.findByRole('option', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(conv));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'اختيار قالب' })[0]!));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('شحنتي')).toBeTruthy();
  });

  it('a custom template with a label shows the label in the campaign list and the campaign picker', async () => {
    const src = labelled();
    render(<App source={src} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
    const running = await screen.findByRole('article', { name: /عروض العيد/ });
    expect(within(running).getByText('عرض العيد بتاعي')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    const select = await screen.findByLabelText('اختار قالب معتمد');
    expect(within(select).getByRole('option', { name: 'عرض العيد بتاعي' })).toBeTruthy();
  });

  it('the empty marketing list links to the Templates screen', async () => {
    const src = { ...sourceWith([tpl({ name: 'util_only', status: 'APPROVED' })]), templatesApi: undefined };
    render(<App source={src} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    expect(await screen.findByText(/مفيش قالب تسويق معتمد لسه/)).toBeTruthy();
    // without a Templates screen in this build there is nothing to link to; with one, the link is there
    expect(screen.queryByRole('button', { name: 'روح لصفحة القوالب' })).toBeNull();
  });

  it('with the Templates screen available, the empty state link opens it', async () => {
    const { fakeApi } = await import('./templates-fixtures');
    const src = { ...sourceWith([]), templatesApi: fakeApi() };
    render(<App source={src} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    const link = await screen.findByRole('button', { name: 'روح لصفحة القوالب' });
    await act(async () => fireEvent.click(link));
    expect(await screen.findByRole('heading', { name: 'قوالب الرسائل' })).toBeTruthy();
  });

  it('a paused or pending marketing template is shown disabled with its reason instead of vanishing', async () => {
    const src = sourceWith([marketing({ label: 'جاهز' }), marketing({ name: 'p_one', label: 'موقوفة', status: 'PAUSED' }), marketing({ name: 'p_two', label: 'مستنية', status: 'PENDING' }), marketing({ name: 'r_one', label: 'مرفوضة', status: 'REJECTED' })]);
    render(<App source={src} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    const select = await screen.findByLabelText('اختار قالب معتمد');
    const paused = within(select).getByRole('option', { name: 'موقوفة (موقوف مؤقتًا)' }) as HTMLOptionElement;
    expect(paused.disabled).toBe(true);
    expect((within(select).getByRole('option', { name: /مستنية/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((within(select).getByRole('option', { name: 'جاهز' }) as HTMLOptionElement).disabled).toBe(false);
    expect(within(select).queryByRole('option', { name: /مرفوضة/ })).toBeNull();
  });
});
