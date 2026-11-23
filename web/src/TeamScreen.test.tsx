import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { NoSeat } from './components/NoSeat';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

async function openTeam(role: InboxSource['role'] = 'owner', tweak?: (s: InboxSource) => void) {
  const source = createSampleSource();
  source.role = role;
  tweak?.(source);
  render(<App source={source} now={now} />);
  return { source, open: async () => { await act(async () => fireEvent.click(screen.getByRole('link', { name: t.teamNav }))); } };
}

describe('team and seats (WA-SEATS-1)', () => {
  it('shows the owner the team, each seat and the usage', async () => {
    const { open } = await openTeam();
    await open();
    expect(await screen.findByRole('heading', { name: t.teamTitle, level: 1 })).toBeTruthy();
    expect(screen.getByText(t.teamUsage('2', '3'))).toBeTruthy();
    expect(screen.getByTestId('seat-u-me').textContent).toBe(t.teamSeats.owner);
    expect(screen.getByTestId('seat-u-1').textContent).toBe(t.teamSeats.seated);
    expect(screen.getByTestId('seat-u-2').textContent).toBe(t.teamSeats.none);
    expect(screen.queryByRole('button', { name: /ليلى/ })).toBeNull(); // the owner has no seat button
  });

  it('gives a seat and removes it, refreshing from the server each time', async () => {
    const { open } = await openTeam();
    await open();
    await screen.findByRole('heading', { name: t.teamTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamAssignFor('دينا') })));
    expect((await screen.findByTestId('seat-u-2')).textContent).toBe(t.teamSeats.seated);
    expect(screen.getByText(t.teamUsage('3', '3'))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamUnassignFor('مصطفى') })));
    expect((await screen.findByTestId('seat-u-1')).textContent).toBe(t.teamSeats.none);
  });

  it('when the package has no seat left, says so with the limit and keeps the person unseated', async () => {
    const { open } = await openTeam();
    await open();
    await screen.findByRole('heading', { name: t.teamTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamAssignFor('دينا') })));
    await screen.findByText(t.teamUsage('3', '3'));
    // announced: the polite status region is already in the page BEFORE the click, and the card is inserted into it
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamAssignFor('كريم') })));
    const card = await screen.findByLabelText(t.upgradeTeamTitle);
    expect(region.contains(card)).toBe(true);
    expect(region.textContent).toContain(t.teamSeatLimit('3'));
    expect(card.textContent).toContain(t.teamSeatLimit('3'));
    expect(card.querySelector('[role=alert]')).toBeNull();
    expect(screen.getByTestId('seat-u-3').textContent).toBe(t.teamSeats.none);
  });

  it('a team that cannot be read is a retry, not an empty team', async () => {
    const { open } = await openTeam('owner', (s) => { s.team!.list = vi.fn().mockRejectedValueOnce(new ApiError('unavailable', 503)); });
    await open();
    expect(await screen.findByRole('button', { name: t.retry })).toBeTruthy();
  });

  it('shows the over-limit banner after a downgrade', async () => {
    const { open } = await openTeam('owner', (s) => {
      const real = s.team!.list.bind(s.team);
      s.team!.list = async () => ({ ...(await real()), seats: { limit: 2, used: 3, overLimit: true } });
    });
    await open();
    const card = await screen.findByLabelText(t.upgradeTeamTitle);
    expect(card.closest('[role=status]')?.getAttribute('aria-live')).toBe('polite');
    expect(card.textContent).toContain(t.teamOverLimit);
  });

  it('is not offered to staff (no rail link) and a 403 from the server reads as owner only', async () => {
    await openTeam('staff');
    expect(screen.queryByRole('link', { name: t.teamNav })).toBeNull();
    cleanup();
    const { open } = await openTeam('owner', (s) => { s.team!.list = vi.fn().mockRejectedValue(new ApiError('forbidden', 403)); });
    await open();
    expect(await screen.findByText(t.ownerOnly)).toBeTruthy();
  });

  it('English copy exists for every team string, with western digits', () => {
    expect(STRINGS.en.teamUsage('2', '3')).toBe('2 of 3 seats');
    for (const k of Object.keys(STRINGS.ar) as (keyof typeof t)[]) if (String(k).startsWith('team') || String(k).startsWith('noSeat')) expect(STRINGS.en[k], String(k)).toBeTruthy();
  });
});

describe('no seat page', () => {
  it('says why in both languages and retries only on the button', () => {
    const retry = vi.fn();
    render(<NoSeat reason="none" onRetry={retry} />);
    const box = screen.getByRole('alert');
    expect(within(box).getByText(STRINGS.ar.noSeatBody)).toBeTruthy();
    expect(within(box).getByText(STRINGS.en.noSeatBody)).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    render(<NoSeat reason="over_limit" onRetry={retry} />);
    expect(screen.getByText(STRINGS.ar.noSeatOver)).toBeTruthy();
  });
});

// CHAT-SA-4: a standalone workspace manages its team in Chat (the server says so with `canInvite`); a Store workspace shows no invite form.
describe('standalone team (invite and remove in Chat)', () => {
  const standaloneTeam = (over: Partial<NonNullable<InboxSource['team']>> = {}) => {
    const items = [{ userId: 'u-me', displayName: 'ليلى', role: 'owner' as const, addedAt: '2026-09-01T00:00:00.000Z', seat: 'owner' as const }];
    const team = {
      list: vi.fn(async () => ({ items: [...items], seats: { limit: 3, used: items.length, overLimit: false }, canInvite: true })),
      assign: vi.fn(async () => {}),
      unassign: vi.fn(async () => {}),
      invite: vi.fn(async () => { items.push({ userId: 'u-9', displayName: 'سارة', role: 'staff' as never, addedAt: '2026-09-02T00:00:00.000Z', seat: 'seated' as never }); }),
      remove: vi.fn(async () => { items.pop(); }),
      ...over,
    };
    return team;
  };

  it('shows the invite form, sends an invite, shows the same confirmation and the new member, then removes them', async () => {
    const team = standaloneTeam();
    const { open } = await openTeam('owner', (s) => { s.team = team; });
    await open();
    await screen.findByRole('heading', { name: t.teamInviteTitle });
    fireEvent.change(screen.getByLabelText(t.teamInviteName), { target: { value: 'سارة' } });
    fireEvent.change(screen.getByLabelText(t.teamInviteEmail), { target: { value: 'sara@example.com' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamInviteSend })));
    expect(team.invite).toHaveBeenCalledWith({ email: 'sara@example.com', firstName: 'سارة', language: 'ar' });
    expect(await screen.findByText(t.teamInviteSent)).toBeTruthy();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.teamRemoveFor('سارة') })));
    expect(team.remove).toHaveBeenCalledWith('u-9');
    expect(screen.queryByRole('button', { name: t.teamRemoveFor('سارة') })).toBeNull();
  });

  it('a full package shows the upgrade card, not a failure', async () => {
    const team = standaloneTeam({ invite: vi.fn(async () => { throw new ApiError('seat_limit', 409); }) });
    const { open } = await openTeam('owner', (s) => { s.team = team; });
    await open();
    await screen.findByRole('heading', { name: t.teamInviteTitle });
    fireEvent.change(screen.getByLabelText(t.teamInviteName), { target: { value: 'سارة' } });
    fireEvent.change(screen.getByLabelText(t.teamInviteEmail), { target: { value: 'sara@example.com' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.teamInviteSend })));
    expect(await screen.findByText(t.upgradeTeamTitle)).toBeTruthy();
    expect(screen.queryByText(t.teamFailed)).toBeNull();
  });

  it('a Store workspace (no canInvite) shows no invite form and no remove button', async () => {
    const { open } = await openTeam();
    await open();
    await screen.findByRole('heading', { name: t.teamTitle });
    expect(screen.queryByRole('heading', { name: t.teamInviteTitle })).toBeNull();
    expect(screen.queryByRole('button', { name: t.teamRemoveFor('مصطفى') })).toBeNull();
  });
});
