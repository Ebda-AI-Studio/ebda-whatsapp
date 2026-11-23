import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createApiSource } from './data/api';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

// CHAT-QA-3 / CHAT-QA-12: a failed fetch of the agent settings was read as "only the store owner", shown to the real owner.
afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const STORE = '11111111-1111-4111-8111-111111111111';
const api = (status: number) => createApiSource({
  baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', userNames: {}, currentUserId: 'u',
  fetchImpl: (async () => new Response(JSON.stringify({ error: status === 403 ? 'forbidden' : 'not_found' }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
});

describe('agent settings load', () => {
  it('a 403 means not yours (null); a 404 or a 500 is a failed load that throws', async () => {
    expect(await api(403).agentSettings!()).toBeNull();
    await expect(api(404).agentSettings!()).rejects.toMatchObject({ status: 404 });
    await expect(api(500).agentSettings!()).rejects.toMatchObject({ status: 500 });
  });

  const open = async (source: ReturnType<typeof createSampleSource>) => {
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المساعد الذكي' })));
  };

  it('the owner whose load failed sees a retryable error, never "owner only"', async () => {
    const source = createSampleSource();
    source.agentSettings = vi.fn().mockRejectedValue(new Error('404'));
    await open(source);
    expect(await screen.findByRole('button', { name: STRINGS.ar.retry })).toBeTruthy();
    expect(screen.queryByText(STRINGS.ar.ownerOnly)).toBeNull();
  });

  it('the owner is never told "owner only", even if the server answered a refusal', async () => {
    const source = createSampleSource();
    source.agentSettings = vi.fn().mockResolvedValue(null);
    await open(source);
    expect(await screen.findByRole('button', { name: STRINGS.ar.retry })).toBeTruthy();
    expect(screen.queryByText(STRINGS.ar.ownerOnly)).toBeNull();
  });

  it('staff are told it is the owner\'s', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    source.agentSettings = vi.fn().mockResolvedValue(null);
    await open(source);
    expect(await screen.findByText(STRINGS.ar.ownerOnly)).toBeTruthy();
  });
});
