import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { backupPrefix } from '../src/core/backup';
import { PIASTERS, chat, fund, holds, jobOf, ledger, nowS, pn, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000072${String(n).padStart(2, '0')}`;
const inDo = <T>(ws: string, f: (sql: SqlStorage) => T) => runInDurableObject(workspace(ws), (_i, state) => f(state.storage.sql));

describe('the wallet ledger is append-only and chained', () => {
  it('balance_after follows the rows; a repeated ref is a no-op; zero and bad signs are refused', async () => {
    const ws = W(1);
    expect(await workspace(ws).postWallet({ kind: 'topup', netMinor: 1000, ref: 'kashier:a' })).toMatchObject({ ok: true, balance: 1000, debtSettledMinor: 0 });
    expect(await workspace(ws).postWallet({ kind: 'topup', netMinor: 1000, ref: 'kashier:a' })).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(await workspace(ws).postWallet({ kind: 'topup', netMinor: -5, ref: 'kashier:neg' })).toEqual({ ok: false, reason: 'bad_sign' });
    expect(await workspace(ws).postWallet({ kind: 'refund', netMinor: 5, ref: 'refund:pos' })).toEqual({ ok: false, reason: 'bad_sign' });
    expect(await workspace(ws).postWallet({ kind: 'topup', netMinor: 0, ref: 'kashier:zero' })).toMatchObject({ ok: false });
    expect(await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -100, ref: 'adj:1' })).toEqual({ ok: false, reason: 'actor_and_note_required' });
    expect(await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -100, ref: 'adj:1', actor: 'op-1', note: 'goodwill' })).toMatchObject({ ok: true, balance: 900 });
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor, r.balance_after, r.ref])).toEqual([['topup', 1000, 1000, 'kashier:a'], ['adjustment', -100, 900, 'adj:1']]);
  });

  it('(d) rows cannot be updated or deleted; holds and billable_sends cannot be deleted', async () => {
    const ws = W(2);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await sendOut(ws, job, wamidOf('trig'));
    await inDo(ws, (sql) => {
      expect(() => sql.exec('UPDATE wallet_ledger SET amount_minor = 999')).toThrow(/append-only/);
      expect(() => sql.exec('DELETE FROM wallet_ledger')).toThrow(/append-only/);
      expect(() => sql.exec('DELETE FROM wallet_holds')).toThrow(/never deleted/);
      expect(() => sql.exec('DELETE FROM billable_sends')).toThrow(/never deleted/);
      expect(sql.exec('SELECT count(*) AS n FROM billable_sends').one().n).toBe(1);
    });
  });

  it('an amount that does not equal net + vat is refused by the schema', async () => {
    const ws = W(3);
    await workspace(ws).walletView();
    await inDo(ws, (sql) => {
      expect(() => sql.exec("INSERT INTO wallet_ledger (at, kind, net_minor, vat_minor, amount_minor, balance_after, ref) VALUES (1, 'topup', 100, 14, 100, 100, 'x')")).toThrow();
    });
  });
});

describe('(c) concurrent holds cannot exceed available', () => {
  it('20 marketing sends race for a wallet that pays for 2: exactly 2 are claimed, the rest fail wallet_empty, available never goes negative', { timeout: 30_000 }, async () => {
    const ws = W(10);
    await setupBilling(ws);
    await fund(ws, PIASTERS.marketing * 2 + 100); // pays for two
    const conv = await chat(ws);
    const jobs = [];
    // queueOutbound already refuses a third once two holds exist, so create the messages first through the cheaper path: separate contacts per message
    for (let i = 0; i < 20; i++) {
      const waId = `2010100${String(i).padStart(5, '0')}`;
      jobs.push({ workspaceId: ws, phoneNumberId: pn(ws), to: waId, idempotencyKey: `cmp:race-${i}`, kind: 'template' as const, template: { name: 'tpl-m', language: 'ar', components: [] } });
    }
    void conv;
    // These keys are not campaign keys and have no message row: use auto-reply style text? Marketing needs a template row, so insert the rows directly.
    for (const j of jobs) await exec(ws, "INSERT INTO contacts (wa_id) VALUES (?)", j.to);
    await exec(ws, "INSERT INTO conversations (contact_id) SELECT id FROM contacts WHERE wa_id LIKE '2010100%'");
    for (const j of jobs) {
      await exec(ws, "INSERT INTO messages (conversation_id, direction, type, status, idempotency_key, template_name, template_lang, created_at, updated_at) SELECT c.id, 'out', 'template', 'queued', ?, 'tpl-m', 'ar', 1, 1 FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?", j.idempotencyKey, j.to);
    }
    const stub = workspace(ws);
    const results = await Promise.all(jobs.map(async (j, i) => {
      await new Promise((r) => setTimeout(r, (i * 7) % 11)); // real delays: the claims interleave at their awaits
      return stub.claimSend(j);
    }));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(2);
    expect(results.filter((r) => r === 'dropped')).toHaveLength(18);
    const view = await stub.walletView();
    expect(view.heldMinor).toBe(PIASTERS.marketing * 2);
    expect(view.availableMinor).toBe(100);
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE error_reason = 'wallet_empty'")).toEqual([{ n: 18 }]);
  });

  it('a top-up racing a stream of utility sends never loses or doubles money', { timeout: 30_000 }, async () => {
    const ws = W(11);
    await setupBilling(ws, { settings: { limit: 0 } });
    await fund(ws, 500);
    const conv = await chat(ws);
    const queued = await Promise.all(Array.from({ length: 6 }, () => queueTemplate(ws, conv, 'UTILITY')));
    const stub = workspace(ws);
    const out = await Promise.all([
      ...queued.map(async (q, i) => {
        await new Promise((r) => setTimeout(r, (i * 5) % 9));
        return stub.claimSend(jobOf(q));
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 6));
        return stub.postWallet({ kind: 'topup', netMinor: 1000, ref: 'kashier:race' });
      })(),
    ]);
    const view = await stub.walletView();
    expect(view.balanceMinor).toBe(1500);
    expect(view.availableMinor).toBeGreaterThanOrEqual(0);
    expect(out.slice(0, 6).filter((r) => r === 'claimed').length + out.slice(0, 6).filter((r) => r === 'deferred').length).toBe(6);
  });
});

describe('(e) the D1 mirror equals the workspace after a drain', () => {
  it('wallet and AI credit rows are copied once; a repeated drain adds nothing; a wrong mirror is reported', async () => {
    const ws = W(20);
    await setupBilling(ws);
    await fund(ws, 5000, 'kashier:m1');
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -300, ref: 'adj:m', actor: 'op', note: 'fix' });
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'p', credits: 50 });
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf('m'));
    await status(ws, wamidOf('m'), 'sent', nowS(), pricing('marketing'));
    await status(ws, wamidOf('m'), 'delivered', nowS());
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup', 'adjustment', 'meta_charge']);
    // The workspace's own `ledger_drain` task may already have copied some rows (a slow host runs the alarm first): assert the end state.
    expect(await workspace(ws).drainLedger()).toMatchObject({ remaining: 0 });
    expect(await workspace(ws).drainLedger()).toMatchObject({ drained: 0, remaining: 0 });
    const check = await workspace(ws).mirrorCheck();
    expect(check).toEqual([
      { ledger: 'wallet', doSum: 5000 - 300 - PIASTERS.marketing, d1Sum: 5000 - 300 - PIASTERS.marketing, doRows: 3, d1Rows: 3, equal: true },
      { ledger: 'credit', doSum: 50, d1Sum: 50, doRows: 1, d1Rows: 1, equal: true },
    ]);
    // D1 rows cannot be edited or deleted
    await expect(env.DB.prepare('DELETE FROM ledger_mirror WHERE workspace_id = ?').bind(ws).run()).rejects.toThrow(/append-only/);
    // a stray mirror row (a bug somewhere) is caught, not hidden
    await env.DB.prepare("INSERT INTO ledger_mirror (workspace_id, ledger, ref, at, kind, amount, balance_after) VALUES (?, 'wallet', 'stray', 1, 'topup', 77, 77)").bind(ws).run();
    expect((await workspace(ws).mirrorCheck())[0]).toMatchObject({ equal: false, d1Sum: 5000 - 300 - PIASTERS.marketing + 77 });
  });

  it('rows still waiting in the outbox are not counted against the mirror; the drain task runs from the alarm', async () => {
    const ws = W(21);
    await fund(ws, 100, 'kashier:o1');
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'ledger_drain'")).toHaveLength(1);
    expect((await workspace(ws).mirrorCheck())[0]).toMatchObject({ equal: true });
    await workspace(ws).runDueTasks(Date.now() + 5_000);
    expect(await rows(ws, 'SELECT count(*) AS n FROM ledger_outbox WHERE drained_at IS NULL')).toEqual([{ n: 0 }]);
    expect((await workspace(ws).mirrorCheck())[0]).toMatchObject({ equal: true, d1Rows: 1 });
  });
});

describe('(g) erasure leaves the money tables alone', () => {
  it('erasing a contact removes its messages but not one money row; a late billable status for the erased wamid still charges', async () => {
    const ws = W(30);
    await setupBilling(ws);
    await fund(ws, 3000);
    const conv = await chat(ws, 'MARKETING', '201005550001');
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf('er'));
    await status(ws, wamidOf('er'), 'sent', nowS(), pricing('marketing'));
    const before = { ledger: await ledger(ws), holds: await holds(ws), sends: await rows(ws, 'SELECT * FROM billable_sends') };
    expect(before.holds).toHaveLength(1);
    const res = await workspace(ws).eraseContact('201005550001');
    expect(res.found).toBe(true);
    expect(await rows(ws, 'SELECT count(*) AS n FROM messages')).toEqual([{ n: 0 }]);
    // the hold went back (the message is gone) but the row, the ledger and billable_sends are all still there
    const after = { ledger: await ledger(ws), holds: await holds(ws), sends: await rows(ws, 'SELECT * FROM billable_sends') };
    expect(after.ledger).toEqual(before.ledger);
    expect(after.sends).toEqual(before.sends);
    expect(after.holds).toEqual([{ ...before.holds[0]!, state: 'released', release_reason: 'erased' }]);
    // Meta bills it anyway: the charge needs no hold and no message row
    await status(ws, wamidOf('er'), 'delivered', nowS());
    const l = await ledger(ws);
    expect(l.at(-1)).toMatchObject({ kind: 'meta_charge', amount_minor: -PIASTERS.marketing, ref: `meta:${wamidOf('er')}` });
    // no phone number or name in any money table
    const dump = JSON.stringify([await rows(ws, 'SELECT * FROM wallet_ledger'), await rows(ws, 'SELECT * FROM wallet_holds'), await rows(ws, 'SELECT * FROM billable_sends'), await rows(ws, 'SELECT * FROM ledger_outbox')]);
    expect(dump).not.toContain('201005550001');
  });
});

describe('(h) a merchant-card number never produces a debit', () => {
  it('Meta bills the card: the cost is recorded for display, the balance and the ledger do not move', async () => {
    const ws = W(40);
    await setupBilling(ws, { funding: 'merchant_card' });
    await fund(ws, 1000);
    const conv = await chat(ws);
    for (const [i, cat] of (['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const).entries()) {
      const job = jobOf(await queueTemplate(ws, conv, cat));
      expect(await sendOut(ws, job, wamidOf(`card${i}`))).toBe('sent');
      await status(ws, wamidOf(`card${i}`), 'sent', nowS(), pricing(cat.toLowerCase()));
      await status(ws, wamidOf(`card${i}`), 'delivered', nowS());
      await status(ws, wamidOf(`card${i}`), 'read', nowS() + 1);
    }
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']);
    const view = await workspace(ws).walletView();
    expect(view).toMatchObject({ balanceMinor: 1000, heldMinor: 0, availableMinor: 1000 });
    expect(await rows(ws, 'SELECT charged_category AS c, cost_usd_micros AS u FROM billable_sends ORDER BY wamid')).toEqual([{ c: 'marketing', u: 50_000 }, { c: 'utility', u: 20_000 }, { c: 'authentication', u: 30_000 }]);
    expect((await holds(ws)).every((h) => h.amount_minor === 0 && h.state === 'charged')).toBe(true);
  });

  it('even an empty wallet sends on a merchant-card number', async () => {
    const ws = W(41);
    await setupBilling(ws, { funding: 'merchant_card' });
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    expect(await sendOut(ws, job, wamidOf('free'))).toBe('sent');
  });

  it('a number nobody registered counts as merchant-card', async () => {
    const ws = W(42);
    await setupBilling(ws, { funding: null });
    const conv = await chat(ws);
    expect(await sendOut(ws, jobOf(await queueTemplate(ws, conv, 'MARKETING')), wamidOf('unreg'))).toBe('sent');
    expect(await ledger(ws)).toEqual([]);
  });
});

describe('money tables ride the backup and restore without a trigger bypass', () => {
  it('a restore brings back ledger, holds, billable_sends and outbox exactly (inserts do not fire the append-only triggers)', async () => {
    const src = W(50);
    await setupBilling(src);
    await fund(src, 4000, 'kashier:b1');
    const conv = await chat(src);
    const job = jobOf(await queueTemplate(src, conv, 'UTILITY'));
    await sendOut(src, job, wamidOf('bk'));
    await status(src, wamidOf('bk'), 'sent', nowS(), pricing('utility'));
    await status(src, wamidOf('bk'), 'delivered', nowS());
    // Drain the outbox first: the scheduled drain otherwise lands at a real-time moment of its own (between the snapshot and the
    // comparison on a slow machine) and the source would no longer match what the snapshot holds.
    expect((await workspace(src).drainLedger()).remaining).toBe(0);
    const manifest = await workspace(src).exportSnapshot('2026-10-25');
    expect(manifest.tables.wallet_ledger?.rows).toBe(2);
    expect(manifest.tables.billable_sends?.rows).toBe(1);
    const dst = W(51);
    const res = await workspace(dst).importSnapshot(backupPrefix(src, '2026-10-25'));
    expect(res.ok).toBe(true);
    for (const t of ['wallet_ledger', 'wallet_holds', 'billable_sends', 'ledger_outbox']) {
      expect(await rows(dst, `SELECT * FROM ${t} ORDER BY 1, 2`), t).toEqual(await rows(src, `SELECT * FROM ${t} ORDER BY 1, 2`));
    }
    // and the restored ledger is still append-only
    await inDo(dst, (sql) => expect(() => sql.exec('DELETE FROM wallet_ledger')).toThrow(/append-only/));
    expect((await workspace(dst).walletView()).balanceMinor).toBe(4000 - PIASTERS.utility);
  });
});
