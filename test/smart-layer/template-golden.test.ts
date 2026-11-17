/**
 * The template writer's golden set (plan 4 Task D3). Each task is graded on FINAL STATE, never on wording: after the merchant presses the confirm button, the
 * workspace holds a template with the expected category and status PENDING, Meta's rules find zero errors in it, and Meta (Graph) saw exactly one submission.
 * Default CI drives the real route stack with a scripted writer that returns the task's `scripted` draft (proving the harness, the graders and the whole
 * write -> confirm -> submit path); `SMART_LAYER_EVAL=1` swaps in the real model (see docs/assistant.md) and applies the same graders.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import goldenRaw from '../../evals/smart-layer/golden.templates.jsonl?raw';
import { restAiBinding } from '../../foundation/smart-layer/eval/rest-ai';
import { grantCredits } from '../../src/core/ai/credits';
import { checkTemplate } from '../../src/core/meta/template-rules';
import { fromStoredComponents } from '../../src/core/template-draft';
import { selectTools } from '../../foundation/smart-layer/plan/select-tools';
import corpusJson from '../../assistant/help-corpus.generated.json';
import registryJson from '../../assistant/registry.generated.json';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import type { HelpCorpus } from '../../src/core/smart-layer/help-index';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import type { TemplateDraftInput } from '../../src/core/api/contract';
import { configureAssistant } from '../../src/routes/assistant';
import { graphStub, useApiKey } from '../helpers/api';
import type { stubGraph } from '../helpers/graph';
import { exec, rows } from '../helpers/workspace';
import { noHelp, post, scriptedAi, setup } from './harness';

useApiKey();
type Task = {
  id: string; lang: 'ar-EG' | 'franco' | 'en'; class: 'action'; kind: 'write' | 'fix'; turns: string[];
  expect: { category: string; language: string; status: 'PENDING'; submissions: number; nameKept?: true };
  seed?: { name: string; language: string; category: string; label: string; text: string; reason: string };
  scripted: TemplateDraftInput;
};
const TASKS = goldenRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Task);

let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { graph?.restore(); configureAssistant({}); });

/** Runs one task through the route stack and returns what the final-state graders need. */
async function run(task: Task, n: number, model: 'scripted' | { run: (m: string, i: Record<string, unknown>) => Promise<unknown> }) {
  const t = await setup(n);
  await runInDurableObject(t.ws, (_i, st) => { grantCredits(st.storage.sql, { periodStart: Date.now(), packageId: 'p', credits: 20, now: Date.now() }); });
  if (task.seed) {
    const s = task.seed;
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id, rejected_reason, label) VALUES (?, ?, ?, 'REJECTED', ?, 1, 'm-9', ?, ?)", s.name, s.language, s.category, JSON.stringify([{ type: 'BODY', text: s.text }]), s.reason, s.label);
  }
  graph = graphStub((call) => (call.url.endsWith('/message_templates') ? { status: 200, json: { id: 'meta-1', status: 'PENDING', category: (call.body as { category: string }).category } } : { status: 200, json: { success: true } }));
  const tool = task.kind === 'write' ? { name: 'template_write', args: { request: task.turns[0] } } : { name: 'template_fix', args: { name: task.seed!.name, language: task.seed!.language } };
  const ai = model === 'scripted' ? scriptedAi([{ call: tool }, { text: JSON.stringify(task.scripted) }, { text: 'جهزت القالب.' }]) : model;
  configureAssistant({ ai: ai as never, help: noHelp });
  const res = await post(t.s, t.api.token, '/turn', { conversationId: crypto.randomUUID(), text: task.turns[0], locale: 'ar' });
  const out = (await res.json()) as { previews: Array<{ approvalId?: string }>; approvals?: Array<{ approvalId: string; token: string }> };
  const ap = out.approvals?.[0];
  if (ap) await t.confirm(ap.approvalId, ap.token);
  const name = task.kind === 'fix' ? task.seed!.name : null;
  const stored = (await rows(t.s, name ? 'SELECT name, language, category, status, components, label FROM templates WHERE name = ?' : 'SELECT name, language, category, status, components, label FROM templates', ...(name ? [name] : []))) as Array<{ name: string; language: string; category: string; status: string; components: string; label: string | null }>;
  const create = graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates')).length;
  const edit = graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/m-9')).length;
  return { stored, create, edit };
}

function grade(task: Task, r: Awaited<ReturnType<typeof run>>): string[] {
  const fails: string[] = [];
  const row = r.stored[0];
  if (!row) return ['no template in the workspace'];
  if (row.category !== task.expect.category) fails.push(`category ${row.category}, expected ${task.expect.category}`);
  if (row.language !== task.expect.language) fails.push(`language ${row.language}, expected ${task.expect.language}`);
  if (!['PENDING', 'REJECTED'].includes(row.status) || (task.kind === 'write' && row.status !== task.expect.status)) fails.push(`status ${row.status}`);
  const draft = fromStoredComponents(JSON.parse(row.components) as never, { name: row.name, language: row.language, category: row.category, label: row.label });
  const errors = checkTemplate(draft).filter((i) => i.severity === 'error').map((i) => i.code);
  if (errors.length) fails.push(`Meta rules: ${errors.join(', ')}`);
  const submissions = task.kind === 'write' ? r.create : r.edit;
  if (submissions !== task.expect.submissions) fails.push(`${submissions} submissions, expected ${task.expect.submissions}`);
  if (task.kind === 'fix' && r.create !== 0) fails.push('a fix must not create a second template');
  if (task.expect.nameKept && row.name !== task.seed!.name) fails.push('a fix renamed the template');
  return fails;
}

const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const TOOLS = chatAdapter({ env, ws: undefined as never, callApi: async () => ({ status: 200, json: {} }), registry: REGISTRY, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } }).tools();

describe('structure', () => {
  it('for every ask, the tool retrieval rail offers the writer tool the task needs (Arabic, Franco and English)', () => {
    const missing = TASKS.filter((t) => !selectTools(t.turns[0]!, TOOLS, REGISTRY, { mode: 'act', untrustedInContext: false }).some((o) => o.name === (t.kind === 'write' ? 'template_write' : 'template_fix'))).map((t) => t.id);
    expect(missing).toEqual([]);
  });
  it('at least 25 tasks in all three languages, shipping / OTP / COD / Eid promo / abandoned cart each present, and 5 rejection fixes', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const l of ['ar-EG', 'franco', 'en'] as const) expect(TASKS.filter((t) => t.lang === l && t.kind === 'write').length, l).toBeGreaterThanOrEqual(8);
    for (const k of ['shipping', 'otp', 'cod', 'eid', 'cart']) expect(TASKS.some((t) => t.id.startsWith(`tw-${k}-`)), k).toBe(true);
    expect(TASKS.filter((t) => t.kind === 'fix').length).toBeGreaterThanOrEqual(5);
    expect(new Set(TASKS.filter((t) => t.kind === 'fix').map((t) => t.seed!.reason)).size).toBeGreaterThanOrEqual(5);
  });
  it('every scripted draft already satisfies Meta\'s rules (a golden answer that fails the rules would grade nothing)', () => {
    for (const t of TASKS) expect(checkTemplate(t.scripted).filter((i) => i.severity === 'error'), t.id).toEqual([]);
  });
});

describe('final-state grading with the scripted writer (default CI)', () => {
  TASKS.forEach((task, i) => {
    it(`${task.id}`, async () => {
      expect(grade(task, await run(task, 7800 + i, 'scripted'))).toEqual([]);
    }, 30_000);
  });
});

describe('the grader catches a bad outcome (mutation controls)', () => {
  it('a wrong category, a second submission and a rename are each reported', () => {
    const t = TASKS.find((x) => x.id === 'tw-shipping-ar-EG')!;
    const ok = { stored: [{ name: 'order_shipped', language: 'ar', category: 'UTILITY', status: 'PENDING', label: 'x', components: JSON.stringify([{ type: 'BODY', text: 'أهلاً {{1}}، طلبك خرج للشحن النهارده.', example: { body_text: [['أحمد']] } }]) }], create: 1, edit: 0 };
    expect(grade(t, ok)).toEqual([]);
    expect(grade(t, { ...ok, stored: [{ ...ok.stored[0]!, category: 'MARKETING' }] }).join()).toContain('category');
    expect(grade(t, { ...ok, create: 2 }).join()).toContain('submissions');
    expect(grade(t, { ...ok, stored: [] })).toEqual(['no template in the workspace']);
    const f = TASKS.find((x) => x.kind === 'fix')!;
    expect(grade(f, { stored: [{ ...ok.stored[0]!, name: 'renamed', category: f.expect.category, language: 'ar' }], create: 1, edit: 1 }).join()).toMatch(/renamed|second template/);
  });
});

describe('real-model template golden run (SMART_LAYER_EVAL=1)', () => {
  it.skipIf(env.SMART_LAYER_EVAL !== '1')('pass@1 on every task, graded on final state', async () => {
    const ai = restAiBinding({ accountId: env.SL_EVAL_ACCOUNT_ID, apiToken: env.SL_EVAL_API_TOKEN });
    let passed = 0;
    const failures: Record<string, string[]> = {};
    let n = 7900;
    for (const task of TASKS) {
      const f = grade(task, await run(task, n++, ai));
      if (f.length) failures[task.id] = f; else passed++;
    }
    // eslint-disable-next-line no-console
    console.log(`SMART_LAYER_EVAL_TEMPLATES ${JSON.stringify({ at: Date.now(), tasks: TASKS.length, passed, passAt1: passed / TASKS.length, failures })}`);
    expect(passed / TASKS.length).toBeGreaterThanOrEqual(0.85);
  }, 3_600_000);
});
