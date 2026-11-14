import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { checkAdapterContract } from '../../foundation/smart-layer/eval/adapter-contract';
import type { TurnCtx } from '../../foundation/smart-layer/types';
import registryJson from '../../assistant/registry.generated.json';
import corpusJson from '../../assistant/help-corpus.generated.json';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import { chatControls, setPlatformFlag } from '../../src/core/smart-layer/controls';
import { HASH_KEY, IDS_KEY, ensureHelpIndex, helpFigureSources, helpSearch, type HelpCorpus, type HelpDeps } from '../../src/core/smart-layer/help-index';
import { chatQuota, holdRef } from '../../src/core/smart-layer/quota';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import { rpcStorage } from '../../src/core/smart-layer/storage-do';
import { ToolApiError, readTools, type CallApi } from '../../src/core/smart-layer/tools/read.tools';
import { HOLD_TTL_MS, creditsAvailable, grantCredits } from '../../src/core/ai/credits';
import { rows, workspace } from '../helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000072${String(n).padStart(2, '0')}`;
const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const CORPUS = corpusJson as unknown as HelpCorpus;
const ctx = (storeId: string, over: Partial<TurnCtx> = {}): TurnCtx => ({ product: 'chat', storeId, userId: 'u1', role: 'owner', locale: 'ar', now: 1_800_000_000_000, conversationId: 'c1', releaseId: 'r', ...over });
const noHelp: HelpDeps = { db: env.DB, vectors: undefined, embed: undefined };
const adapterFor = (storeId: string, callApi: CallApi = async () => ({ status: 200, json: {} })) =>
  chatAdapter({ env, ws: workspace(storeId), callApi, registry: REGISTRY, corpus: CORPUS, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } });

describe('adapter contract', () => {
  it('the tool list agrees with the capability registry (no weaker policy, every capability live, no forbidden tool)', () => {
    expect(checkAdapterContract(adapterFor(W(1)))).toEqual([]);
  });
  it('Phase A registers only free tools', () => {
    expect(adapterFor(W(2)).tools().filter((t) => t.policy !== 'free')).toEqual([]);
  });
  it('no tool lets the model name a store, a workspace, a path or a url (store scoping cannot be argued with)', () => {
    for (const t of adapterFor(W(3)).tools()) {
      const props = Object.keys((t.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => /store|workspace|path|url|id$/i.test(p)), t.name).toEqual([]);
    }
  });
  it('every read goes to the turn\'s own store and puts model text only in an encoded query value', async () => {
    const seen: Array<{ store: string; path: string; query?: Record<string, string> }> = [];
    const a = adapterFor(W(4), async (c, path, query) => { seen.push({ store: c.storeId, path, ...(query ? { query } : {}) }); return { status: 200, json: { items: [] } }; });
    const contacts = a.tools().find((t) => t.name === 'contacts_list')!;
    await contacts.read!(ctx(W(4)), { query: '../stores/other/wallet?x=1' });
    expect(seen).toEqual([{ store: W(4), path: '/contacts', query: { q: '../stores/other/wallet?x=1' } }]);
  });
  it('a route that answers 403 becomes a tool error carrying the status, never a result', async () => {
    const a = adapterFor(W(5), async () => ({ status: 403, json: { error: 'forbidden' } }));
    const t = a.tools().find((x) => x.name === 'numbers_overview')!;
    await expect(t.read!(ctx(W(5)), {})).rejects.toBeInstanceOf(ToolApiError);
  });
  it('wallet_view speaks EGP, not piasters', async () => {
    const a = adapterFor(W(6), async () => ({ status: 200, json: { balanceMinor: 12550, heldMinor: 0, availableMinor: 12550, debtMinor: 0, creditLimitMinor: 5000, lowBalance: false, lowBalanceThresholdMinor: 2000, topupsEnabled: true } }));
    expect(await a.tools().find((x) => x.name === 'wallet_view')!.read!(ctx(W(6)), {})).toMatchObject({ currency: 'EGP', balance: '125.5', overdraftLimit: '50' });
  });
  it('show_me_where finds the wallet screen from an Arabic and an English phrase', async () => {
    const t = readTools({ callApi: async () => ({ status: 200, json: {} }), helpSearch: async () => [], registry: REGISTRY, assistantCapability: 'assistant.ebda-assistant' }).find((x) => x.name === 'show_me_where')!;
    const ids = async (q: string) => ((await t.read!(ctx(W(7)), { query: q })) as Array<{ capabilityId: string }>).map((x) => x.capabilityId);
    expect((await ids('wallet balance')).length).toBeGreaterThan(0);
    expect((await ids('محفظة')).length).toBeGreaterThan(0);
  });
  it('a customer name from the inbox is untrusted: its result shrinks the offered tools to free ones', () => {
    const t = adapterFor(W(8)).tools();
    expect(t.find((x) => x.name === 'contacts_list')!.resultTrust).toBe('untrusted');
    expect(t.find((x) => x.name === 'inbox_window_status')!.resultTrust).toBe('untrusted');
    expect(t.find((x) => x.name === 'plan_status')!.resultTrust).toBe('typed-source');
  });
  it('binding sources carry the free cap, the 24-hour window and the figures the guides state', async () => {
    const s = await adapterFor(W(9)).bindingSources(ctx(W(9)));
    expect(s.find((x) => x.key === 'assistant-free-turns')!.values).toEqual(['150']);
    expect(s.find((x) => x.key === 'reply-window')!.values).toEqual(['24']);
    expect(s.some((x) => x.key.startsWith('help:'))).toBe(true);
  });
});

describe('controls', () => {
  it('a workspace is off until an operator sets it; the platform switches win and work without a deploy', async () => {
    const s = W(10);
    const ws = workspace(s);
    expect((await chatControls(env, ws)).mode).toBe('off');
    await ws.setAssistantMode('act');
    expect((await chatControls(env, ws)).mode).toBe('act');
    await setPlatformFlag(env, 'sl.global', { mode: 'answer-only' }, 'op');
    expect((await chatControls(env, ws)).mode).toBe('answer-only'); // the platform cap
    await setPlatformFlag(env, 'sl.global', { kill: true }, 'op');
    expect(await chatControls(env, ws)).toMatchObject({ mode: 'off', killGlobal: true });
    await setPlatformFlag(env, 'sl.global', {}, 'op');
    await setPlatformFlag(env, 'sl.product.chat', { kill: true }, 'op');
    expect(await chatControls(env, ws)).toMatchObject({ mode: 'off', killProduct: true });
    await setPlatformFlag(env, 'sl.product.chat', {}, 'op');
    await setPlatformFlag(env, 'sl.tools', ['wallet_view'], 'op');
    expect((await chatControls(env, ws)).killedTools.has('wallet_view')).toBe(true);
    await env.DB.prepare('DELETE FROM platform_flags').run();
  });
  it('an unreadable switch fails closed', async () => {
    const broken = { DB: { prepare: () => { throw new Error('d1 down'); } } } as unknown as typeof env;
    expect(await chatControls(broken, { assistantMode: async () => 'act' })).toMatchObject({ mode: 'off', killGlobal: true });
  });
});

describe('quota: free cap and heavy credits', () => {
  it('the 151st turn in a day is refused; another store is unaffected', async () => {
    const st = rpcStorage((op, args) => workspace(W(11)).smartLayer(op, args));
    const q = chatQuota(st, workspace(W(11)));
    for (let i = 0; i < 150; i++) await q.assertTurn(ctx(W(11), { now: 1_800_000_000_000 + i }));
    await expect(q.assertTurn(ctx(W(11), { now: 1_800_000_001_000 }))).rejects.toThrow('free_cap');
    await expect(chatQuota(rpcStorage((op, args) => workspace(W(12)).smartLayer(op, args)), workspace(W(12))).assertTurn(ctx(W(12)))).resolves.toBeUndefined();
  });
  it('a heavy job holds credits first, settles them on success (note assistant), and a hold that never settles frees itself', async () => {
    const s = W(13);
    const ws = workspace(s);
    const now = 1_800_000_000_000;
    await runInDurableObject(ws, (_i, state) => { grantCredits(state.storage.sql, { periodStart: now, packageId: 'p', credits: 10, now }); });
    const st = rpcStorage((op, args) => ws.smartLayer(op, args));
    const q = chatQuota(st, ws);
    const c1 = ctx(s, { conversationId: 'heavy1', now });
    await q.assertTurn(c1, 4);
    const avail = (at: number) => runInDurableObject(ws, (_i, state) => creditsAvailable(state.storage.sql, at));
    expect(await avail(now)).toBe(6);
    await q.record(c1, { inputTokens: 1, outputTokens: 1, model: 'm', heavyCredits: 4 });
    expect(await rows(s, "SELECT kind, amount, note FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ kind: 'ai_charge', amount: -4, note: 'assistant' }]);
    expect(await avail(now)).toBe(6);
    // failed turn: hold taken, never settled
    const c2 = ctx(s, { conversationId: 'heavy2', now: now + 1 });
    await q.assertTurn(c2, 5);
    expect(await avail(now + 1)).toBe(1);
    expect(await avail(now + 1 + HOLD_TTL_MS + 1)).toBe(6);
    // more than available is refused up front
    await expect(q.assertTurn(ctx(s, { conversationId: 'heavy3', now: now + 2 }), 50)).rejects.toThrow('no_credits');
    expect(holdRef(c1)).toBe(`sl:heavy1:${now}`);
  });
});

describe('help index', () => {
  const fake = () => {
    const upserts: Array<{ id: string; namespace?: string; metadata?: Record<string, string> }> = [];
    const deleted: string[] = [];
    const embedded: string[] = [];
    const deps: HelpDeps = {
      db: env.DB,
      embed: async (t) => { embedded.push(...t); return t.map(() => [0.1]); },
      vectors: {
        upsert: async (v: Array<{ id: string; namespace?: string; metadata?: Record<string, string> }>) => { upserts.push(...v); return { mutationId: 'm' }; },
        deleteByIds: async (ids: string[]) => { deleted.push(...ids); return { mutationId: 'm' }; },
        query: async () => ({ count: 2, matches: [
          { id: 'a', score: 0.8, metadata: { articleId: 'whatsapp/x', locale: 'en', title: 'X', url: 'https://help.ebda.app/whatsapp/x/', appPath: '', text: 'english' } },
          { id: 'b', score: 0.7, metadata: { articleId: 'whatsapp/x', locale: 'ar', title: 'س', url: 'https://help.ebda.app/whatsapp/x/', appPath: '/wallet', text: 'عربي' } },
        ] }),
      } as never,
    };
    return { deps, upserts, deleted, embedded };
  };
  const tiny: HelpCorpus = { hash: 'h1', docs: [{ articleId: 'whatsapp/a', locale: 'ar', title: 'أ', url: 'u', appPath: null, capabilityIds: [], chunks: [{ id: 'a:ar:0', text: 'one' }, { id: 'a:ar:1', text: 'two' }] }] };

  it('indexes once per corpus hash, skips when unchanged, re-indexes when it changes and deletes vectors of chunks that went away', async () => {
    await env.DB.prepare('DELETE FROM platform_flags WHERE key IN (?, ?)').bind(HASH_KEY, IDS_KEY).run();
    const f = fake();
    expect(await ensureHelpIndex(f.deps, tiny)).toBe('indexed');
    expect(f.upserts.map((u) => u.namespace)).toEqual(['__help__', '__help__']);
    expect(await ensureHelpIndex(f.deps, tiny)).toBe('skipped');
    expect(f.upserts.length).toBe(2);
    const shrunk: HelpCorpus = { hash: 'h2', docs: [{ ...tiny.docs[0]!, chunks: [tiny.docs[0]!.chunks[0]!] }] };
    expect(await ensureHelpIndex(f.deps, shrunk)).toBe('indexed');
    expect(f.deleted.length).toBe(1);
    await env.DB.prepare('DELETE FROM platform_flags WHERE key IN (?, ?)').bind(HASH_KEY, IDS_KEY).run();
  });
  it('reports unavailable (no throw) when no index or model is bound', async () => {
    expect(await ensureHelpIndex(noHelp, tiny)).toBe('unavailable');
    expect(await helpSearch(noHelp, 'q', 'ar', 3)).toEqual([]);
  });
  it('search embeds the MASKED question and returns only hits of the asked language', async () => {
    const f = fake();
    const hits = await helpSearch(f.deps, 'اتصل بيا على 01012345678', 'ar', 3);
    expect(f.embedded.join(' ')).not.toContain('01012345678');
    expect(hits.map((h) => h.text)).toEqual(['عربي']);
    expect(hits[0]).toMatchObject({ articleId: 'whatsapp/x', appPath: '/wallet' });
  });
  it('the bundled corpus has both languages and its help figures include the 24-hour window', () => {
    expect(new Set(CORPUS.docs.map((d) => d.locale))).toEqual(new Set(['ar', 'en']));
    expect(helpFigureSources(CORPUS).some((s) => s.values.includes('24'))).toBe(true);
  });
});
