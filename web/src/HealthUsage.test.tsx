import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { healthOf, usageOf } from './lib/connectionStatus';
import type { NumberDto, WalletDto } from '../../src/core/api/contract';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const num = (o: Partial<NumberDto>): NumberDto => ({ phoneNumberId: 'p', wabaId: 'w', displayPhone: '+20', verifiedName: 'x', kind: 'own', onboarding: 'cloud_api', status: 'active', registration: 'registered', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', throughputLevel: null, nameStatus: null, platformType: null, isOnBizApp: null, historySync: null, contactsSync: null, connectedAt: null, syncDeadlineAt: null, lastStatusSyncAt: null, ...o });
const shared = { available: true, member: false, displayName: null, displayPhone: null };

describe('healthOf', () => {
  it('no numbers and no shared membership is a prompt, not a fault; a shared member is fine', () => {
    expect(healthOf([], null).kind).toBe('none');
    expect(healthOf([], { ...shared, member: true }).kind).toBe('ok');
  });
  it('the worst active number decides, and the tier limit comes through', () => {
    expect(healthOf([num({})], null)).toMatchObject({ kind: 'ok', tier: 1000 });
    expect(healthOf([num({}), num({ health: 'yellow' })], null).kind).toBe('warn');
    expect(healthOf([num({ qualityRating: 'RED' })], null).kind).toBe('warn');
    expect(healthOf([num({ health: 'restricted' }), num({})], null).kind).toBe('bad');
    expect(healthOf([num({ status: 'disconnected' })], null).kind).toBe('down');
  });
});

describe('usageOf', () => {
  const w = (credits: Partial<WalletDto['aiCredits']>, over: Partial<WalletDto> = {}) => ({ lowBalance: false, debtMinor: 0, aiCredits: { balance: 0, available: 100, low: false, lowThreshold: 5, allowance: 100, ...credits }, ...over }) as WalletDto;
  it('warns before the limit and flags an empty meter', () => {
    expect(usageOf(w({ available: 90 })).level).toBe('ok');
    expect(usageOf(w({ available: 15 }))).toMatchObject({ level: 'warn', usedPct: 85 });
    expect(usageOf(w({ available: 0, low: true })).level).toBe('bad');
    expect(usageOf(w({}, { lowBalance: true })).level).toBe('warn');
    expect(usageOf(w({ available: 480 })).usedPct).toBe(0); // bought credits above the allowance never read as negative use
  });
});

describe('shell badges', () => {
  it('shows the number health and plan meter in the rail, linking to where to fix them', async () => {
    render(<App source={createSampleSource()} now={now} />);
    const group = await screen.findByRole('group', { name: 'حالة الحساب' });
    const health = within(group).getByRole('link', { name: /حالة رقم واتساب/ });
    expect(health.getAttribute('href')).toBe('/numbers');
    expect(within(group).getByRole('link', { name: /استهلاك الباقة/ }).getAttribute('href')).toBe('/wallet');
    await act(async () => fireEvent.click(health));
    await screen.findByRole('heading', { name: 'رقم واتساب' });
  });

  it('puts the unread total on the Inbox rail item without changing its name', async () => {
    render(<App source={createSampleSource()} now={now} />);
    const inbox = await screen.findByRole('link', { name: 'المحادثات' });
    await screen.findByText(/رسالة جديدة/, { selector: '.vh' });
    expect(inbox.querySelector('.rail-badge')).toBeTruthy();
  });

  it('asks to connect a number when none is connected, and hides the plan meter', async () => {
    const source = createSampleSource();
    source.numbers!.list = async () => [];
    render(<App source={source} now={now} />);
    const strip = await screen.findByText('اربط الرقم');
    expect(strip.getAttribute('href')).toBe('/numbers');
    expect(screen.queryByRole('link', { name: /استهلاك الباقة/ })).toBeNull();
  });

  it('says nothing when the numbers cannot be read (unknown is never healthy)', async () => {
    const source = createSampleSource();
    source.numbers!.list = async () => { throw new Error('x'); };
    render(<App source={source} now={now} />);
    await screen.findByRole('group', { name: 'حالة الحساب' });
    expect(screen.queryByRole('link', { name: /حالة رقم واتساب/ })).toBeNull();
    expect(document.querySelector('[data-banner="number"]')).toBeNull();
  });
});
