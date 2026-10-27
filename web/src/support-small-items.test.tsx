import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createApiSource } from './data/api';
import { createSampleSource } from './data/sample';
import { viewAsStore } from './boot';
import { STRINGS } from './i18n';

afterEach(cleanup);
describe('T35: view as merchant, in the web app', () => {
  it('?viewAs=1&store=<id> names the workspace to look at; anything else is the normal app', () => {
    expect(viewAsStore('?viewAs=1&store=ws-1')).toBe('ws-1');
    expect(viewAsStore('?store=ws-1')).toBeNull();
    expect(viewAsStore('?viewAs=1')).toBeNull();
    expect(viewAsStore('?viewAs=0&store=ws-1')).toBeNull();
    expect(viewAsStore('?viewAs=1&store=' + encodeURIComponent('../x'))).toBeNull(); // only plain ids
  });
  it('a viewing source sends the view-as headers with the reason on every call', async () => {
    const seen: Headers[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const api = createApiSource({ baseUrl: 'https://x', storeId: 'ws-1', getToken: async () => 't', fetchImpl, userNames: {}, currentUserId: 'op', viewAs: { reason: 'merchant asked about paused campaigns' } });
    await api.listConversations('all', '').catch(() => undefined);
    expect(seen[0]!.get('x-view-as-merchant')).toBe('1');
    expect(seen[0]!.get('x-view-as-reason')).toBe('merchant asked about paused campaigns');
  });
  it('a normal source sends neither header', async () => {
    const seen: Headers[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const api = createApiSource({ baseUrl: 'https://x', storeId: 'ws-1', getToken: async () => 't', fetchImpl, userNames: {}, currentUserId: 'op' });
    await api.listConversations('all', '').catch(() => undefined);
    expect(seen[0]!.has('x-view-as-merchant')).toBe(false);
  });
  it('the app says it is a read-only view, always visible', async () => {
    const source = createSampleSource();
    source.viewAs = true;
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    expect((await screen.findByRole('status', { name: STRINGS.ar.viewAsBanner })).textContent).toContain(STRINGS.ar.viewAsBanner);
    void act; void fireEvent;
  });
  it('the operator console has a way in: a workspace id and a link that opens the read-only view', async () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    await act(async () => fireEvent.click(await screen.findByRole('link', { name: STRINGS.ar.opNav })));
    const input = await screen.findByLabelText(STRINGS.ar.viewAsWorkspace);
    fireEvent.change(input, { target: { value: 'ws-demo-1' } });
    const link = screen.getByRole('link', { name: STRINGS.ar.viewAsOpen }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/?store=ws-demo-1&viewAs=1');
  });
});
