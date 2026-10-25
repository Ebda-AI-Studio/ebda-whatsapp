import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { SignupStopped } from './lib/embedded-signup';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);

async function open(source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'رقم واتساب' })));
  await screen.findByRole('heading', { name: 'رقم واتساب' });
  return source;
}

describe('numbers', () => {
  it('shows each number in plain words: working on the Business app too, or waiting for registration', async () => {
    await open();
    const shop = screen.getByRole('article', { name: /\+20 100 555 0101/ });
    expect(within(shop).getByText('شغال')).toBeTruthy();
    expect(within(shop).getByText('شغال كمان على تطبيق واتساب بيزنس')).toBeTruthy();
    const second = screen.getByRole('article', { name: /\+20 100 555 0202/ });
    expect(within(second).getByText('التسجيل ما خلصش')).toBeTruthy();
  });

  it('connects a number: the popup result goes straight to the server and the number appears', async () => {
    const source = createSampleSource();
    const connect = vi.spyOn(source.numbers!, 'connect');
    await open(source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'اربط رقم واتساب' })));
    expect(connect).toHaveBeenCalledWith({ code: 'sample-code', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'waba-sample-3', phoneNumberId: 'pn-sample-3' });
    expect(await screen.findByRole('article', { name: /\+20 100 555 0303/ })).toBeTruthy();
  });

  it('explains a cancelled popup and a WhatsApp account with no number', async () => {
    const source = createSampleSource();
    source.numbers!.launch = vi.fn().mockRejectedValueOnce(new SignupStopped('cancelled', 'PHONE_NUMBER_SETUP')).mockRejectedValueOnce(new SignupStopped('no_number'));
    await open(source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'اربط رقم واتساب' })));
    expect((await screen.findByRole('status')).textContent).toContain('قفلت نافذة الربط');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'اربط رقم واتساب' })));
    expect((await screen.findByRole('alert')).textContent).toContain('من غير رقم');
  });

  it('loads the signup config and the Meta SDK when the screen opens, so the click opens the popup at once', async () => {
    const source = createSampleSource();
    const cfg = { appId: 'app-1', configId: 'cfg-1', graphVersion: 'v25.0' };
    source.numbers!.signupConfig = vi.fn().mockResolvedValue(cfg);
    source.numbers!.prepare = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn().mockReturnValue(new Promise(() => undefined));
    source.numbers!.launch = launch;
    await open(source);
    await waitFor(() => expect(source.numbers!.prepare).toHaveBeenCalledWith(cfg));
    const btn = screen.getByRole('button', { name: 'اربط رقم واتساب' });
    act(() => { fireEvent.click(btn); }); // nothing awaited between the click and FB.login: a browser drops a popup opened later
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(cfg);
    expect(source.numbers!.signupConfig).toHaveBeenCalledTimes(1); // not fetched again on the click
  });

  it('a click before the config has arrived still connects (it waits for it)', async () => {
    const source = createSampleSource();
    let release!: (c: { appId: string; configId: string; graphVersion: string }) => void;
    source.numbers!.signupConfig = vi.fn().mockReturnValue(new Promise((r) => { release = r; }));
    const launch = vi.fn().mockReturnValue(new Promise(() => undefined));
    source.numbers!.launch = launch;
    await open(source);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'اربط رقم واتساب' })); });
    expect(launch).not.toHaveBeenCalled();
    await act(async () => release({ appId: 'a', configId: 'c', graphVersion: 'v25.0' }));
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  });

  it('retries a failed registration, and disconnecting asks first', async () => {
    const source = createSampleSource();
    const register = vi.spyOn(source.numbers!, 'register');
    await open(source);
    const second = screen.getByRole('article', { name: /\+20 100 555 0202/ });
    await act(async () => fireEvent.click(within(second).getByRole('button', { name: 'كمّل التسجيل' })));
    expect(register).toHaveBeenCalledWith('pn-sample-2');
    const shop = screen.getByRole('article', { name: /\+20 100 555 0101/ });
    await act(async () => fireEvent.click(within(shop).getByRole('button', { name: 'افصل الرقم' })));
    expect((await source.numbers!.list()).find((n) => n.phoneNumberId === 'pn-sample-1')!.status).toBe('active');
    await act(async () => fireEvent.click(within(shop).getByRole('button', { name: 'أيوه، افصله' })));
    expect((await source.numbers!.list()).find((n) => n.phoneNumberId === 'pn-sample-1')!.status).toBe('disconnected');
  });

  it('staff see the numbers but cannot connect or disconnect', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    await open(source);
    expect(screen.queryByRole('button', { name: 'اربط رقم واتساب' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'افصل الرقم' })).toBeNull();
  });

  it('a getting-started checklist shows what is done and links each step to its guide', async () => {
    await open();
    const list = screen.getByRole('list', { name: 'خطوات البداية' });
    const number = within(list).getByText('اربط رقم واتساب').closest('li')!;
    expect(number.getAttribute('data-done')).toBe('true');
    const agent = within(list).getByText('شغّل المساعد الذكي (اختياري)').closest('li')!;
    expect(agent.getAttribute('data-done')).toBe('false');
    // One published shape: <help host>/<ar|en>/<slug> (docs/help/README.md); test/assets-config.test.ts checks each slug has a guide file.
    const hrefs = within(list).getAllByRole('link').map((a) => a.getAttribute('href')!);
    expect(hrefs.every((h) => /^https:\/\/help\.ebda\.app\/ar\/[a-z0-9-]+$/.test(h))).toBe(true);
  });

  it('the guide links follow the interface language', async () => {
    render(<App source={createSampleSource()} now={now} initialLang="en" />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'WhatsApp number' })));
    const list = await screen.findByRole('list', { name: 'Getting started' });
    expect(within(list).getAllByRole('link').every((a) => /^https:\/\/help\.ebda\.app\/en\/[a-z0-9-]+$/.test(a.getAttribute('href')!))).toBe(true);
  });

  it('the rail offers the screen only when the server says connecting numbers is open', async () => {
    const source = createSampleSource();
    source.capabilities = { ...source.capabilities, numbers: false };
    render(<App source={source} now={now} />);
    expect(screen.queryByRole('link', { name: 'رقم واتساب' })).toBeNull();
  });
});
