import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import registryJson from '../assistant/registry.generated.json';
import corpusJson from '../assistant/help-corpus.generated.json';
import { chatAdapter } from '../src/core/smart-layer/adapter';
import type { HelpCorpus, HelpDeps } from '../src/core/smart-layer/help-index';
import { viewOf, type StoredCap } from '../src/core/smart-layer/registry';
import { NEEDS_STORE } from '../src/core/smart-layer/store-tools';
import { workspace } from './helpers/workspace';

// CHAT-SA-5: the assistant of a standalone workspace is not offered a tool whose route answers `store_link_off`.
const SW = 'sw_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const STORE = '00000000-0000-4000-8000-000000007301';
const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const noHelp: HelpDeps = { db: env.DB, vectors: undefined, embed: undefined };
const adapter = (id: string, withId = true) => chatAdapter({ env, ws: workspace(id), ...(withId ? { workspaceId: id } : {}), callApi: async () => ({ status: 200, json: {} }), registry: REGISTRY, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } });

/** A capability is Store-coupled when one of its routes reads or writes the Store link, the orders pane, COD outcomes or product recommendations. */
const COUPLED = /\/store-link\b|\/proactive-recs|cod-outcome|\/contacts\/:waId\/orders\b/;
const capabilityFiles = import.meta.glob('../capabilities/*.capability.json', { eager: true, import: 'default' }) as Record<string, { id: string; api?: string[] }>;
const coupledCapabilities = (): Set<string> => new Set(Object.values(capabilityFiles).filter((c) => (c.api ?? []).some((a) => COUPLED.test(a))).map((c) => c.id));

describe('Smart Layer tools for a standalone workspace', () => {
  const all = adapter(STORE).tools();
  const names = new Set(all.map((t) => t.name));

  it('a Store workspace (and an adapter given no workspace id) is offered every tool: nothing changes for Store merchants', () => {
    expect(adapter(STORE, false).tools().length).toBe(all.length);
    expect(adapter(SW, false).tools().length).toBe(all.length); // no id = no filtering (the route always passes it)
    for (const n of NEEDS_STORE) expect(names.has(n), n).toBe(true);
  });

  it('a standalone workspace is offered none of the Store-coupled tools, and still the rest', () => {
    const sw = adapter(SW).tools();
    expect(sw.filter((t) => NEEDS_STORE.has(t.name)).map((t) => t.name)).toEqual([]);
    expect(sw.length).toBe(all.length - NEEDS_STORE.size);
    for (const keep of ['send_text', 'campaign_draft', 'contacts_list', 'wallet_view', 'plan_status', 'numbers_overview', 'template_write']) expect(sw.some((t) => t.name === keep), keep).toBe(true);
  });

  it('coverage: every tool whose capability calls a Store-coupled route is declared in NEEDS_STORE, and every declared name is a real tool', () => {
    const coupled = coupledCapabilities();
    expect(coupled.size).toBeGreaterThan(8);
    const missing = all.filter((t) => coupled.has(t.capabilityId) && !NEEDS_STORE.has(t.name)).map((t) => `${t.name} (${t.capabilityId})`);
    expect(missing, 'tools that call a Store route but are offered to standalone workspaces (add to src/core/smart-layer/store-tools.ts)').toEqual([]);
    expect([...NEEDS_STORE].filter((n) => !names.has(n)), 'stale entries').toEqual([]);
  });
});
