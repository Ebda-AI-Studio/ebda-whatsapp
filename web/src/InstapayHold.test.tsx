import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import type { OperatorInstapay } from './data/billing';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const item = (over: Partial<OperatorInstapay>): OperatorInstapay => ({
  id: 'ip-x', reference: 'WA-AAAAAAAA', kind: 'topup', packageId: null, amountMinor: 31000, currency: 'EGP', state: 'under_review', createdAt: 1, expiresAt: 2, hasProof: true, rejectReason: null, decidedAt: null,
  workspaceId: 'ws-x', createdBy: 'u-merchant', proofAt: 1, firstApprover: null, decidedBy: null, proofMime: 'image/png', heldReason: null, heldOf: null, bankRef: null, ...over,
});

async function openQueue(queue: OperatorInstapay[]) {
  const source = createSampleSource();
  source.role = 'super_admin';
  source.operator!.instapayQueue = async () => queue;
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
  await screen.findByRole('heading', { name: t.opTitle, level: 1 });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.queues! })));
  return { source, card: await screen.findByRole('region', { name: t.opIpTitle }) };
}

describe('InstaPay review: duplicates (C2)', () => {
  it('a held request shows why and which other request, cannot be confirmed, and is released with a reason of its own', async () => {
    const { source, card } = await openQueue([item({ id: 'ip-held', heldReason: 'duplicate_image', heldOf: 'ip-first' })]);
    expect(within(card).getAllByRole('note').map((n) => n.textContent).join(' ')).toContain(t.opIpHeldReasons.duplicate_image!);
    expect(within(card).getByText(t.opIpHeldOf('ip-first'))).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t.opIpConfirm })).toBeNull(); // no confirm while held
    const release = vi.spyOn(source.operator!, 'releaseInstapay');
    const btn = within(card).getByRole('button', { name: t.opIpRelease }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.opIpReleaseReason), { target: { value: 'فحصت التحويلين في تطبيق البنك' } });
    await act(async () => fireEvent.click(btn));
    expect(release).toHaveBeenCalledWith('ip-held', 'فحصت التحويلين في تطبيق البنك');
    expect(within(card).getByRole('button', { name: t.opIpReject })).toBeTruthy(); // rejecting is always possible
  });

  it('confirm needs the bank reference (DUP-REF-REQUIRED-1), or the "no number on the proof" tick with a reason; a duplicate reference is explained', async () => {
    const { source, card } = await openQueue([item({ id: 'ip-ok' })]);
    const confirm = vi.spyOn(source.operator!, 'confirmInstapay');
    const btn = within(card).getByRole('button', { name: t.opIpConfirm }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // neither a number nor the tick
    fireEvent.click(within(card).getByLabelText(t.opIpNoRef)); // ticked: the number box goes, a reason box appears
    expect(within(card).queryByLabelText(t.opIpBankRef)).toBeNull();
    expect(btn.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.opIpNoRefReason), { target: { value: 'الإيصال مفيهوش رقم عملية' } });
    expect(btn.disabled).toBe(false);
    await act(async () => fireEvent.click(btn));
    expect(confirm).toHaveBeenLastCalledWith('ip-ok', undefined, 'الإيصال مفيهوش رقم عملية');
    fireEvent.click(within(card).getByLabelText(t.opIpNoRef)); // un-ticked: back to the number
    fireEvent.change(within(card).getByLabelText(t.opIpBankRef), { target: { value: 'IP 4471 0098' } });
    confirm.mockRejectedValueOnce(new ApiError('invalid_request', 409, 'duplicate_reference'));
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.opIpConfirm })));
    expect(confirm).toHaveBeenLastCalledWith('ip-ok', 'IP 4471 0098');
    expect((await screen.findByRole('alert')).textContent).toBe(t.opIpDupRef);
  });

  it('explains the two-approval rules: the reference is required, must match the first approver\'s, and the releaser cannot approve', async () => {
    const { source, card } = await openQueue([item({ id: 'ip-two' })]);
    const confirm = vi.spyOn(source.operator!, 'confirmInstapay');
    fireEvent.change(within(card).getByLabelText(t.opIpBankRef), { target: { value: 'IP 5500 7766' } });
    for (const [detail, text] of [['bank_reference_required', t.opIpRefRequired], ['reference_mismatch', t.opIpRefMismatch], ['releaser_cannot_approve', t.opIpReleaser]] as const) {
      confirm.mockRejectedValueOnce(new ApiError('invalid_request', 409, detail));
      await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.opIpConfirm })));
      expect((await screen.findByRole('alert')).textContent).toBe(text);
    }
  });
});
