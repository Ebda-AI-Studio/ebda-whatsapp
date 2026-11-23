import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleAssistantRollout } from './data/assistant-rollout';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const NOW = Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const a = t.opAssistant;

async function open(source: InboxSource = createSampleSource()) {
  source.role = 'super_admin';
  render(<App source={source} now={() => NOW} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
  await screen.findByRole('heading', { name: t.opTitle, level: 1 });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.assistant! })));
  await screen.findByRole('heading', { name: a.platformTitle });
  return source;
}
const click = (name: string | RegExp) => act(async () => fireEvent.click(screen.getByRole('button', { name })));

describe('operator: assistant rollout switches', () => {
  it('the tab is absent when the build has no rollout api, and shown for a super admin', async () => {
    const source = createSampleSource();
    delete source.assistantRollout;
    source.role = 'super_admin';
    render(<App source={source} now={() => NOW} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await screen.findByRole('heading', { name: t.opTitle, level: 1 });
    expect(screen.queryByRole('button', { name: t.opTabs.assistant! })).toBeNull();
  });

  it('shows the current cap and switches, and a change needs the inline confirm before anything is sent', async () => {
    const source = await open();
    const api = source.assistantRollout!;
    const set = vi.spyOn(api, 'setPlatform');
    expect(screen.getByText(`${a.cap}: ${a.modes['answer-only']}`)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(a.killGlobal));
    await click(a.save);
    expect(set).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: new RegExp(a.confirmPlatform('').slice(0, 12)) });
    expect(group.textContent).toContain(`${a.killGlobal}: ${a.on}`);
    await click(a.no);
    expect(set).not.toHaveBeenCalled();
    await click(a.save);
    await click(a.yes);
    // The whole global value goes (the server replaces it), and the screen then shows what the server answered.
    expect(set).toHaveBeenCalledWith({ global: { kill: true, mode: 'answer-only', shadow: false } });
    expect(await api.platform()).toMatchObject({ global: { kill: true } });
    expect(screen.getByRole('status').textContent).toContain(a.saved);
  });

  it('changes the cap and the killed tools; a bad tool name is refused before the confirm', async () => {
    const source = await open();
    const set = vi.spyOn(source.assistantRollout!, 'setPlatform');
    fireEvent.change(screen.getByLabelText(a.killedTools), { target: { value: 'x'.repeat(65) } });
    await click(a.save);
    expect(screen.getByRole('alert').textContent).toContain(a.killedToolsBad);
    fireEvent.change(screen.getByLabelText(a.killedTools), { target: { value: 'wallet_view, wallet_view, send_template' } });
    fireEvent.change(screen.getByLabelText(a.cap), { target: { value: 'suggest' } });
    await click(a.save);
    await click(a.yes);
    expect(set).toHaveBeenCalledWith({ global: { kill: false, mode: 'suggest', shadow: false }, killedTools: ['wallet_view', 'send_template'] });
  });

  it('saving with no change says so and sends nothing', async () => {
    const source = await open();
    const set = vi.spyOn(source.assistantRollout!, 'setPlatform');
    await click(a.save);
    expect(screen.getByRole('alert').textContent).toContain(a.nothingToSave);
    expect(set).not.toHaveBeenCalled();
  });

  it('a failed read is a calm error, never "all off"', async () => {
    const source = createSampleSource();
    source.assistantRollout = { ...createSampleAssistantRollout(), platform: async () => { throw new ApiError('x', 500); } };
    source.role = 'super_admin';
    render(<App source={source} now={() => NOW} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.assistant! })));
    expect((await screen.findByRole('alert')).textContent).toContain(a.loadFailed);
    expect(screen.queryByText(a.save)).toBeNull();
  });

  it('a workspace mode: load, change behind a confirm, and an unknown workspace says not found', async () => {
    const source = await open();
    const api = source.assistantRollout!;
    const setMode = vi.spyOn(api, 'setWorkspaceMode');
    fireEvent.change(screen.getByLabelText(a.wsId), { target: { value: 'ws-1' } });
    await click(a.wsLoad);
    expect(await screen.findByText(a.wsCurrent('ws-1', a.modes.off!))).toBeTruthy();
    await click(a.wsSet); // same mode
    expect(screen.getByRole('alert').textContent).toContain(a.wsSame);
    fireEvent.change(within(screen.getByRole('region', { name: a.wsTitle })).getByLabelText(a.wsMode), { target: { value: 'act' } });
    await click(a.wsSet);
    expect(setMode).not.toHaveBeenCalled();
    await click(a.yes);
    expect(setMode).toHaveBeenCalledWith('ws-1', 'act');
    expect(await screen.findByText(a.wsCurrent('ws-1', a.modes.act!))).toBeTruthy();

    vi.spyOn(api, 'workspaceMode').mockRejectedValueOnce(new ApiError('not_found', 404));
    fireEvent.change(screen.getByLabelText(a.wsId), { target: { value: 'nope' } });
    await click(a.wsLoad);
    expect(screen.getByRole('alert').textContent).toContain(a.wsNotFound);
  });
});
