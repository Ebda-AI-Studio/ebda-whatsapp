import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);

async function openCampaigns(source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
  await screen.findByRole('heading', { name: 'الحملات' });
  return source;
}

describe('campaigns', () => {
  it('lists campaigns with status, progress and why a campaign is paused', async () => {
    await openCampaigns();
    const running = screen.getByRole('article', { name: /عروض العيد/ });
    expect(within(running).getByText('شغالة')).toBeTruthy();
    expect(within(running).getByText(/860 من 1٬240|860 من 1,240|860 من 1240/)).toBeTruthy();
    const paused = screen.getByRole('article', { name: /تخفيضات نص الشهر/ });
    expect(within(paused).getByText('المحفظة فاضية. اشحن رصيد وكمّل الحملة.')).toBeTruthy();
  });

  it('creates a campaign: audience count, template variables, cost estimate, then sends', async () => {
    const source = await openCampaigns();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    fireEvent.change(screen.getByLabelText('اسم الحملة (ليك إنت بس)'), { target: { value: 'عرض الجمعة' } });
    await act(async () => fireEvent.click(screen.getByLabelText('العملاء اللي عندهم وسم')));
    await act(async () => fireEvent.change(screen.getByLabelText('الوسم'), { target: { value: 'vip' } }));
    expect(await screen.findByText(/^هتوصل لـ/)).toBeTruthy();
    expect(screen.getByText(/مفيش موافقة مسجلة/)).toBeTruthy();

    await act(async () => fireEvent.change(screen.getByLabelText('اختار قالب معتمد'), { target: { value: 'eid_offer|ar' } }));
    // Only approved marketing templates are offered.
    expect(screen.queryByRole('option', { name: /تأكيد الدفع عند الاستلام/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('نوع المتغير 1'), { target: { value: 'name' } });
    fireEvent.change(screen.getByLabelText('لو مفيش اسم، اكتب'), { target: { value: 'يا فندم' } });
    fireEvent.change(screen.getByLabelText('نوع المتغير 2'), { target: { value: 'link' } });
    fireEvent.change(screen.getByLabelText('اللينك بيودّي على'), { target: { value: 'https://example.com/friday' } });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'راجع التكلفة' })));
    expect(await screen.findByText(/التكلفة المتوقعة/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ابعت الحملة' })));

    const created = (await source.campaigns!.list()).find((c) => c.name === 'عرض الجمعة')!;
    expect(created.status).toBe('running');
    expect(created.params).toEqual([{ kind: 'name', fallback: 'يا فندم' }, { kind: 'link' }]);
    expect(created.linkUrl).toBe('https://example.com/friday');
    expect(created.audience.criteria).toEqual({ tags: { any: ['vip'] } });
  });

  async function reviewWithZeroCost(funding: 'merchant_card' | 'platform_line' | 'unknown') {
    const source = createSampleSource();
    const create = source.campaigns!.create;
    source.campaigns!.create = async (req) => ({ ...(await create(req)), estimate: { audience: 500, perMessageMinor: 0, totalMinor: 0 } });
    const wallet = source.wallet!.wallet;
    source.wallet!.wallet = async () => ({ ...(await wallet()), funding: [{ phoneNumberId: 'pn-sample-1', displayPhone: '+20 100 555 0101', funding }] });
    await openCampaigns(source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    fireEvent.change(screen.getByLabelText('اسم الحملة (ليك إنت بس)'), { target: { value: 'x' } });
    await act(async () => fireEvent.change(screen.getByLabelText('اختار قالب معتمد'), { target: { value: 'back_in_stock|ar' } }));
    fireEvent.change(screen.getByLabelText('نوع المتغير 1'), { target: { value: 'text' } });
    fireEvent.change(screen.getByLabelText('النص'), { target: { value: 'أهلًا' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'راجع التكلفة' })));
    await screen.findByRole('heading', { name: 'راجع وابعت' });
  }

  it('a zero cost on a number whose card Meta bills says so, instead of waiting for the wallet', async () => {
    await reviewWithZeroCost('merchant_card');
    expect(screen.getByText('واتساب بيحاسب كارتك مباشرة على الرسايل دي، ومفيش حاجة هتتخصم من المحفظة.')).toBeTruthy();
    expect(screen.queryByText('التكلفة هتظهر هنا لما المحفظة تتفعّل.')).toBeNull();
  });

  it('a zero cost on a wallet-paid number still says the price is not ready', async () => {
    await reviewWithZeroCost('platform_line');
    expect(screen.getByText('التكلفة هتظهر هنا لما المحفظة تتفعّل.')).toBeTruthy();
  });

  it('a zero cost on a number whose payer is unknown is not claimed as card billing', async () => {
    await reviewWithZeroCost('unknown');
    expect(screen.getByText('التكلفة هتظهر هنا لما المحفظة تتفعّل.')).toBeTruthy();
    expect(screen.queryByText('واتساب بيحاسب كارتك مباشرة على الرسايل دي، ومفيش حاجة هتتخصم من المحفظة.')).toBeNull();
  });

  it('every pause reason the server can send has words, and an unknown one still says something', async () => {
    const source = createSampleSource();
    const list = source.campaigns!.list;
    const reasons = ['plan_blocked', 'funding_unknown', 'rate_unavailable', 'brand_new_code'];
    source.campaigns!.list = async () => {
      const base = (await list())[0]!;
      return reasons.map((r, i) => ({ ...base, id: `p${i}`, name: `حملة ${i}`, status: 'paused' as const, pauseReason: r as never }));
    };
    await openCampaigns(source);
    const texts = reasons.map((_r, i) => (within(screen.getByRole('article', { name: `حملة ${i}` })).getByText((_c, el) => el?.className === 'campaign-reason')).textContent);
    expect(texts.every((x) => !!x && x.length > 8)).toBe(true);
    expect(new Set(texts).size).toBe(4);
    expect(texts[3]).toBe(STRINGS.ar.pauseUnknown);
    // WA-SUPPORT-1: an unknown reason (and operator_paused) says where to write; a known self-serve reason does not.
    const contact = (i: number) => within(screen.getByRole('article', { name: `حملة ${i}` })).queryByText((_c, el) => el?.className === 'campaign-reason-contact')?.textContent;
    expect(contact(3)).toBe(STRINGS.ar.pauseContact('ahlan@ebda.app'));
    expect(contact(0)).toBeUndefined();
  });

  it('an audience count that could not be computed says so, never "0 recipients"', async () => {
    const source = createSampleSource();
    source.campaigns!.preview = vi.fn().mockRejectedValue(new Error('network'));
    const create = source.campaigns!.create;
    source.campaigns!.create = async (req) => ({ ...(await create(req)), estimate: undefined });
    await openCampaigns(source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    await act(async () => fireEvent.click(screen.getByLabelText('كل العملاء اللي وافقوا')));
    expect((await screen.findByText(STRINGS.ar.audienceUnknown))).toBeTruthy();
    expect(screen.queryByText(/^هتوصل لـ/)).toBeNull();
    fireEvent.change(screen.getByLabelText('اسم الحملة (ليك إنت بس)'), { target: { value: 'x' } });
    await act(async () => fireEvent.change(screen.getByLabelText('اختار قالب معتمد'), { target: { value: 'back_in_stock|ar' } }));
    fireEvent.change(screen.getByLabelText('نوع المتغير 1'), { target: { value: 'text' } });
    fireEvent.change(screen.getByLabelText('النص'), { target: { value: 'أهلًا' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'راجع التكلفة' })));
    const review = (await screen.findByRole('heading', { name: 'راجع وابعت' })).closest('section')!;
    expect(within(review).getByText(STRINGS.ar.audienceUnknown)).toBeTruthy();
    expect(within(review).queryByText(/^هتوصل لـ/)).toBeNull();
  });

  it('refuses to review a tracked link that is not https', async () => {
    await openCampaigns();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    fireEvent.change(screen.getByLabelText('اسم الحملة (ليك إنت بس)'), { target: { value: 'x' } });
    await act(async () => fireEvent.change(screen.getByLabelText('اختار قالب معتمد'), { target: { value: 'back_in_stock|ar' } }));
    fireEvent.change(screen.getByLabelText('نوع المتغير 1'), { target: { value: 'link' } });
    fireEvent.change(screen.getByLabelText('اللينك بيودّي على'), { target: { value: 'http://example.com' } });
    expect((screen.getByRole('button', { name: 'راجع التكلفة' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why the server refused a campaign', async () => {
    const source = createSampleSource();
    source.campaigns!.create = vi.fn().mockRejectedValue(new ApiError('template_not_approved', 409));
    await openCampaigns(source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    fireEvent.change(screen.getByLabelText('اسم الحملة (ليك إنت بس)'), { target: { value: 'x' } });
    await act(async () => fireEvent.change(screen.getByLabelText('اختار قالب معتمد'), { target: { value: 'back_in_stock|ar' } }));
    fireEvent.change(screen.getByLabelText('نوع المتغير 1'), { target: { value: 'text' } });
    fireEvent.change(screen.getByLabelText('النص'), { target: { value: 'أهلًا' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'راجع التكلفة' })));
    expect((await screen.findByRole('alert')).textContent).toContain('القالب ده مبقاش معتمد');
  });

  it('cancelling asks first, inline', async () => {
    const source = await openCampaigns();
    const running = screen.getByRole('article', { name: /عروض العيد/ });
    await act(async () => fireEvent.click(within(running).getByRole('button', { name: 'إلغاء الحملة' })));
    expect((await source.campaigns!.get('c-1')).status).toBe('running');
    await act(async () => fireEvent.click(within(running).getByRole('button', { name: 'أيوه، الغي' })));
    expect((await source.campaigns!.get('c-1')).status).toBe('cancelled');
  });

  it('staff can pause but cannot create, send or resume', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    await openCampaigns(source);
    expect(screen.queryByRole('button', { name: 'حملة جديدة' })).toBeNull();
    const paused = screen.getByRole('article', { name: /تخفيضات نص الشهر/ });
    expect(within(paused).queryByRole('button', { name: 'كمّل' })).toBeNull();
    const running = screen.getByRole('article', { name: /عروض العيد/ });
    await act(async () => fireEvent.click(within(running).getByRole('button', { name: 'وقّف' })));
    expect((await source.campaigns!.get('c-1')).status).toBe('paused');
  });
});

describe('contacts', () => {
  async function openContacts(source = createSampleSource()) {
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'العملاء' })));
    await screen.findByRole('heading', { name: 'العملاء' });
    return source;
  }

  it('lists contacts with consent and opt-out, and filters opted-out', async () => {
    await openContacts();
    expect(await screen.findByText('نورا حسن')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'طلبوا يوقفوا الرسايل' })));
    const list = screen.getByRole('listbox', { name: 'العملاء' });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByText('مصطفى عادل')).toBeTruthy();
  });

  it('imports a CSV without consent unless the owner ticks it', async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source.contacts!, 'importCsv');
    await openContacts(source);
    const file = new File(['phone,name\n01001234567,Test\n'], 'list.csv', { type: 'text/csv' });
    const start = screen.getByRole('button', { name: 'ابدأ الاستيراد' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await act(async () => fireEvent.change(screen.getByLabelText('اختار ملف'), { target: { files: [file] } }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    await act(async () => fireEvent.click(start));
    expect(spy).toHaveBeenCalledWith(file, false, STRINGS.ar.importConsent);
    expect(await screen.findByText('list.csv')).toBeTruthy();
  });

  it('a ticked import sends the exact sentence next to the tick as its wording (A4)', async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source.contacts!, 'importCsv');
    await openContacts(source);
    const file = new File(['phone,name\n01001234567,Test\n'], 'list.csv', { type: 'text/csv' });
    await act(async () => fireEvent.change(screen.getByLabelText('اختار ملف'), { target: { files: [file] } }));
    await act(async () => fireEvent.click(screen.getByRole('checkbox')));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ابدأ الاستيراد' })));
    expect(spy).toHaveBeenCalledWith(file, true, screen.getAllByText(STRINGS.ar.importConsent)[0]!.textContent);
  });

  it('shows rejected rows of an import with readable reasons', async () => {
    await openContacts();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'شوف المرفوض' })));
    expect(await screen.findByText('الرقم مش صحيح')).toBeTruthy();
    expect(screen.getByText('الرقم متكرر في الملف')).toBeTruthy();
  });
});
