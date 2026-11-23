import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const click = (el: HTMLElement) => act(async () => fireEvent.click(el));

describe('product suggestions after an order (CHAT-RECS-SWITCH-1)', () => {
  it('is off by default, explains the template + consent + wallet cost, and needs a template name before it can be turned on', async () => {
    const source = createSampleSource();
    render(<App source={source} now={now} />);
    await click(screen.getByRole('link', { name: 'البوت' }));
    await screen.findByRole('heading', { name: 'ترشيح منتجات بعد الطلب' });
    const card = screen.getByRole('heading', { name: 'ترشيح منتجات بعد الطلب' }).closest('section')!;
    expect(card.textContent).toContain('موافَق عليه');
    expect(card.textContent).toContain('بتتخصم من محفظتك');
    const sw = screen.getByRole('switch', { name: 'ابعت ترشيح منتجات بعد الطلب' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await click(sw);
    expect((await source.proactiveRecs!.get()).enabled).toBe(false);
    expect(screen.getByText('اكتب اسم القالب الأول.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('اسم القالب الموافَق عليه'), { target: { value: 'post_order_recs' } });
    await click(screen.getByRole('button', { name: 'احفظ القالب' }));
    await click(screen.getByRole('switch', { name: 'ابعت ترشيح منتجات بعد الطلب' }));
    expect(await source.proactiveRecs!.get()).toMatchObject({ enabled: true, templateName: 'post_order_recs' });
  });
});
