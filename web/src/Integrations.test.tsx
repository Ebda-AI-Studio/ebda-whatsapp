import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const SECRET = 'whsec-0123456789abcdef-never-shown';
const tools = JSON.stringify([{ name: 'check_booking', description: 'Look up a booking.', params: [{ name: 'reference', type: 'string', required: true }] }]);

const openBot = async (source = createSampleSource()) => {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.botNav })));
  await screen.findByRole('heading', { name: t.catTitle });
  return source;
};
const openIntegrations = async (source = createSampleSource()) => {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.intNav })));
  await screen.findByRole('heading', { name: t.intTitle });
  return source;
};
const type = (label: string, value: string) => act(async () => fireEvent.change(screen.getByLabelText(label), { target: { value } }));
const click = (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })));

describe('link an existing Meta catalogue (A34)', () => {
  it('links the typed id once, then shows it as the workspace catalogue', async () => {
    const source = createSampleSource();
    const link = vi.spyOn(source.catalog!, 'linkExisting');
    await openBot(source);
    await type(t.catLinkLabel, '5550001111');
    await click(t.catLinkBtn);
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith('5550001111');
    expect(screen.getByText(/رقم الكتالوج/).textContent).toContain('5550001111');
    expect(screen.queryByLabelText(t.catLinkLabel)).toBeNull();
  });

  it('refuses an id that is not 5 to 25 digits before any request', async () => {
    const source = createSampleSource();
    const link = vi.spyOn(source.catalog!, 'linkExisting');
    await openBot(source);
    await type(t.catLinkLabel, '12ab');
    expect((screen.getByRole('button', { name: t.catLinkBtn }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.catLinkBad)).toBeTruthy();
    expect(link).not.toHaveBeenCalled();
  });

  it('a catalogue that is not on this WhatsApp account is explained and can be retried', async () => {
    const source = createSampleSource();
    source.catalog!.linkExisting = vi.fn().mockRejectedValue(new ApiError('invalid_request', 400, 'catalog_not_linked'));
    await openBot(source);
    await type(t.catLinkLabel, '5550001111');
    await click(t.catLinkBtn);
    expect(screen.getByRole('alert').textContent).toContain(t.catLinkNotYours);
    expect((screen.getByRole('button', { name: t.catLinkBtn }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('staff see no link form', async () => {
    const source = createSampleSource();
    source.role = 'staff';
    await openBot(source);
    expect(screen.queryByLabelText(t.catLinkLabel)).toBeNull();
  });
});

describe('agent connectors (A35)', () => {
  const addWebhook = async (id = 'crm') => {
    await click(t.connAdd);
    await type(t.connId, id);
    await type(t.connUrl, 'https://hooks.acme-client.com/wa');
    await type(t.connTools, tools);
    await type(t.connSecretWebhook, SECRET);
  };

  it('is in the rail for the owner and a super admin member, never for staff', async () => {
    render(<App source={createSampleSource()} now={now} />);
    expect(screen.getByRole('link', { name: t.intNav })).toBeTruthy();
    cleanup();
    const admin = createSampleSource();
    admin.role = 'super_admin';
    render(<App source={admin} now={now} />);
    expect(screen.getByRole('link', { name: t.intNav })).toBeTruthy();
    cleanup();
    const staff = createSampleSource();
    staff.role = 'staff';
    render(<App source={staff} now={now} />);
    expect(screen.queryByRole('link', { name: t.intNav })).toBeNull();
  });

  it('a staff user who lands on the integrations screen (typed address) sees a not-allowed state, never the form', async () => {
    const staff = createSampleSource();
    staff.role = 'staff';
    history.replaceState(null, '', '/integrations');
    render(<App source={staff} now={now} />);
    expect((await screen.findByRole('alert')).textContent).toContain(t.notAllowed);
    expect(screen.queryByRole('heading', { name: t.intTitle })).toBeNull();
    expect(screen.queryByLabelText(t.connSecretWebhook)).toBeNull();
  });

  it('a super admin member sees the connectors read-only (WA-SECRETS-1): the list and status, no form, no write buttons, no not-allowed', async () => {
    const admin = createSampleSource();
    admin.role = 'super_admin';
    admin.connectors!.list = vi.fn().mockResolvedValue([{ id: 'crm', kind: 'webhook', enabled: true, hasSecret: true, config: { url: 'https://hooks.acme-client.com/wa', tools: JSON.parse(tools) }, tools: ['check_booking'] }]);
    const save = vi.spyOn(admin.connectors!, 'save');
    history.replaceState(null, '', '/integrations');
    render(<App source={admin} now={now} />);
    expect(await screen.findByRole('heading', { name: t.intTitle })).toBeTruthy();
    expect(await screen.findByRole('article', { name: 'crm' })).toBeTruthy();
    expect(screen.getByText(t.connReadOnly)).toBeTruthy();
    expect(screen.queryByText(t.notAllowed)).toBeNull();
    for (const name of [t.connAdd, t.connEdit, t.connTest, t.connDelete]) expect(screen.queryByRole('button', { name }), name).toBeNull();
    expect(screen.queryByLabelText(t.connSecretWebhook)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('the owner never sees the read-only note', async () => {
    await openIntegrations();
    expect(screen.queryByText(t.connReadOnly)).toBeNull();
    expect(screen.getByRole('button', { name: t.connAdd })).toBeTruthy();
  });

  it('a secret shorter than the server minimum (16 webhook, 8 Odoo) blocks the save and says why next to the field', async () => {
    await openIntegrations();
    await click(t.connAdd);
    await type(t.connId, 'crm');
    await type(t.connUrl, 'https://hooks.acme-client.com/wa');
    await type(t.connTools, tools);
    const saveBtn = () => screen.getByRole('button', { name: t.connSave }) as HTMLButtonElement;
    await type(t.connSecretWebhook, 'x'.repeat(15));
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText(t.connSecretShort(16))).toBeTruthy();
    await type(t.connSecretWebhook, 'x'.repeat(16));
    expect(saveBtn().disabled).toBe(false);
    expect(screen.queryByText(t.connSecretShort(16))).toBeNull();
    await act(async () => fireEvent.change(screen.getByLabelText(t.connKind), { target: { value: 'odoo' } }));
    await type(t.connUrl, 'https://erp.acme-client.com');
    await type(t.connDb, 'acme');
    await type(t.connLogin, 'bot@acme-client.com');
    await type(t.connSecretOdoo, 'x'.repeat(7));
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText(t.connSecretShort(8))).toBeTruthy();
    await type(t.connSecretOdoo, 'x'.repeat(8));
    expect(saveBtn().disabled).toBe(false);
  });

  it('the secret_required message covers a changed address, not only the first save', () => {
    expect(STRINGS.en.connErr.secret_required).toContain('change the address');
    expect(STRINGS.ar.connErr.secret_required).toContain('غيّرت العنوان');
  });

  it('saving needs an explicit confirm that names what the agent may call; nothing is sent before it', async () => {
    const source = createSampleSource();
    const save = vi.spyOn(source.connectors!, 'save');
    await openIntegrations(source);
    await addWebhook();
    await click(t.connSave);
    expect(save).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: t.connConfirmTitle });
    expect(ask.textContent).toContain('hooks.acme-client.com');
    expect(ask.textContent).toContain('crm__check_booking');
    await act(async () => fireEvent.click(within(ask).getByRole('button', { name: t.connConfirmYes })));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('crm', { kind: 'webhook', enabled: true, config: { url: 'https://hooks.acme-client.com/wa', tools: JSON.parse(tools) }, secret: SECRET });
    expect(screen.getByRole('status').textContent).toContain(t.connSaved);
  });

  it('backing out of the confirm sends nothing', async () => {
    const source = createSampleSource();
    const save = vi.spyOn(source.connectors!, 'save');
    await openIntegrations(source);
    await addWebhook();
    await click(t.connSave);
    await click(t.connConfirmNo);
    expect(save).not.toHaveBeenCalled();
  });

  it('the secret is never shown again: not in the list, not in the edit form, and an edit without a new one omits it', async () => {
    const source = createSampleSource();
    await openIntegrations(source);
    await addWebhook();
    await click(t.connSave);
    await click(t.connConfirmYes);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.getByText(t.connHasSecret)).toBeTruthy();
    const listed = await source.connectors!.list();
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const save = vi.spyOn(source.connectors!, 'save');
    await click(t.connEdit);
    expect((screen.getByLabelText(t.connSecretWebhook) as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(SECRET);
    await click(t.connSave);
    await click(t.connConfirmYes);
    expect(save.mock.calls[0]![1]).not.toHaveProperty('secret');
  });

  it('a first save without a secret is blocked, and bad tools JSON is explained', async () => {
    const source = createSampleSource();
    await openIntegrations(source);
    await click(t.connAdd);
    await type(t.connId, 'crm');
    await type(t.connUrl, 'https://hooks.acme-client.com/wa');
    await type(t.connTools, '{not json');
    expect(screen.getByText(t.connToolsBad)).toBeTruthy();
    expect((screen.getByRole('button', { name: t.connSave }) as HTMLButtonElement).disabled).toBe(true);
    await type(t.connTools, tools);
    expect((screen.getByRole('button', { name: t.connSave }) as HTMLButtonElement).disabled).toBe(true); // no secret yet
  });

  it('a refused save shows a plain sentence, never what was typed', async () => {
    const source = createSampleSource();
    source.connectors!.save = vi.fn().mockRejectedValue(new ApiError('invalid_request', 400, 'invalid_url'));
    await openIntegrations(source);
    await addWebhook();
    await click(t.connSave);
    await click(t.connConfirmYes);
    expect(screen.getByRole('alert').textContent).toContain(t.connErr.invalid_url);
    expect(screen.getByRole('alert').textContent).not.toContain(SECRET);
  });

  it('tests a connector and deletes it only after asking', async () => {
    const source = createSampleSource();
    await openIntegrations(source);
    await addWebhook();
    await click(t.connSave);
    await click(t.connConfirmYes);
    const test = vi.spyOn(source.connectors!, 'test');
    await click(t.connTest);
    expect(test).toHaveBeenCalledWith('crm');
    expect(screen.getByText(t.connTestOk)).toBeTruthy();
    const remove = vi.spyOn(source.connectors!, 'remove');
    await click(t.connDelete);
    expect(remove).not.toHaveBeenCalled();
    await click(t.connDeleteYes);
    expect(remove).toHaveBeenCalledWith('crm');
    expect(screen.getByText(t.connNone)).toBeTruthy();
  });

  it('an Odoo connector sends its own shape and the API key as the secret', async () => {
    const source = createSampleSource();
    const save = vi.spyOn(source.connectors!, 'save');
    await openIntegrations(source);
    await click(t.connAdd);
    await type(t.connId, 'erp');
    await act(async () => fireEvent.change(screen.getByLabelText(t.connKind), { target: { value: 'odoo' } }));
    await type(t.connUrl, 'https://erp.acme-client.com');
    await type(t.connDb, 'acme');
    await type(t.connLogin, 'bot@acme-client.com');
    await type(t.connSecretOdoo, 'odoo-api-key-123');
    await click(t.connSave);
    await click(t.connConfirmYes);
    expect(save).toHaveBeenCalledWith('erp', { kind: 'odoo', enabled: true, config: { url: 'https://erp.acme-client.com', database: 'acme', login: 'bot@acme-client.com' }, secret: 'odoo-api-key-123' });
  });
});

describe('integration tokens (A36): issued by the account, not by Ebda Chat', () => {
  it('explains the scopes and sends the owner to the account settings; Chat holds and shows no token', async () => {
    await openIntegrations();
    const panel = screen.getByRole('region', { name: t.apiTitle });
    expect(panel.textContent).toContain('messages:send');
    const link = within(panel).getByRole('link', { name: t.apiOpen }) as HTMLAnchorElement;
    expect(link.href).toBe('https://accounts.ebda.app/');
    expect(link.rel).toContain('noopener');
    expect(within(panel).queryByRole('button')).toBeNull();
  });
});
