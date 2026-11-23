import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '@brand';
import { App } from './App';
import { isOperator } from './data/api';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

describe('a super admin lands on the operator console', () => {
  it('with no store at all: the console renders, with the operator rail item and no inbox', async () => {
    const source = createSampleSource();
    source.role = 'super_admin'; source.operatorOnly = true;
    const list = vi.fn(() => Promise.reject(new Error('no store')));
    source.listConversations = list as never;
    render(<App source={source} now={now} />);
    expect(await screen.findByRole('heading', { name: t.opTitle, level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: t.opNav })).toBeTruthy();
    expect(screen.queryByRole('link', { name: t.inbox })).toBeTruthy(); // the rail's fixed first item
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByLabelText(t.viewAsWorkspace)).toBeTruthy(); // the way into one store, read-only with a reason
  });

  it('on a store with no workspace: the console is the FIRST screen, and the store page is one rail click away', async () => {
    const source = createSampleSource();
    source.role = 'super_admin'; source.workspaceMissing = true; source.storeId = 'store-x';
    render(<App source={source} now={now} />);
    expect(await screen.findByRole('heading', { name: t.opTitle, level: 1 })).toBeTruthy();
    expect(screen.queryByText(t.noWsTitle(BRAND.productNameAr ?? BRAND.productName))).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.inbox })));
    expect(await screen.findByText(t.noWsTitle(BRAND.productNameAr ?? BRAND.productName))).toBeTruthy();
  });

  it('on a store whose Chat IS enabled: unchanged, the inbox first, the operator rail item present', () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    expect(screen.queryByRole('heading', { name: t.opTitle, level: 1 })).toBeNull();
    expect(screen.getByRole('link', { name: t.opNav })).toBeTruthy();
  });

  it('a normal owner on a no-workspace store: unchanged, no operator item', () => {
    const source = createSampleSource();
    source.role = 'owner'; source.workspaceMissing = true; source.storeId = 'store-x';
    render(<App source={source} now={now} />);
    expect(screen.queryByRole('link', { name: t.opNav })).toBeNull();
    expect(screen.getByRole('status', { name: /./ })).toBeTruthy();
  });
});

describe('isOperator (store-independent check)', () => {
  const f = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('true only for 200 { superAdmin: true }', async () => {
    expect(await isOperator('https://x', async () => 'tok', f(200, { superAdmin: true }))).toBe(true);
    expect(await isOperator('https://x', async () => 'tok', f(403, { error: 'forbidden' }))).toBe(false);
    expect(await isOperator('https://x', async () => 'tok', f(200, {}))).toBe(false);
    expect(await isOperator('https://x', async () => { throw new Error('x'); }, f(200, { superAdmin: true }))).toBe(false);
  });
});
