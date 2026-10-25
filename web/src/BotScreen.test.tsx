import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const open = async (source = createSampleSource()) => {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'البوت' })));
  await screen.findByRole('heading', { name: 'القايمة والمواعيد والعنوان' });
  return source;
};
const type = (label: string, value: string) => act(async () => fireEvent.change(screen.getByLabelText(label), { target: { value } }));

describe('Bot settings screen', () => {
  it('shows the empty menu, adds a question with ar and en text and saves it', async () => {
    const source = await open();
    expect(screen.getByText('لسه مضفتش أي سؤال. اضغط "أضف سؤال" وابدأ.')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أضف سؤال' })));
    await type('الاسم بالعربي', 'التوصيل');
    await type('الاسم بالإنجليزي', 'Delivery');
    await type('الإجابة بالعربي', 'خلال يومين');
    await type('الإجابة بالإنجليزي', 'Two days');
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'شغّل قايمة الخدمة' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    const saved = await source.botSettings!();
    expect(saved.menu).toEqual({ enabled: true, items: [{ id: 'q1', title: { ar: 'التوصيل', en: 'Delivery' }, answer: { ar: 'خلال يومين', en: 'Two days' } }] });
    expect(screen.getByRole('status').textContent).toContain('اتحفظ');
  });

  it('counts characters, flags a title over 24 and blocks saving until it is short enough', async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أضف سؤال' })));
    await type('الاسم بالعربي', 'س'.repeat(25));
    expect(screen.getAllByText('٢٥ من ٢٤').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('فيه حاجة مش مظبوطة');
  });

  it('reorders and removes questions, and stops adding at eight', async () => {
    const source = createSampleSource();
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `q${i + 1}`, title: { ar: `س${i + 1}`, en: `Q${i + 1}` }, answer: { ar: 'ج', en: 'A' } }));
    await source.saveBotSettings!({ ...(await source.botSettings!()), menu: { enabled: true, items } });
    await open(source);
    expect((screen.getByRole('button', { name: 'أضف سؤال' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'تحت: السؤال ١' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'احذف: السؤال ٨' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    expect((await source.botSettings!()).menu.items.map((i) => i.id)).toEqual(['q2', 'q1', 'q3', 'q4', 'q5', 'q6', 'q7']);
  });

  it('edits a day: adds a period, closes another day, and saves the away message', async () => {
    const source = await open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أضف فترة: الأحد' })));
    await act(async () => fireEvent.change(screen.getByLabelText('من (الأحد)'), { target: { value: '09:30' } }));
    await act(async () => fireEvent.change(screen.getByLabelText('لحد (الأحد)'), { target: { value: '02:00' } }));
    await type('رسالة الإجازة بالعربي', 'هنرد الصبح');
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'شغّل مواعيد الشغل' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    const h = (await source.botSettings!()).hours;
    expect(h.enabled).toBe(true);
    expect(h.week[0]).toEqual([{ open: '09:30', close: '02:00' }]);
    expect(h.awayMessage.ar).toBe('هنرد الصبح');
  });

  it('location: a map link preview once the coordinates are valid; half-filled blocks saving; clearing saves null', async () => {
    const source = await open();
    await type('اسم المكان', 'متجر الورد');
    expect((screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement).disabled).toBe(true); // half filled
    await type('العنوان', '١٢ شارع التحرير');
    await type('خط العرض', '30.0381');
    await type('خط الطول', '31.2122');
    expect(screen.getByRole('link', { name: 'افتح على الخريطة' }).getAttribute('href')).toBe('https://maps.google.com/?q=30.0381,31.2122');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    expect((await source.botSettings!()).location).toEqual({ name: 'متجر الورد', address: '١٢ شارع التحرير', latitude: 30.0381, longitude: 31.2122 });
    await act(async () => fireEvent.change(screen.getByLabelText('خط العرض'), { target: { value: '95' } }));
    expect((screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'امسح العنوان' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    expect((await source.botSettings!()).location).toBeNull();
  });

  it('staff can read but not change: fields are disabled and there is no save button', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    await open(source);
    expect(screen.getByText('تقدر تشوف الإعدادات بس. التعديل لصاحب المتجر.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'حفظ' })).toBeNull();
    expect((screen.getByRole('switch', { name: 'شغّل قايمة الخدمة' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('a failed load says so and offers Retry; a failed save says so', async () => {
    const source = createSampleSource();
    const real = source.botSettings!.bind(source);
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockImplementation(real);
    source.botSettings = load;
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'البوت' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'حاول تاني' })));
    await screen.findByRole('heading', { name: 'القايمة والمواعيد والعنوان' });
    source.saveBotSettings = vi.fn().mockRejectedValue(new Error('x'));
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'شغّل مواعيد الشغل' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    expect(screen.getByRole('status').textContent).toContain('مقدرناش نحفظ');
  });
});

describe('WhatsApp catalog on the Bot screen', () => {
  const fail = (detail: string, status = 409) => Object.assign(new Error(detail), { status, detail });
  const create = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'اعمل كتالوج واتساب' })));

  it('with no catalog offers to create one; after creating it shows the catalog id and that no sync ran yet', async () => {
    const source = await open();
    expect(screen.getByText(/مفيش كتالوج متوصّل/)).toBeTruthy();
    await create();
    expect(screen.getByRole('status').textContent).toContain('الكتالوج اتعمل');
    expect(screen.getByText(/رقم الكتالوج/).textContent).toContain('1234567890123');
    expect(screen.getByText(/لسه مفيش مزامنة/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعمل كتالوج واتساب' })).toBeNull();
    expect((await source.catalog!.status()).catalogId).toBe('1234567890123');
  });

  it('with a catalog set shows its id and the last sync, and no create button', async () => {
    const source = createSampleSource();
    source.catalog!.status = async () => ({ catalogId: '5550001111', lastSyncAt: Date.UTC(2026, 9, 24, 16, 0) });
    await open(source);
    expect(screen.getByText(/رقم الكتالوج/).textContent).toContain('5550001111');
    expect(screen.getByText(/آخر مزامنة/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعمل كتالوج واتساب' })).toBeNull();
  });

  it.each([
    ['missing_permission', /صلاحية الكتالوج/],
    ['no_business', /اربط الرقم من جديد/],
    ['business_mismatch', /اربط الرقم من جديد/],
    ['meta_error', /ميتا مش بترد/],
  ])('%s is explained in words and the button stays so the merchant can retry', async (detail, text) => {
    const source = createSampleSource();
    source.catalog!.provision = vi.fn().mockRejectedValue(fail(detail, detail === 'meta_error' ? 503 : 403));
    await open(source);
    await create();
    expect(screen.getByRole('alert').textContent).toMatch(text);
    expect(screen.getByRole('button', { name: 'اعمل كتالوج واتساب' })).toBeTruthy();
  });

  it('shows progress while Meta works and blocks a second click', async () => {
    const source = createSampleSource();
    let release!: () => void;
    const slow = new Promise<{ catalogId: string }>((r) => { release = () => r({ catalogId: '777000777' }); });
    source.catalog!.provision = vi.fn().mockReturnValue(slow);
    await open(source);
    await create();
    expect(screen.getByRole('status').textContent).toContain('بنعمل الكتالوج');
    expect((screen.getByRole('button', { name: 'اعمل كتالوج واتساب' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect(screen.getByText(/رقم الكتالوج/).textContent).toContain('777000777');
    expect(source.catalog!.provision).toHaveBeenCalledTimes(1);
  });

  it('staff can see the state but not create', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    await open(source);
    expect(screen.getByText(/مفيش كتالوج متوصّل/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعمل كتالوج واتساب' })).toBeNull();
  });

  it('English strings exist for every state', async () => {
    const { STRINGS } = await import('./i18n');
    const ar = Object.keys(STRINGS.ar).filter((k) => k.startsWith('cat'));
    expect(ar.length).toBeGreaterThan(8);
    expect(Object.keys(STRINGS.en).filter((k) => k.startsWith('cat')).sort()).toEqual(ar.sort());
  });
});
