import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { BOUNDARY, MAX_MODEL_CALLS_PER_CREDIT } from '../src/core/ai/agent';
import { DEFAULT_WORKERS_AI_MODEL } from '../src/core/ai/config';
import { modelPrices } from '../src/core/ai/cost';
import { GPT_OSS_MODEL, LANGUAGE_RETRY_NOTE, isArabicScriptReply, looksEnglishAsk, readAgentModelFlag, whatsappFormat } from '../src/core/ai/model-flag';
import { configureSessionCheck } from '../src/core/identity/session';
import { Trusted, guardReply } from '../src/core/ai/reply-guard';
import { findUrls, linkParts } from '../src/core/url-extract';
import { configureAgent, type AgentCopy } from '../src/core/ai/config';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { OP1, operatorCall, storeId, tokenFor, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000097${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const flip = (m: string | null) => operatorCall(OP1, 'PUT', '/agent/model', { model: m, reason: 'live eval looked good' });
const agentWs = async (ws: string, settings: Record<string, unknown> = {}) => {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};
const credits = async (ws: string) => (await workspace(ws).getAgentSettings()).credits;

beforeEach(async () => { configureSessionCheck(async () => false); await env.DB.prepare("DELETE FROM platform_flags WHERE key = 'agent.model'").run(); });
afterEach(() => configureSessionCheck(null));

describe('the flag: allow-list, authorization, audit', () => {
  it('accepts exactly the two ids and null; any other id is a 400 and nothing is stored', async () => {
    expect((await flip(GPT_OSS_MODEL)).status).toBe(200);
    expect(await readAgentModelFlag(env)).toBe(GPT_OSS_MODEL);
    expect((await flip(DEFAULT_WORKERS_AI_MODEL)).status).toBe(200);
    expect(await readAgentModelFlag(env)).toBe(DEFAULT_WORKERS_AI_MODEL);
    for (const bad of ['@cf/meta/llama-3.1-8b-instruct', 'gpt-4o', '', '@cf/openai/gpt-oss-20b']) {
      const r = await flip(bad);
      expect(r.status, bad).toBe(400);
    }
    expect(await readAgentModelFlag(env)).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect((await operatorCall(OP1, 'PUT', '/agent/model', { model: GPT_OSS_MODEL, reason: 'ok', extra: 1 })).status).toBe(400); // strict + reason too short
    expect((await flip(null)).status).toBe(200); // null clears it
    expect(await readAgentModelFlag(env)).toBeNull();
  });

  it('a change needs a reason and is audited with actor, before, after and the reason', async () => {
    expect((await operatorCall(OP1, 'PUT', '/agent/model', { model: GPT_OSS_MODEL })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', '/agent/model', { model: GPT_OSS_MODEL, reason: 'abc' })).status).toBe(400);
    expect(await readAgentModelFlag(env)).toBeNull();
    expect((await flip(GPT_OSS_MODEL)).status).toBe(200);
    const row = await env.DB.prepare("SELECT b.actor, b.before_json, b.after_json, r.reason FROM billing_audit b JOIN audit_reasons r ON r.id = b.reason_id WHERE b.action = 'agent_model_set'").first<{ actor: string; before_json: string; after_json: string; reason: string }>();
    expect(row).toMatchObject({ before_json: '{"model":null}', after_json: `{"model":"${GPT_OSS_MODEL}"}`, reason: 'live eval looked good' });
    expect(row!.actor.length).toBeGreaterThan(0);
  });

  it('only a super admin can read or set it: a store owner, staff and no token are refused', async () => {
    const ws = storeId(9701);
    for (const role of ['owner', 'staff'] as const) {
      const h = { authorization: `Bearer ${await tokenFor(ws, 600, role)}`, 'content-type': 'application/json' };
      expect((await SELF.fetch('https://x/api/v1/operator/agent/model', { method: 'PUT', headers: h, body: JSON.stringify({ model: GPT_OSS_MODEL, reason: 'let me in please' }) })).status, role).toBe(403);
      expect((await SELF.fetch('https://x/api/v1/operator/agent/model', { headers: h })).status, role).toBe(403);
    }
    expect((await operatorCall(null, 'PUT', '/agent/model', { model: GPT_OSS_MODEL, reason: 'no token at all' })).status).toBe(401);
    expect(await readAgentModelFlag(env)).toBeNull();
    expect(await (await operatorCall(OP1, 'GET', '/agent/model')).json()).toMatchObject({ model: null, default: DEFAULT_WORKERS_AI_MODEL, allowed: [DEFAULT_WORKERS_AI_MODEL, GPT_OSS_MODEL] });
  });

  it('an unrecognised stored value reads as the default (never the new model)', async () => {
    await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at, updated_by) VALUES ('agent.model', ?, 1, 'x')").bind('"@cf/other/model"').run();
    expect(await readAgentModelFlag(env)).toBeNull();
    await env.DB.prepare("UPDATE platform_flags SET value = '{not json' WHERE key = 'agent.model'").run();
    expect(await readAgentModelFlag(env)).toBeNull();
  });
});

describe('default unchanged', () => {
  it('unset: same prompt as the addon writes without the flag, no model id on the request, the reply is sent byte for byte (Markdown included)', async () => {
    const ws = W(1);
    const pn = await agentWs(ws, { persona: 'انت مساعد متجر الورد. المنيو https://shop.example/menu' });
    const md = '**أهلاً** بيك!\n- ورد بلدي\n[المنيو](https://shop.example/menu)';
    const m = model([{ text: md }]);
    let seen: Parameters<AgentCopy['systemPrompt']>[0] | null = null;
    const prev = configureAgent({ copy: { ...EBDA_AGENT_COPY, systemPrompt: (a) => { seen ??= a; return EBDA_AGENT_COPY.systemPrompt(a); } } });
    const g = stubGraph();
    const out = await say(ws, pn, text('مساء الخير'), g);
    configureAgent(prev);
    const req = m.calls[0]!;
    expect(req).not.toHaveProperty('model');
    expect(req.system).not.toContain('Style rules (strict)');
    expect(seen).not.toBeNull();
    expect(seen).not.toHaveProperty('strict'); // the addon is called exactly as before the flag existed
    expect(req.system).toBe(`${EBDA_AGENT_COPY.systemPrompt(seen!)}\n\n${BOUNDARY}`);
    expect(out.map((s) => s.text)).toEqual([md]); // Markdown untouched
    expect(await credits(ws)).toBe(999);
  });

  it('the addon prompt without `strict` equals the prompt with strict:false, and strict only appends', () => {
    const a = { persona: 'p', language: 'auto' as const, tone: 'warm' as const, storeName: 'S', knowledge: ['k'], tools: ['t'], facts: null, customer: null, faq: null };
    expect(EBDA_AGENT_COPY.systemPrompt({ ...a, strict: false })).toBe(EBDA_AGENT_COPY.systemPrompt(a));
    const strict = EBDA_AGENT_COPY.systemPrompt({ ...a, strict: true });
    expect(strict).not.toBe(EBDA_AGENT_COPY.systemPrompt(a));
    expect(strict).toContain('قريبًا');
    expect(strict).toContain('الـ توصيل');
    expect(strict).toContain('no Markdown');
  });

  it('strict block: never echo the customer\'s own amount, hand complaints over at once; the default prompt has neither (gpt-oss restated budgets and was guard-blocked)', () => {
    const a = { persona: 'p', language: 'auto' as const, tone: 'warm' as const, storeName: 'S', knowledge: [], tools: ['handoff_to_human'], facts: null, customer: null, faq: null };
    const strict = EBDA_AGENT_COPY.systemPrompt({ ...a, strict: true });
    expect(strict).toContain('Never repeat or confirm an amount the CUSTOMER wrote');
    expect(strict).toContain('within your budget');
    expect(strict).toContain('Wrong: "Here are gifts under 600 EGP"');
    expect(strict).toContain('ONE short sentence with no amount and no link');
    expect(strict).toContain('Franco-Arabic');
    expect(strict).toContain('is ARABIC: answer it in Arabic script');
    expect(strict).toContain('A request for a discount');
    expect(strict).toContain('Western digits (0-9)');
    expect(strict).toContain('A complaint is handed to a person at once with handoff_to_human');
    const plain = EBDA_AGENT_COPY.systemPrompt(a);
    expect(plain).not.toContain('CUSTOMER wrote');
    expect(plain).not.toContain('Franco-Arabic (Arabic typed');
    expect(plain).not.toContain('Western digits');
    expect(plain).not.toContain('A complaint is handed');
  });

  it('the reply guard is NOT loosened: a restated customer budget or an invented price is still refused, a tool price is accepted', () => {
    const t = new Trusted();
    t.prices.add(250);
    expect(guardReply('Silk scarf 250 EGP', t)).toEqual({ ok: true });
    expect(guardReply('Here are gifts under 600 EGP', t)).toMatchObject({ ok: false, reason: 'price' });
    expect(guardReply('Silk scarf 199 EGP', t)).toMatchObject({ ok: false, reason: 'price' });
  });

  it('cost: the default model keeps the existing prices; the flagged model has its own and is unknown (not the default price) when unset', () => {
    const e = { AI_PRICE_INPUT_USD_PER_M: '0.293', AI_PRICE_OUTPUT_USD_PER_M: '2.253' };
    expect(modelPrices(e)).toEqual({ inputUsdPerM: 0.293, outputUsdPerM: 2.253 });
    expect(modelPrices(e, DEFAULT_WORKERS_AI_MODEL)).toEqual({ inputUsdPerM: 0.293, outputUsdPerM: 2.253 });
    expect(modelPrices(e, GPT_OSS_MODEL)).toBeNull();
    expect(modelPrices({ ...e, AI_PRICE_INPUT_USD_PER_M_GPT_OSS: '0.1', AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS: '0.5' }, GPT_OSS_MODEL)).toEqual({ inputUsdPerM: 0.1, outputUsdPerM: 0.5 });
  });
});

describe('flipped to gpt-oss-120b, and back', () => {
  it('passes the model id, strips Markdown before the guard (a vouched link survives), adds the strict block; flipping back restores everything', async () => {
    const ws = W(2);
    const pn = await agentWs(ws, { persona: 'انت مساعد متجر الورد. المنيو https://shop.example/menu' });
    expect((await flip(GPT_OSS_MODEL)).status).toBe(200);
    const m = model([{ text: '**أهلاً** بيك!\n- ورد بلدي\n- ورد جوري\n[المنيو](https://shop.example/menu)' }]);
    const out = await say(ws, pn, text('مساء الخير'), stubGraph());
    expect(m.calls[0]!.model).toBe(GPT_OSS_MODEL);
    expect(m.calls[0]!.system).toContain('Style rules (strict)');
    expect(out.map((s) => s.text)).toEqual(['*أهلاً* بيك!\n• ورد بلدي\n• ورد جوري\nالمنيو https://shop.example/menu']); // not blocked by the guard
    expect(await credits(ws)).toBe(999);

    expect((await flip(null)).status).toBe(200);
    const m2 = model([{ text: '**تمام**' }]);
    const out2 = await say(ws, pn, text('تاني'), stubGraph());
    expect(m2.calls[0]).not.toHaveProperty('model');
    expect(m2.calls[0]!.system).not.toContain('Style rules (strict)');
    expect(out2.map((s) => s.text)).toEqual(['**تمام**']);
  });

  it('explicitly setting the current default id sends that id but turns the new behaviour OFF', async () => {
    const ws = W(3);
    const pn = await agentWs(ws);
    await flip(DEFAULT_WORKERS_AI_MODEL);
    const m = model([{ text: '**x**' }]);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(m.calls[0]!.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(m.calls[0]!.system).not.toContain('Style rules (strict)');
    expect(out.map((s) => s.text)).toEqual(['**x**']);
  });

  it('a workspace with its own model key is never touched by the flag', async () => {
    const ws = W(4);
    const pn = await agentWs(ws);
    await flip(GPT_OSS_MODEL);
    agent.model = new ScriptedProvider([{ text: '**x**' }], true);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect((agent.model as ScriptedProvider).calls[0]).not.toHaveProperty('model');
    expect(out.map((s) => s.text)).toEqual(['**x**']);
  });
});

describe('reply language (flagged path, language auto)', () => {
  const ar = 'أهلاً بيك، عندنا ورد بلدي';
  const en = 'Hi! Yes, we have local roses.';
  it('an English ask answered in Arabic gets ONE corrective call (tools off, same model, no second credit), and the English reply is sent', async () => {
    const ws = W(5);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    const m = model([{ text: ar }, { text: en }]);
    const out = await say(ws, pn, text('do you have roses?'), stubGraph());
    expect(m.callCount).toBe(2);
    expect(m.calls[1]!.tools).toEqual([]);
    expect(m.calls[1]!.model).toBe(GPT_OSS_MODEL);
    expect(m.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: LANGUAGE_RETRY_NOTE });
    expect(m.calls[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: ar });
    expect(out.map((s) => s.text)).toEqual([en]);
    expect(await credits(ws)).toBe(999); // one credit for the turn
  });

  it('never loops: still Arabic after the retry is sent as is (2 calls max); a failing retry keeps the first reply', async () => {
    const ws = W(6);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    const m = model([{ text: ar }, { text: ar }]);
    expect((await say(ws, pn, text('do you have roses?'), stubGraph())).map((s) => s.text)).toEqual([ar]);
    expect(m.callCount).toBe(2);
    const m2 = model([{ text: ar }, { fail: new Error('boom') }]);
    expect((await say(ws, pn, text('and tulips?'), stubGraph())).map((s) => s.text)).toEqual([ar]);
    expect(m2.callCount).toBe(2);
  });

  it('an Arabic (or Franco) ask is never retried, nor is an English one with an English reply, nor is language ar/en, nor the default model', async () => {
    const ws = W(7);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    let m = model([{ text: ar }]);
    await say(ws, pn, text('عندكم ورد؟'), stubGraph());
    expect(m.callCount).toBe(1);
    m = model([{ text: ar }]);
    await say(ws, pn, text('3ayez ward'), stubGraph());
    expect(m.callCount).toBe(1);
    m = model([{ text: en }]);
    await say(ws, pn, text('any roses?'), stubGraph());
    expect(m.callCount).toBe(1);
    await workspace(ws).setAgentSettings({ language: 'ar' });
    m = model([{ text: ar }]);
    await say(ws, pn, text('do you have tulips?'), stubGraph());
    expect(m.callCount).toBe(1);
    await workspace(ws).setAgentSettings({ language: 'auto' });
    await flip(null);
    m = model([{ text: ar }]);
    await say(ws, pn, text('do you have lilies?'), stubGraph());
    expect(m.callCount).toBe(1);
  });

  it('stays inside the per-credit call budget: no retry when the answer is already the last allowed call', async () => {
    const ws = W(8);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    const tool = { tools: [{ name: 'order_status', arguments: {} }] };
    const m = model([tool, tool, tool, { text: ar }]); // 3 tool rounds, then the last answer = MAX_MODEL_CALLS_PER_CREDIT calls
    const out = await say(ws, pn, text('where is my order?'), stubGraph());
    expect(m.callCount).toBeLessThanOrEqual(MAX_MODEL_CALLS_PER_CREDIT);
    expect(out.length).toBe(1);
  });

  it('a Latin-script ask the Franco heuristic misses is NOT treated as English: the Arabic reply stands, no correction (it was being rewritten into English)', async () => {
    const ws = W(9);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    for (const ask of ['fe shanta gel bony?', 'el COD mota7?', 'ektebly code python']) {
      const m = model([{ text: ar }, { text: en }]);
      const out = await say(ws, pn, text(ask), stubGraph());
      expect(m.callCount, ask).toBe(1);
      expect(out.map((x) => x.text), ask).toEqual([ar]);
    }
  });

  it('looksEnglishAsk: Latin only, not Franco, with a common English word', () => {
    for (const t of ['do you have roses?', 'I need a gift under 600 EGP', 'any gift ideas for my dad around 350?', 'hello', 'Hi there', 'birthday present for a friend, nothing over 250 please']) expect(looksEnglishAsk(t), t).toBe(true);
    for (const t of ['fe shanta gel bony?', 'el COD mota7?', 'ektebly code python', '3ayez fostan a7mar', 'عندكم ورد؟', '', null, 'bekam el shanta', 'hodoom']) expect(looksEnglishAsk(t as string), String(t)).toBe(false);
  });

  it('isArabicScriptReply: majority script decides; a quoted Arabic name in English does not count', () => {
    expect(isArabicScriptReply('أهلاً بيك')).toBe(true);
    expect(isArabicScriptReply('Hello, we sell "ورد" and tulips')).toBe(false);
    expect(isArabicScriptReply('123 ???')).toBe(false);
  });
});

describe('whatsappFormat', () => {
  const cases: [string, string, string][] = [
    ['bold', '**Total** is 100', '*Total* is 100'],
    ['bold, Arabic', 'ده **المنتج** الجديد', 'ده *المنتج* الجديد'],
    ['two bolds on a line', '**a** and **b**', '*a* and *b*'],
    ['triple', '***x***', '*x*'],
    ['single star bold is kept', 'it is *great* today', 'it is *great* today'],
    ['italic underscore kept', 'it is _soft_', 'it is _soft_'],
    ['strike', '~~old~~ new', '~old~ new'],
    ['heading', '# Title\n## Sub\ntext', 'Title\nSub\ntext'],
    ['heading, Arabic', '### المنتجات', 'المنتجات'],
    ['hash that is not a heading', 'order #123 now', 'order #123 now'],
    ['dash bullets', '- one\n- two', '• one\n• two'],
    ['star bullets', '* one\n* two', '• one\n• two'],
    ['plus bullets', '+ one', '• one'],
    ['bullets, Arabic RTL', '- ورد بلدي\n- ورد جوري', '• ورد بلدي\n• ورد جوري'],
    ['indented bullet', 'a\n  - nested', 'a\n  • nested'],
    ['bold bullet', '* **Rose**: 50', '• *Rose*: 50'],
    ['a dash inside a line is not a bullet', 'blue - 50 EGP', 'blue - 50 EGP'],
    ['a negative or range is not a bullet', '-5 degrees', '-5 degrees'],
    ['numbered list kept', '1. one\n2. two', '1. one\n2. two'],
    ['link', 'see [the menu](https://shop.example/menu) now', 'see the menu https://shop.example/menu now'],
    ['link, Arabic label', '[المنيو](https://shop.example/menu)', 'المنيو https://shop.example/menu'],
    ['link whose label is the url', '[https://a.example/x](https://a.example/x)', 'https://a.example/x'],
    ['link with a title', '[t](https://a.example/x "hi")', 't https://a.example/x'],
    ['link without scheme', '[call](wa.me/201001234567)', 'call wa.me/201001234567'],
    ['image', '![logo](https://a.example/l.png)', 'logo https://a.example/l.png'],
    ['bare url kept', 'visit https://a.example/p?x=1&y=2 today', 'visit https://a.example/p?x=1&y=2 today'],
    ['bold around a url', '**https://a.example/x**', '*https://a.example/x*'],
    ['url with underscores and stars-free', 'https://a.example/a__b__c', 'https://a.example/a__b__c'],
    ['url with double star inside the query is untouched', 'https://a.example/?q=**x**', 'https://a.example/?q=**x**'],
    ['url followed by arabic punctuation', 'الرابط https://a.example/x، تمام', 'الرابط https://a.example/x، تمام'],
    ['rule removed', 'a\n---\nb', 'a\nb'],
    ['blank lines collapse', 'a\n\n\n\nb', 'a\n\nb'],
    ['crlf', 'a\r\n- b', 'a\n• b'],
    ['plain Arabic untouched', 'تمام يا فندم، هبعتلك الطلب النهارده', 'تمام يا فندم، هبعتلك الطلب النهارده'],
    ['plain English untouched', 'Thanks! We deliver in 2 days.', 'Thanks! We deliver in 2 days.'],
    ['emoji untouched', 'تمام 🙏 **شكرا**', 'تمام 🙏 *شكرا*'],
    ['mixed RTL + LTR', '- **iPhone 15** سعره 50000 جنيه', '• *iPhone 15* سعره 50000 جنيه'],
    ['unbalanced stars left alone', '2 ** 3 and ** x', '2 ** 3 and ** x'],
    ['empty', '', ''],
  ];
  it.each(cases)('%s', (_n, input, output) => { expect(whatsappFormat(input)).toBe(output); });

  it('is idempotent', () => {
    for (const [, input] of cases) expect(whatsappFormat(whatsappFormat(input))).toBe(whatsappFormat(input));
  });

  it('keeps every URL the reply guard would see, exactly', () => {
    const md = '# عنوان\n- [المنتج](https://shop.example/p/1)\n- **سعر:** 100 جنيه، [الدفع](https://pay.example/c?id=7&x=y)\nاتصل: [wa](https://wa.me/201001234567).';
    const urlsOf = (s: string) => findUrls(s).flatMap((u) => { const p = linkParts(u); return p ? [`${p.host}${p.path}`] : []; }).sort(); // what the guard compares
    expect(urlsOf(whatsappFormat(md))).toEqual(urlsOf(md));
  });
});
