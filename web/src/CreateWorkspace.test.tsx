import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateWorkspace, NoWorkspaceYet } from './components/CreateWorkspace';
import { createWorkspace, fetchMine, isStandaloneId } from './data/workspaces';
import { CREATE_WS } from './i18n-workspace';

afterEach(cleanup);
const ar = CREATE_WS.ar;
const ID = 'sw_' + 'a'.repeat(26);
const json = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const fill = (label: string, v: string) => fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value: v } });

describe('the create-workspace screen', () => {
  it('asks for a name and the invite code while creation is invite-only, in Arabic first and RTL', () => {
    render(<CreateWorkspace needsInvite onCreate={vi.fn()} onDone={vi.fn()} />);
    expect(document.querySelector('main')?.getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('heading', { name: ar.title })).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(ar.name))).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(ar.invite))).toBeTruthy();
    expect((screen.getByLabelText(new RegExp(ar.country)) as HTMLInputElement).readOnly).toBe(true);
  });

  it('shows no invite field when creation is open', () => {
    render(<CreateWorkspace needsInvite={false} onCreate={vi.fn()} onDone={vi.fn()} />);
    expect(screen.queryByLabelText(new RegExp(ar.invite))).toBeNull();
  });

  it('names what is missing before any call, and never calls the server with an empty name', async () => {
    const onCreate = vi.fn();
    render(<CreateWorkspace needsInvite onCreate={onCreate} onDone={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: ar.submit })));
    expect((await screen.findByRole('alert')).textContent).toContain(ar.nameNeeded);
    fill(ar.name, 'مكتب النور');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: ar.submit })));
    expect((await screen.findByRole('alert')).textContent).toContain(ar.inviteNeeded);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('sends the trimmed name and code, then opens the new workspace', async () => {
    const onCreate = vi.fn(async () => ({ ok: true as const, id: ID }));
    const onDone = vi.fn();
    render(<CreateWorkspace needsInvite onCreate={onCreate} onDone={onDone} />);
    fill(ar.name, '  مكتب النور  '); fill(ar.invite, ' CODE-1 ');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: ar.submit })));
    expect(onCreate).toHaveBeenCalledWith({ name: 'مكتب النور', inviteCode: 'CODE-1' });
    expect(onDone).toHaveBeenCalledWith(ID);
  });

  it('maps every contract error to its own Egyptian sentence and lets the person try again', async () => {
    for (const error of ['standalone_off', 'invite_required', 'invite_invalid', 'rate_limited', 'failed'] as const) {
      const onCreate = vi.fn(async () => ({ ok: false as const, error }));
      render(<CreateWorkspace needsInvite onCreate={onCreate} onDone={vi.fn()} />);
      fill(ar.name, 'س'); fill(ar.invite, 'x');
      await act(async () => fireEvent.click(screen.getByRole('button', { name: ar.submit })));
      expect((await screen.findByRole('alert')).textContent).toBe(ar.errors[error]);
      expect((screen.getByRole('button', { name: ar.submit }) as HTMLButtonElement).disabled).toBe(false);
      cleanup();
    }
  });

  it('switches to English (LTR) with the English copy', () => {
    render(<CreateWorkspace needsInvite={false} onCreate={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(document.querySelector('main')?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('heading', { name: CREATE_WS.en.title })).toBeTruthy();
  });

  it('the closed state offers sign out and a retry on failure', () => {
    const onRetry = vi.fn(); const onSignOut = vi.fn();
    render(<NoWorkspaceYet failed onRetry={onRetry} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: ar.retry }));
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(onRetry).toHaveBeenCalled(); expect(onSignOut).toHaveBeenCalled();
  });

  it('no visible string on either screen says store / متجر', () => {
    const { container } = render(<CreateWorkspace needsInvite onCreate={vi.fn()} onDone={vi.fn()} />);
    expect(container.textContent).not.toMatch(/store|متجر/i);
    expect(JSON.stringify(CREATE_WS)).not.toMatch(/متجر|store/i);
  });
});

describe('the workspace API client', () => {
  it('ids: only sw_ + 26 base32 is a standalone id (a Store UUID never is)', () => {
    expect(isStandaloneId(ID)).toBe(true);
    expect(isStandaloneId('3f2b8c1e-0000-4000-8000-000000000000')).toBe(false);
    expect(isStandaloneId('sw_short')).toBe(false);
    expect(isStandaloneId(null)).toBe(false);
  });
  it('mine: parses the contract; a non-200 throws', async () => {
    const body = { items: [{ id: ID, name: 'A', role: 'owner', kind: 'standalone' }], canCreate: false, needsInvite: false };
    expect(await fetchMine('https://x', async () => 't', json(200, body))).toEqual(body);
    await expect(fetchMine('https://x', async () => 't', json(500, {}))).rejects.toThrow();
  });
  it('create: 201 and 409 (already owns one) both open the workspace; 403 messages and 429 map to codes; anything else is failed', async () => {
    const t = async () => 't';
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(201, { id: ID, name: 'A' }))).toEqual({ ok: true, id: ID });
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(409, { error: 'already_owns_workspace', id: ID }))).toEqual({ ok: true, id: ID });
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(403, { error: 'forbidden', message: 'invite_invalid' }))).toEqual({ ok: false, error: 'invite_invalid' });
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(403, { error: 'forbidden', message: 'standalone_off' }))).toEqual({ ok: false, error: 'standalone_off' });
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(429, {}))).toEqual({ ok: false, error: 'rate_limited' });
    expect(await createWorkspace('https://x', t, { name: 'A' }, json(500, {}))).toEqual({ ok: false, error: 'failed' });
    expect(await createWorkspace('https://x', t, { name: 'A' }, vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch)).toEqual({ ok: false, error: 'failed' });
  });
  it('create: sends country EG and the code only when given, with the bearer token', async () => {
    const f = json(201, { id: ID, name: 'A' });
    await createWorkspace('https://x', async () => 'tok', { name: 'A', inviteCode: 'C' }, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/api/v1/workspaces');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'A', country: 'EG', inviteCode: 'C' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
});

import { Invitations } from './components/CreateWorkspace';
import { acceptInvitation, fetchInvitations } from './data/workspaces';

describe('the invitations screen', () => {
  const items = [{ workspaceId: ID, workspaceName: 'مكتب النور', expiresAt: '2026-12-01T10:00:00.000Z' }, { workspaceId: 'sw_' + 'b'.repeat(26), workspaceName: 'مكتب الفجر', expiresAt: '2026-12-02T10:00:00.000Z' }];
  const accept = ar.invAccept;

  it('lists each invitation with its workspace name and expiry, Arabic RTL first, with no store wording', () => {
    const { container } = render(<Invitations items={items} onAccept={vi.fn()} onAccepted={vi.fn()} />);
    expect(document.querySelector('main')?.getAttribute('dir')).toBe('rtl');
    expect(screen.getByText('مكتب النور')).toBeTruthy(); expect(screen.getByText('مكتب الفجر')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: accept })).toHaveLength(2);
    expect(container.textContent).toContain(ar.invExpires);
    expect(JSON.stringify([CREATE_WS.ar.invErrors, CREATE_WS.en.invErrors, CREATE_WS.ar.invTitle, CREATE_WS.en.invTitle])).not.toMatch(/متجر|store/i);
  });

  it('accepting calls the API for that workspace, then reloads the picker', async () => {
    const onAccept = vi.fn(async () => ({ ok: true as const, workspaceId: ID })); const onAccepted = vi.fn();
    render(<Invitations items={items} onAccept={onAccept} onAccepted={onAccepted} />);
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: accept })[0]!));
    expect(onAccept).toHaveBeenCalledWith(ID); expect(onAccepted).toHaveBeenCalled();
  });

  it('404 says it expired and drops the card; 409 says no seat and keeps it', async () => {
    const onAccept = vi.fn(async (id: string) => ({ ok: false as const, error: id === ID ? 'not_found' as const : 'seat_limit' as const }));
    render(<Invitations items={items} onAccept={onAccept} onAccepted={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: accept })[0]!));
    expect((await screen.findByRole('alert')).textContent).toBe(ar.invErrors.not_found);
    expect(screen.queryByText('مكتب النور')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: accept })));
    expect((await screen.findByRole('alert')).textContent).toBe(ar.invErrors.seat_limit);
    expect(screen.getByText('مكتب الفجر')).toBeTruthy();
  });

  it('offers creating a workspace only when the caller passes that option', () => {
    const { rerender } = render(<Invitations items={items} onAccept={vi.fn()} onAccepted={vi.fn()} />);
    expect(screen.queryByRole('button', { name: ar.invCreateInstead })).toBeNull();
    rerender(<Invitations items={items} onAccept={vi.fn()} onAccepted={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole('button', { name: ar.invCreateInstead })).toBeTruthy();
  });

  it('API client: lists, accepts, and maps 404 / 409 / other', async () => {
    const t = async () => 't';
    expect(await fetchInvitations('https://x', t, json(200, { items }))).toEqual(items);
    await expect(fetchInvitations('https://x', t, json(503, {}))).rejects.toThrow();
    const f = json(200, { workspaceId: ID, status: 'accepted' });
    expect(await acceptInvitation('https://x', t, ID, f)).toEqual({ ok: true, workspaceId: ID });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(`https://x/api/v1/workspaces/invitations/${ID}/accept`);
    expect(await acceptInvitation('https://x', t, ID, json(404, {}))).toEqual({ ok: false, error: 'not_found' });
    expect(await acceptInvitation('https://x', t, ID, json(409, { error: 'seat_limit' }))).toEqual({ ok: false, error: 'seat_limit' });
    expect(await acceptInvitation('https://x', t, ID, json(503, {}))).toEqual({ ok: false, error: 'failed' });
  });
});
