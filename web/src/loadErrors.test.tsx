import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

// A failed load is "unknown", never "empty": every screen says so and offers Retry (finding 1+2 of the final review).
const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const down = () => Promise.reject(new Error('network'));

/** Opens a rail section on a source whose call fails once, then recovers. */
async function openFailing(link: string, heading: string, source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: link })));
  await screen.findByRole('heading', { name: heading });
  return source;
}
const failOnce = <T extends object, K extends keyof T>(obj: T, key: K) => {
  const real = obj[key] as unknown as (...a: unknown[]) => Promise<unknown>;
  const spy = vi.fn(real).mockImplementationOnce(down);
  (obj as Record<K, unknown>)[key] = spy;
  return spy;
};

describe('a failed load shows an error with Retry, never the empty copy', () => {
  it('wallet: the first load failing shows the error, and Retry loads it', async () => {
    const source = createSampleSource();
    render(<App source={source} now={now} />);
    await screen.findByRole('link', { name: 'المحفظة' });
    failOnce(source.wallet!, 'wallet'); // the inbox banner has read its copy already; the wallet screen's first read fails
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t.walletLoadError);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByRole('heading', { name: 'المحفظة', level: 1 })).toBeTruthy();
  });

  it('numbers', async () => {
    const source = createSampleSource();
    failOnce(source.numbers!, 'list');
    await openFailing('رقم واتساب', 'رقم واتساب', source);
    expect(screen.queryByText(t.numbersEmpty)).toBeNull();
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByRole('article', { name: /\+20 100 555 0101/ })).toBeTruthy();
  });

  it('campaigns', async () => {
    const source = createSampleSource();
    failOnce(source.campaigns!, 'list');
    await openFailing('الحملات', 'الحملات', source);
    expect(screen.queryByText(t.campaignsEmpty)).toBeNull();
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByRole('article', { name: /عروض العيد/ })).toBeTruthy();
  });

  it('contacts', async () => {
    const source = createSampleSource();
    failOnce(source.contacts!, 'list');
    await openFailing('العملاء', 'العملاء', source);
    expect(screen.queryByText(t.contactsEmpty)).toBeNull();
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByRole('listbox', { name: 'العملاء' })).toBeTruthy();
  });

  it('wallet refunds list', async () => {
    const source = createSampleSource();
    failOnce(source.wallet!, 'refundRequests');
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    expect(within(card).queryByText(t.wRefundEmpty)).toBeNull();
    const alert = await within(card).findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('campaign form: templates failing is not "no templates"', async () => {
    const source = createSampleSource();
    await openFailing('الحملات', 'الحملات', source);
    failOnce(source, 'templates');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
    expect(screen.queryByText(t.noTemplates)).toBeNull();
    const alert = await screen.findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByLabelText('اختار قالب معتمد')).toBeTruthy();
  });

  it('inbox: templates failing shows the banner and Retry reloads them (no unhandled rejection)', async () => {
    const source = createSampleSource();
    failOnce(source, 'templates');
    render(<App source={source} now={now} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t.dataLoadError);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('inbox: a customer whose orders failed to load is not told they ordered nothing', async () => {
    const source = createSampleSource();
    failOnce(source, 'orders');
    render(<App source={source} now={now} />);
    const row = (await screen.findByText('منى عبد الرحمن')).closest('button')!;
    await act(async () => fireEvent.click(row));
    const pane = screen.getByRole('complementary', { name: 'طلبات العميل' });
    const alert = await within(pane).findByRole('alert');
    expect(within(pane).queryByText(t.noOrders)).toBeNull();
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await within(pane).findByText('#1048')).toBeTruthy();
  });

  it('contacts: an import history that failed to load says so, and so do its rejected rows', async () => {
    const source = createSampleSource();
    failOnce(source.contacts!, 'imports');
    await openFailing('العملاء', 'العملاء', source);
    const panel = screen.getByRole('complementary', { name: t.importTitle });
    const alert = await within(panel).findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await within(panel).findByText('customers.csv')).toBeTruthy();
    failOnce(source.contacts!, 'rejects');
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: t.showRejects })));
    expect(await within(panel).findByRole('alert')).toBeTruthy();
    expect(within(panel).queryByText(/duplicate|مكرر/)).toBeNull();
  });
});
