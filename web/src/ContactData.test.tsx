import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactsScreen } from './components/ContactsScreen';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { ContactsApi } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

function open(role: 'owner' | 'staff' = 'owner', patch: Partial<ContactsApi> = {}) {
  const base = createSampleSource().contacts!;
  const api: ContactsApi = { ...base, ...patch };
  const source = { ...createSampleSource(), contacts: api, role };
  render(<ContactsScreen t={t} lang="ar" source={source} api={api} now={now} />);
  return api;
}
const pick = async (name: string) => { const li = (await screen.findByText(name)).closest('li')!; await act(async () => fireEvent.click(li)); return screen.findByRole('region', { name: t.cdTitle }); };

describe('customer data tools', () => {
  it('asks to pick a customer first', async () => {
    open();
    expect((await screen.findByRole('region', { name: t.cdTitle })).textContent).toContain(t.cdSelect);
  });

  it('renames a contact (owner or staff); an empty name is not sent', async () => {
    const api = open('staff');
    const rename = vi.spyOn(api, 'renameContact');
    const card = await pick('نورا حسن');
    const save = within(card).getByRole('button', { name: t.cdSave }) as HTMLButtonElement;
    fireEvent.change(within(card).getByLabelText(t.cdName), { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.cdName), { target: { value: ' نورا حسن السيد ' } });
    await act(async () => fireEvent.click(save));
    expect(rename).toHaveBeenCalledWith('201007778899', 'نورا حسن السيد');
    expect(await within(card).findByText(t.cdSaved)).toBeTruthy();
  });

  it('downloads the contact\'s data as a JSON file (owner only)', async () => {
    const staffCard = await (async () => { open('staff'); return pick('نورا حسن'); })();
    expect(within(staffCard).queryByRole('button', { name: t.cdExport })).toBeNull();
    expect(within(staffCard).queryByRole('button', { name: t.cdMergeGo })).toBeNull();
    cleanup();
    const api = open('owner', { exportContact: vi.fn().mockResolvedValue({ version: 1, messages: [] }) });
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const card = await pick('نورا حسن');
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.cdExport })));
    expect(api.exportContact).toHaveBeenCalledWith('201007778899');
    expect(create).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('merges only after the warning is read and a number is typed; says plainly when it fails', async () => {
    const merge = vi.fn().mockRejectedValueOnce(new ApiError('not_found', 404)).mockResolvedValue(undefined);
    open('owner', { mergeContacts: merge });
    const card = await pick('نورا حسن');
    expect(within(card).getByText(t.cdMergeWarn)).toBeTruthy();
    const go = within(card).getByRole('button', { name: t.cdMergeGo }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.cdMergeInto), { target: { value: '+20 100 000 0001' } });
    expect(go.disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(merge).toHaveBeenCalledWith('201007778899', '201000000001');
    expect((await within(card).findByRole('alert')).textContent).toBe(t.cdFailed);
    await act(async () => fireEvent.click(go));
    expect(await within(card).findByText(t.cdMerged)).toBeTruthy();
  });
});

describe('erase a customer (owner, data-subject request)', () => {
  it('needs the last four digits typed, calls erase once, and clears the selection', async () => {
    const erase = vi.fn().mockResolvedValue(undefined);
    open('owner', { eraseContact: erase });
    const card = await pick('نورا حسن');
    const go = within(card).getByRole('button', { name: t.cdEraseGo }) as HTMLButtonElement;
    expect(within(card).getByText(t.cdEraseWarn)).toBeTruthy();
    expect(go.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.cdEraseConfirm), { target: { value: '0000' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.cdEraseConfirm), { target: { value: '8899' } });
    expect(go.disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(erase).toHaveBeenCalledTimes(1);
    expect(erase).toHaveBeenCalledWith('201007778899');
    expect((await screen.findByRole('region', { name: t.cdTitle })).textContent).toContain(t.cdSelect);
  });

  it('says plainly when erasing fails and keeps the customer selected', async () => {
    const erase = vi.fn().mockRejectedValue(new ApiError('not_found', 404));
    open('owner', { eraseContact: erase });
    const card = await pick('نورا حسن');
    fireEvent.change(within(card).getByLabelText(t.cdEraseConfirm), { target: { value: '8899' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.cdEraseGo })));
    expect((await within(card).findByRole('alert')).textContent).toBe(t.cdFailed);
  });

  it('is hidden from staff', async () => {
    open('staff');
    const card = await pick('نورا حسن');
    expect(within(card).queryByRole('button', { name: t.cdEraseGo })).toBeNull();
  });
});

describe('message retention (owner)', () => {
  it('shows the current window, saves a new one, and is hidden from staff', async () => {
    cleanup();
    open('staff');
    expect(screen.queryByRole('region', { name: t.rtTitle })).toBeNull();
    cleanup();
    const api = open('owner');
    const set = vi.spyOn(api, 'setRetention');
    const card = await screen.findByRole('region', { name: t.rtTitle });
    const select = (await within(card).findByLabelText(t.rtTitle)) as HTMLSelectElement;
    expect(select.value).toBe('730'); // the platform default
    fireEvent.change(select, { target: { value: '90' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.rtSave })));
    expect(set).toHaveBeenCalledWith(90);
    expect(await within(card).findByText(t.rtSaved)).toBeTruthy();
  });
});
