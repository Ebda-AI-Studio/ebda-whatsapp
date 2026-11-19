import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactsScreen } from './components/ContactsScreen';
import { ConversationTools } from './components/ConversationTools';
import { QuickReplies } from './components/QuickReplies';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { ContactsApi, InboxSource, InboxToolsApi } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const click = (el: HTMLElement) => act(async () => { fireEvent.click(el); });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

function source(patch: Partial<InboxToolsApi> = {}, role: InboxSource['role'] = 'owner'): InboxSource {
  const base = createSampleSource();
  return { ...base, role, inboxTools: { ...base.inboxTools!, ...patch } };
}

describe('quick replies (A25)', () => {
  it('shows the starter replies until the merchant has their own; a chip fills the box', async () => {
    const onPick = vi.fn();
    render(<QuickReplies t={t} source={source()} onPick={onPick} />);
    const chip = await screen.findByRole('button', { name: t.quickReplyTexts[0]! });
    await click(chip);
    expect(onPick).toHaveBeenCalledWith(t.quickReplyTexts[0]);
  });

  it('creates, edits and deletes a reply; the chips follow', async () => {
    const src = source();
    render(<QuickReplies t={t} source={src} onPick={() => undefined} />);
    await click(await screen.findByRole('button', { name: t.itQuickEdit }));
    type(screen.getByLabelText(t.itQuickNew), 'شكرًا ليك!');
    await click(screen.getByRole('button', { name: t.itQuickAdd }));
    const row = (await screen.findByDisplayValue('شكرًا ليك!')).closest('li')!;
    type(within(row).getByLabelText(t.itQuickTitle), 'شكرًا جدًا!');
    await click(within(row).getByRole('button', { name: t.itQuickSave }));
    expect((await src.inboxTools!.quickReplies.list())[0]!.text).toBe('شكرًا جدًا!');
    await click(within(screen.getByDisplayValue('شكرًا جدًا!').closest('li')!).getByRole('button', { name: t.itQuickRemove }));
    expect(await src.inboxTools!.quickReplies.list()).toEqual([]);
    expect(screen.queryByDisplayValue('شكرًا جدًا!')).toBeNull();
  });

  it('shows an error when the server refuses (a duplicate or the limit of 20)', async () => {
    const src = source({ quickReplies: { ...createSampleSource().inboxTools!.quickReplies, create: vi.fn().mockRejectedValue(new ApiError('invalid_request', 409)) } });
    render(<QuickReplies t={t} source={src} onPick={() => undefined} />);
    await click(await screen.findByRole('button', { name: t.itQuickEdit }));
    type(screen.getByLabelText(t.itQuickNew), 'x');
    await click(screen.getByRole('button', { name: t.itQuickAdd }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.itQuickDuplicate);
  });
});

describe('notes and tags on a conversation (A26, A27)', () => {
  const conv = async (src: InboxSource) => (await src.listConversations('all', ''))[0]!;

  it('adds an internal note and lists it; an empty note is not sent', async () => {
    const src = source();
    const c = await conv(src);
    const add = vi.spyOn(src.inboxTools!, 'addNote');
    render(<ConversationTools t={t} source={src} conversation={c} />);
    const send = (await screen.findByRole('button', { name: t.itNoteAdd })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(screen.getByLabelText(t.itNoteLabel), '  العميل عايز فاتورة  ');
    await click(send);
    expect(add).toHaveBeenCalledWith(c.id, 'العميل عايز فاتورة');
    expect(await screen.findByText('العميل عايز فاتورة')).toBeTruthy();
  });

  it('adds and removes a tag; a system tag stays and has no remove button', async () => {
    const src = source();
    const c = { ...(await conv(src)), tags: ['needs_human'] };
    const setTags = vi.spyOn(src.inboxTools!, 'setTags');
    render(<ConversationTools t={t} source={src} conversation={c} />);
    expect(screen.queryByRole('button', { name: t.itTagRemove('needs_human') })).toBeNull();
    type(screen.getByLabelText(t.itTagLabel), 'VIP');
    await click(screen.getByRole('button', { name: t.itTagAdd }));
    expect(setTags).toHaveBeenLastCalledWith(c.id, ['needs_human', 'vip']);
    await click(await screen.findByRole('button', { name: t.itTagRemove('vip') }));
    expect(setTags).toHaveBeenLastCalledWith(c.id, ['needs_human']);
  });

  it('shows an error and keeps the old tags when the save fails', async () => {
    const src = source({ setTags: vi.fn().mockRejectedValue(new ApiError('invalid_request', 500)) });
    const c = { ...(await conv(src)), tags: [] };
    render(<ConversationTools t={t} source={src} conversation={c} />);
    type(screen.getByLabelText(t.itTagLabel), 'vip');
    await click(screen.getByRole('button', { name: t.itTagAdd }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.itFailed);
    expect(screen.queryByRole('button', { name: t.itTagRemove('vip') })).toBeNull();
  });

  it('shows an error when the notes cannot be loaded', async () => {
    const src = source({ notes: vi.fn().mockRejectedValue(new ApiError('not_found', 404)) });
    render(<ConversationTools t={t} source={src} conversation={await conv(src)} />);
    expect((await screen.findByRole('alert')).textContent).toBe(t.itFailed);
  });
});

function openContacts(role: 'owner' | 'staff' = 'owner', patch: Partial<ContactsApi> = {}) {
  const base = createSampleSource().contacts!;
  const api: ContactsApi = { ...base, ...patch };
  render(<ContactsScreen t={t} lang="ar" source={{ ...createSampleSource(), contacts: api, role }} api={api} now={now} />);
  return api;
}
const pick = async (name: string) => { const li = (await screen.findByText(name)).closest('li')!; await click(li); return screen.findByRole('region', { name: t.cdTitle }); };

describe('contact tags (A29)', () => {
  it('adds and removes a tag on a customer (owner or staff)', async () => {
    const api = openContacts('staff');
    const set = vi.spyOn(api, 'setContactTags');
    const card = await pick('نورا حسن');
    type(within(card).getByLabelText(t.itTagLabel), 'Eid');
    await click(within(card).getByRole('button', { name: t.itTagAdd }));
    expect(set).toHaveBeenLastCalledWith('201007778899', expect.arrayContaining(['eid']));
    await click(await within(card).findByRole('button', { name: t.itTagRemove('eid') }));
    expect(set.mock.calls.at(-1)![1]).not.toContain('eid');
  });

  it('shows an error when saving fails', async () => {
    openContacts('owner', { setContactTags: vi.fn().mockRejectedValue(new ApiError('not_found', 404)) });
    const card = await pick('نورا حسن');
    type(within(card).getByLabelText(t.itTagLabel), 'vip2');
    await click(within(card).getByRole('button', { name: t.itTagAdd }));
    expect((await within(card).findByRole('alert')).textContent).toBe(t.itFailed);
  });
});

describe('saved segments (A30)', () => {
  const panel = () => screen.findByRole('region', { name: t.sgTitle });

  it('is offered to the owner only', async () => {
    openContacts('staff');
    await screen.findByText('نورا حسن');
    expect(screen.queryByRole('region', { name: t.sgTitle })).toBeNull();
  });

  it('creates a segment, edits it, previews it', async () => {
    const api = openContacts();
    const create = vi.spyOn(api.segments, 'create');
    const p = await panel();
    await within(p).findByText('عملاء VIP');
    expect((within(p).getByRole('button', { name: t.sgCreate }) as HTMLButtonElement).disabled).toBe(true); // no name, no rule
    type(within(p).getByLabelText(t.sgName), 'عملاء العيد');
    type(within(p).getByLabelText(t.sgTagsAny), 'eid, Gift');
    await click(within(p).getByRole('button', { name: t.sgCreate }));
    expect(create).toHaveBeenCalledWith('عملاء العيد', { tags: { any: ['eid', 'gift'] } });
    const row = (await within(p).findByText('عملاء العيد')).closest('li')!;
    await click(within(row).getByRole('button', { name: t.sgEdit }));
    type(within(p).getByLabelText(t.sgName), 'عملاء العيد 2');
    const update = vi.spyOn(api.segments, 'update');
    await click(within(p).getByRole('button', { name: t.sgSave }));
    expect(update).toHaveBeenCalledWith(expect.any(Number), { name: 'عملاء العيد 2', criteria: { tags: { any: ['eid', 'gift'] } } });
    expect(await within(p).findByText('عملاء العيد 2')).toBeTruthy();
    type(within(p).getByLabelText(t.sgTagsAny), 'vip');
    await click(within(p).getByRole('button', { name: t.sgPreview }));
    expect(await within(p).findByText(/عميل هيوصلهم الرسايل/)).toBeTruthy();
  });

  it('delete needs the typed name first, then removes', async () => {
    const api = openContacts();
    const remove = vi.spyOn(api.segments, 'remove');
    const p = await panel();
    const row = (await within(p).findByText('عملاء VIP')).closest('li')!;
    await click(within(row).getByRole('button', { name: t.sgDelete }));
    const go = within(p).getByRole('button', { name: t.sgDeleteGo }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await click(go);
    expect(remove).not.toHaveBeenCalled();
    type(within(p).getByLabelText(t.sgDeleteConfirm), 'اسم تاني');
    expect(go.disabled).toBe(true);
    type(within(p).getByLabelText(t.sgDeleteConfirm), 'عملاء VIP');
    await click(go);
    expect(remove).toHaveBeenCalledWith(1);
    expect(within(p).queryByText('عملاء VIP')).toBeNull();
  });

  it('shows an error when the server refuses (a taken name)', async () => {
    const base = createSampleSource().contacts!;
    openContacts('owner', { segments: { ...base.segments, create: vi.fn().mockRejectedValue(new ApiError('invalid_request', 409, 'name_taken')) } });
    const p = await panel();
    type(await within(p).findByLabelText(t.sgName), 'عملاء VIP');
    type(within(p).getByLabelText(t.sgTagsAny), 'vip');
    await click(within(p).getByRole('button', { name: t.sgCreate }));
    expect((await within(p).findByRole('alert')).textContent).toBe(t.sgNameTaken);
  });

  it('shows an error when the list cannot load', async () => {
    const base = createSampleSource().contacts!;
    openContacts('owner', { segments: { ...base.segments, list: vi.fn().mockRejectedValue(new ApiError('not_found', 404)) } });
    expect(await within(await panel()).findByRole('alert')).toBeTruthy();
  });
});
