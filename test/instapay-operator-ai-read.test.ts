import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listForOperator, parseAiRead } from '../src/core/billing/instapay';
import { parseReceiptExtraction } from '../foundation/instapay-extract';
import { seedNumber } from './helpers/workspace';
import { storeId } from './helpers/api';

// A realistic reader answer for an Egyptian InstaPay app screenshot (Arabic labels, Arabic-Indic digits in the reference). No real customer data.
const READ = { amount: '٢٥٠٫٠٠ جنيه', recipientHandle: 'EBDA@instapay', date: '2026-11-23', time: '14:30', reference: '٦٨٩٤٢٣٢٠٧٧٣٦', looksEdited: false, confidence: 0.9 };

describe('operator InstaPay queue shows what the receipt reader saw (suggestion only)', () => {
  it('parseAiRead returns the reference, ignores junk and empties', () => {
    expect(parseAiRead(JSON.stringify({ amountMinor: 1000, reference: '689423207736' }))).toEqual({ reference: '689423207736', amountMinor: 1000 });
    expect(parseAiRead(JSON.stringify({ reference: ' 123 456 ' }))).toEqual({ reference: '123 456', amountMinor: null });
    expect(parseAiRead(JSON.stringify({ reference: '   ' }))).toBeNull();
    expect(parseAiRead('not json')).toBeNull();
    expect(parseAiRead(null)).toBeNull();
  });

  it('the Arabic receipt answer parses to a digit reference that listForOperator then surfaces, while bank_ref stays untouched', async () => {
    const parsed = parseReceiptExtraction(READ);
    expect(parsed.extract?.reference).toMatch(/^\d+$/);
    const ws = storeId(9951);
    await seedNumber('pn-airead-1', ws);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, currency, state, created_by, created_at, expires_at, proof_key, proof_mime, proof_at) VALUES ('ir-ai-1','WA-AIREAD01',?,'topup',25000,'EGP','under_review','u1',?,?, 'k','image/png',?)").bind(ws, now, now + 1e7, now).run();
    await env.DB.prepare("INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, idempotency_key, extracted_json, created_at, updated_at) VALUES ('ac-ai-1','ir-ai-1',?,'needs_human','k-ai-1',?,?,?)")
      .bind(ws, JSON.stringify({ amountMinor: parsed.extract!.amountMinor, reference: parsed.extract!.reference }), now, now).run();
    const item = (await listForOperator(env, 'under_review')).find((i) => i.id === 'ir-ai-1')!;
    expect(item.aiRead).toEqual({ reference: parsed.extract!.reference, amountMinor: 25000 });
    expect(item.bankRef).toBeNull();
  });
});

describe('queue size', () => {
  it('150 pending requests (over the D1 100-parameter cap) still list, with the read reference on those that have one', async () => {
    const ws = storeId(9952);
    await seedNumber('pn-airead-2', ws);
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < 150; i++) {
      stmts.push(env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, currency, state, created_by, created_at, expires_at, proof_key, proof_mime, proof_at) VALUES (?,?,?,'topup',1000,'EGP','under_review','u1',?,?, 'k','image/png',?)").bind(`big-${i}`, `WA-BIG${String(i).padStart(5, '0')}`, ws, now + i, now + 1e7, now));
    }
    stmts.push(env.DB.prepare("INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, idempotency_key, extracted_json, created_at, updated_at) VALUES ('ac-big','big-7',?,'needs_human','k-big',?,?,?)").bind(ws, JSON.stringify({ reference: '111222333444', amountMinor: 1000 }), now, now));
    await env.DB.batch(stmts);
    const items = (await listForOperator(env, 'under_review')).filter((i) => i.id.startsWith('big-'));
    expect(items).toHaveLength(150);
    expect(items.find((i) => i.id === 'big-7')!.aiRead).toEqual({ reference: '111222333444', amountMinor: 1000 });
    expect(items.find((i) => i.id === 'big-8')!.aiRead).toBeNull();
  });
});
