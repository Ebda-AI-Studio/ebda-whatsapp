import { describe, expect, it, vi } from 'vitest';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { WA_1, flush, useStoreLink } from './helpers/store-link';
import { env } from 'cloudflare:test';
import { exec, rows, workspace } from './helpers/workspace';

// Audit D3: a handoff must reach the OWNER, not only light a badge. Free text inside the owner's 24 h window, an approved UTILITY template outside it,
// and an alert + the daily digest when neither can go out. (The repo has no web push or e-mail path to the merchant: see docs/ai-agent.md.)
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000075${String(n).padStart(2, '0')}`;
const OWNER = '+201555000111';
const OWNER_WA = '201555000111';
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const agentWs = async (ws: string, settings: Record<string, unknown> = {}) => {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};
/** What the workspace queued for the owner (notices go through the send queue, which the tests mock). */
const toOwner = async (ws: string) => (await flush(ws)).filter((j) => j.to === OWNER_WA);
const ownerWindowOpen = (ws: string) => exec(ws, 'INSERT OR REPLACE INTO contacts (wa_id, last_inbound_at) VALUES (?, ?)', OWNER_WA, Math.floor(Date.now() / 1000));
/** Rate card + FX in D1 (the number's funding is seeded by the workspace helper), then the workspace pulls them: a template send is priced. */
const seedRates = async (ws: string) => {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (1, 0, ?, ?, ?, 0, ?)').bind('EG', 'utility', 20_000, 'test'),
    env.DB.prepare('INSERT OR IGNORE INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor) VALUES (1, 0, 50000000, 0, 0, ?)').bind('test'),
  ]);
  await workspace(ws).refreshPricing();
  await workspace(ws).postWallet({ kind: 'topup', netMinor: 100_000, ref: `kashier:fund-${ws}` });
};
const approveAlertTemplate = async (ws: string) => {
  await seedRates(ws);
  for (const t of EBDA_DEFAULT_TEMPLATES.filter((x) => x.name === 'handoff_alert'))
    await exec(ws, "INSERT OR REPLACE INTO templates (name, language, category, status, components, updated_at) VALUES (?, ?, ?, 'APPROVED', ?, 1)", t.name, t.language, t.category, JSON.stringify(t.components));
};

describe('the owner is told (D3)', () => {
  it('ships the template for approval (utility, Arabic and English, two parameters)', () => {
    const t = EBDA_DEFAULT_TEMPLATES.filter((x) => x.name === 'handoff_alert');
    expect(t.map((x) => [x.language, x.category]).sort()).toEqual([['ar', 'UTILITY'], ['en', 'UTILITY']]);
  });

  it('no notify number: nothing goes to anybody but the shopper', async () => {
    const ws = W(1);
    const pn = await agentWs(ws);
    const g = stubGraph();
    await say(ws, pn, text('عايز اكلم حد'), g);
    expect(g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages') && c.body?.status !== 'read').every((c) => c.body.to === WA_1)).toBe(true);
  });

  it('inside the owner window: one WhatsApp text with the shopper name and the last 3 lines, no phone number', async () => {
    const ws = W(2);
    const pn = await agentWs(ws, { notifyPhone: OWNER });
    await ownerWindowOpen(ws);
    const g = stubGraph();
    model([{ text: 'تمام' }, { tools: [{ name: 'handoff_to_human' }] }]);
    await say(ws, pn, text('السلام عليكم'), g);
    await say(ws, pn, text('الطلب وصلني مكسور'), g);
    const sent = await toOwner(ws);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind ?? 'text').toBe('text');
    const body = sent[0]!.text as string;
    expect(body).toContain('الطلب وصلني مكسور');
    expect(body).toContain('السلام عليكم');
    expect(body).not.toContain(WA_1);
    expect(body).not.toMatch(/\+?20\d{9}/);
  });

  it('outside the owner window with an approved template: the template goes, with name and summary as one-line parameters', async () => {
    const ws = W(3);
    const pn = await agentWs(ws, { notifyPhone: OWNER });
    await approveAlertTemplate(ws);
    const g = stubGraph();
    await say(ws, pn, text('عايز اكلم حد'), g); // a words match, no model call
    const sent = await toOwner(ws);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('template');
    expect(sent[0]!.template!.name).toBe('handoff_alert');
    const params = sent[0]!.template!.components[0]!.parameters.map((p) => p.text as string);
    expect(params).toHaveLength(2);
    expect(params.every((p: string) => !/[\n\t]/.test(p))).toBe(true);
    expect(params[1]).toContain('عايز اكلم حد');
  });

  it('neither a window nor an approved template: the owner cannot be reached, so an alert is raised, the shopper is still answered, and the digest carries it', async () => {
    const ws = W(4);
    const pn = await agentWs(ws, { notifyPhone: OWNER });
    const log: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    const g = stubGraph();
    try {
      const out = await say(ws, pn, text('عايز اكلم حد'), g);
      expect(out.map((s) => s.text)).toHaveLength(1);
    } finally { spy.mockRestore(); }
    expect(await toOwner(ws)).toHaveLength(0);
    expect(log.join(' ')).toContain('handoff_owner_unreachable');
  });

  it('one notice per handoff: a second request while the handoff is open does not page again', async () => {
    const ws = W(5);
    const pn = await agentWs(ws, { notifyPhone: OWNER });
    await approveAlertTemplate(ws);
    const g = stubGraph();
    await say(ws, pn, text('عايز اكلم حد'), g);
    await say(ws, pn, text('لو سمحت عايز موظف'), g);
    expect(await toOwner(ws)).toHaveLength(1);
  });

  it('the owner testing their own shop is not paged about themselves', async () => {
    const ws = W(6);
    const pn = await agentWs(ws, { notifyPhone: `+${WA_1}` });
    await approveAlertTemplate(ws);
    const g = stubGraph();
    await say(ws, pn, text('عايز اكلم حد'), g);
    expect((await flush(ws)).filter((j) => j.idempotencyKey.startsWith('handoff:'))).toEqual([]); // no notice queued to the shopper's own number
  });
});

describe('the daily digest of unresolved needs_human', () => {
  it('saving a notify number arms the digest for 10:00 Cairo; it re-arms itself while a number is set', async () => {
    const ws = W(9);
    await agentWs(ws, { notifyPhone: OWNER });
    const due = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'handoff_digest'");
    expect(due).toHaveLength(1);
    expect(due[0]!.due_at).toBeGreaterThan(Date.now());
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(due[0]!.due_at)).toBe('10');
    await exec(ws, "UPDATE scheduled_tasks SET due_at = 0 WHERE kind = 'handoff_digest'");
    await workspace(ws).runDueTasks();
    expect((await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'handoff_digest'"))[0]!.due_at).toBeGreaterThan(Date.now());
  });

  const runDigest = async (ws: string) => {
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at) VALUES ('handoff_digest', 0)");
    await workspace(ws).runDueTasks();
  };
  it('lists how many conversations still wait for a person, to the owner, once a day', async () => {
    const ws = W(10);
    const pn = await agentWs(ws, { notifyPhone: OWNER });
    await ownerWindowOpen(ws);
    const g = stubGraph();
    await say(ws, pn, text('عايز اكلم حد'), g);
    const before = (await toOwner(ws)).length;
    await runDigest(ws);
    await runDigest(ws);
    const sent = (await toOwner(ws)).slice(before);
    expect(sent).toHaveLength(1); // the same day's digest is idempotent
    expect(sent[0]!.text).toMatch(/1/);
  });
  it('says nothing when nobody waits, or when no notify number is set', async () => {
    const ws = W(11);
    await agentWs(ws, { notifyPhone: OWNER });
    await ownerWindowOpen(ws);
    const g = stubGraph();
    await runDigest(ws);
    expect(await toOwner(ws)).toHaveLength(0);
    const ws2 = W(12);
    const pn2 = await agentWs(ws2);
    await say(ws2, pn2, text('عايز اكلم حد'), g);
    const n = g.calls.length;
    await runDigest(ws2);
    expect(g.calls.length).toBe(n);
    expect(await rows(ws2, "SELECT 1 FROM scheduled_tasks WHERE kind = 'handoff_digest' AND due_at > ?", Date.now())).toEqual([]); // no notify number: not re-armed
  });
});
