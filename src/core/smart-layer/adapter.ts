/**
 * The Chat adapter for the Smart Layer engine (plan 4 Task A20). It holds no model logic: it wires the engine to this product's bindings
 * (Workers AI, Vectorize, the workspace Durable Object journal, D1 switches, the credits ledger) and to its own routes (every tool is an in-process
 * call of an existing route with the merchant's own session, SL-CHAT-1). Everything that calls Workers AI lives under `src/core/smart-layer/`
 * (the `smart-layer-bypass` guard allowlist).
 */
import { resolveModels } from '../../../foundation/smart-layer/models';
import type { AiBinding } from '../../../foundation/smart-layer/provider';
import type { BindingSource, SmartLayerAdapter, ToolSpec, TurnCtx } from '../../../foundation/smart-layer/types';
import { BUDGET } from '../../../foundation/smart-layer/plan/budget';
import type { Env } from '../../env';
import type { WorkspaceDO } from '../workspace-do';
import { chatControls } from './controls';
import { chatHandoff } from './handoff';
import { helpDeps, helpFigureSources, helpSearch, type HelpCorpus, type HelpDeps } from './help-index';
import { chatQuota } from './quota';
import { rpcStorage } from './storage-do';
import type { RegistryView } from '../../../foundation/smart-layer/types';
import { botTools } from './tools/bot.tools';
import { campaignTools } from './tools/campaigns.tools';
import { withKeywords } from './tools/keywords';
import { WorkersAiProvider } from '../../../foundation/smart-layer/provider';
import { contactTools } from './tools/contacts.tools';
import { inboxTools } from './tools/inbox.tools';
import { readTools, type CallApi } from './tools/read.tools';
import type { Kit } from './tools/write';
import { segmentTools } from './tools/segments.tools';
import { templateTools } from './tools/templates.tools';

export type ChatAdapterDeps = {
  env: Env;
  ws: DurableObjectStub<WorkspaceDO>;
  callApi: CallApi;
  /** The capability registry and the help corpus the product bundled (see assistant/*.generated.json), and the id of the assistant's own capability. */
  registry: RegistryView;
  corpus: HelpCorpus;
  assistantCapability: string;
  /** Overrides for tests (a scripted model needs none of them). */
  help?: HelpDeps;
  ai?: AiBinding;
};

const egp = (minor: number): string => String(Math.round(minor) / 100);

export function chatAdapter(d: ChatAdapterDeps): SmartLayerAdapter {
  const help = d.help ?? helpDeps(d.env);
  const storage = rpcStorage((op, args) => d.ws.smartLayer(op, args));
  const searchHelp = (q: string, locale: TurnCtx['locale'], k: number) => helpSearch(help, q, locale, k);
  const ai = d.ai ?? (d.env.AI as unknown as AiBinding | undefined) ?? { run: async () => { throw new Error('no AI binding'); } };
  const models = resolveModels();
  const kit: Kit = {
    callApi: d.callApi, find: (n) => tools.find((t) => t.name === n),
    writer: {
      // One call on the `template` job; the merchant's text is fenced by the writer, the answer is parsed and checked by the templates service before anyone sees it.
      complete: async (system, user) => (await new WorkersAiProvider(ai, models.template).complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 1400, model: models.template })).text ?? '',
      cache: { get: async (key) => ((await d.ws.smartLayer('cacheGet', [key, Date.now()])) as string | null), put: async (key, json) => { await d.ws.smartLayer('cachePut', [key, key.split(':')[0], json, Date.now()]); } },
      credits: { hold: (ref, n) => d.ws.assistantHold(ref, n), settle: (ref) => d.ws.assistantSettle(ref), release: (ref) => d.ws.assistantRelease(ref) },
    },
  };
  const tools: ToolSpec[] = [
    ...readTools({ callApi: d.callApi, helpSearch: searchHelp, registry: d.registry, assistantCapability: d.assistantCapability }),
    ...[...inboxTools(kit), ...contactTools(kit), ...segmentTools(kit), ...botTools(kit), ...campaignTools(kit), ...templateTools(kit)].map(withKeywords),
  ];
  return {
    product: 'chat',
    registry: () => d.registry,
    tools: () => tools,
    helpSearch: searchHelp,
    async bindingSources(): Promise<BindingSource[]> {
      // Typed sources for the binding-claim rail: the packages the Plans screen sells, the free cap, the 24-hour window, and the figures the help guides state.
      const pk = await d.env.DB.prepare('SELECT id, name, price_minor, ai_credits FROM packages WHERE active = 1').all<{ id: string; name: string; price_minor: number; ai_credits: number }>();
      return [
        ...pk.results.map((p): BindingSource => ({ kind: 'plan', key: p.id, text: { ar: p.name, en: p.name }, values: [p.name, egp(p.price_minor), String(p.ai_credits)] })),
        { kind: 'limit', key: 'assistant-free-turns', text: { ar: 'رسايل المساعد المجانية في اليوم', en: 'Free assistant messages per day' }, values: [String(BUDGET.freeTurnsPerStorePerDay)] },
        { kind: 'limit', key: 'reply-window', text: { ar: 'نافذة الرد 24 ساعة', en: '24-hour reply window' }, values: ['24'] },
        ...helpFigureSources(d.corpus),
      ];
    },
    // Chat shows no merchant-owned web pages: only the platform's own hosts are linkable.
    merchantDomains: async () => [],
    controls: () => chatControls(d.env, d.ws),
    quota: chatQuota(storage, d.ws),
    // Phase A tools take no ids from the model, so nothing needs an existence check. An id-taking tool (Phase B) must supply its own kind here: until it does, every ref fails closed.
    checkRefs: async (_ctx, refs) => ({ missing: [...refs] }),
    handoff: chatHandoff(),
    secureScreen: (kind) => ({ meta_token: 'numbers.connect', api_key: 'agent.provider-byok', card: 'wallet.card-topup', jwt: 'access.integrator-tokens' } as Partial<Record<typeof kind, string>>)[kind] ?? null,
    ai,
    models,
    storage,
  };
}
