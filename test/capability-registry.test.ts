// Node project (uses fs): registry rules, help linkage over the guide SOURCES, Smart Layer bypass over src, web/src and wrangler.jsonc.
// The route/page/self-service guards run in the workers project (test/capability-routes.test.ts). Scopes stay with route-decisions.test.ts and
// integrator-tokens.test.ts: those own scopes, these own capabilities.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRegistry } from '../foundation/capability-registry';
import { checkHelp, toHelpArticle, type HelpArticle } from '../foundation/help-article';
import { checkModelBypass } from '../foundation/smart-layer-bypass';
import { guardConfig, idsOf, judge, loadBaseline, loadRegistry } from './helpers/capability-guard';

const ROOT = join(import.meta.dirname, '..');
const { entries, violations } = loadRegistry();

/** docs/help/{ar,en}/NN-<slug>.md -> HelpArticle slug `whatsapp/<slug>` (the Store import publishes it under that slug). */
function guideArticles(): HelpArticle[] {
  return (['ar', 'en'] as const).flatMap((lang) =>
    readdirSync(join(ROOT, 'docs/help', lang))
      .filter((f) => /^\d\d-.+\.md$/.test(f))
      .map((f) => toHelpArticle(`whatsapp/${f.replace(/^\d\d-/, '').replace(/\.md$/, '')}`, lang, readFileSync(join(ROOT, 'docs/help', lang, f), 'utf8'))),
  );
}

function bypassFiles(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.wrangler', 'coverage'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.[cm]?[jt]sx?$/.test(name)) out.push({ path: relative(ROOT, p), src: readFileSync(p, 'utf8') });
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'web/src'));
  out.push({ path: 'wrangler.jsonc', src: readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8') });
  return out;
}

describe('capability registry rules (lens 192)', () => {
  it('loads every seeded capability', () => {
    expect(entries.length).toBe(181); // + templates.check-draft (Smart Layer template tools) + assistant.apply-changes (Smart Layer apply/undo) + operator.assistant-controls (Smart Layer assistant) + wallet.yearly-refund-request (money surfaces) + operator.instapay-auto-confirm (InstaPay auto-confirm); 172 seeded + templates.shared-list, templates.shared-request, templates.shared-number-marketing, operator.shared-template-requests
  });
  it('has no new registry violation and no stale baseline id', () => {
    expect(judge('registry', violations).failures).toEqual([]);
  });
  it('the registry baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(violations));
    expect(loadBaseline('registry').filter((id) => !current.has(id))).toEqual([]);
  });
  it('a deliberately broken entry fails (mutation proof)', () => {
    const broken = { ...(entries[0] as object), policy: 'free', api: ['POST /stores/:storeId/x'] };
    const r = checkRegistry([{ name: `${entries[0]!.id}.capability.json`, json: broken }], guardConfig);
    expect(r.violations.map((v) => v.rule)).toContain('policy-free-writes');
  });
});

describe('templates self-service registry entries (plan 2 task 13)', () => {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id)!;
  const WRITES = ['templates.create-submit', 'templates.edit-delete', 'templates.install-defaults', 'templates.shared-request'];
  it('every template write is confirm + irreversible and live; reads and the sync are free', () => {
    for (const id of WRITES) expect([id, get(id).status, get(id).policy, get(id).undo.class]).toEqual([id, 'live', 'confirm', 'irreversible']);
    for (const id of ['templates.list', 'templates.sync', 'templates.shared-list', 'templates.starter-on-connect', 'templates.shared-number-marketing']) expect([id, get(id).status, get(id).policy]).toEqual([id, 'live', 'free']);
  });
  it('the sync is a free read-only POST that names exactly its own route and nothing else', () => {
    const s = get('templates.sync');
    expect(s.api).toEqual(['POST /stores/:storeId/templates/sync']);
    expect(s.readOnlyPost?.routes).toEqual(['POST /stores/:storeId/templates/sync']);
    expect(s.undo.class).toBe('none');
  });
  it('the guard config excuses only the sync and the draft check (both send nothing): every other templates POST still needs confirm (mutation proof)', () => {
    const entry = (api: string[], readOnly?: string[]) => ({ ...(get('templates.sync') as object), api, ...(readOnly ? { readOnlyPost: { routes: readOnly, reason: 'x' } } : { readOnlyPost: undefined }) });
    const run = (api: string[], readOnly?: string[]) => checkRegistry([{ name: 'templates.sync.capability.json', json: entry(api, readOnly) }], guardConfig).violations.map((v) => v.rule);
    expect(run(['POST /stores/:storeId/templates/sync'], ['POST /stores/:storeId/templates/sync'])).toEqual([]);
    // Ruling CHAT-SL-D1-1: the draft check runs Meta's rules on our side (no Meta call, no store), so it is free like the sync; it must still DECLARE itself read-only.
    expect(run(['POST /stores/:storeId/templates/check'], ['POST /stores/:storeId/templates/check'])).toEqual([]);
    expect(run(['POST /stores/:storeId/templates/check'])).toContain('policy-free-writes');
    expect(run(['POST /stores/:storeId/templates'], ['POST /stores/:storeId/templates'])).toContain('policy-must-confirm');
    expect(run(['POST /stores/:storeId/templates/sync', 'POST /stores/:storeId/templates'], ['POST /stores/:storeId/templates/sync'])).toEqual(expect.arrayContaining(['policy-free-writes', 'policy-must-confirm']));
    expect(run(['POST /stores/:storeId/templates/sync', 'DELETE /stores/:storeId/templates/:name/:language'], ['POST /stores/:storeId/templates/sync'])).toContain('policy-free-writes');
  });
  it('the operator request list is forbidden to the assistant with a valid platform reason, and shared-catalogue now has one too', () => {
    for (const id of ['operator.shared-template-requests', 'templates.shared-catalogue', 'operator.shared-templates']) {
      expect([id, get(id).policy, get(id).operatorReason?.code, get(id).operatorReason?.validUnderRule]).toEqual([id, 'forbidden', 'platform-config', true]);
    }
  });
  it('every live merchant templates entry links a guide that exists in both languages and lists it at the registry version', () => {
    const arts = guideArticles();
    for (const e of entries.filter((x) => x.area === 'templates' && x.status === 'live' && x.roles.includes('owner') && x.id !== 'templates.status-webhook' /* a system hook: its missing guide is baselined debt */)) {
      expect(e.helpArticle, e.id).toBeTruthy();
      for (const lang of ['ar', 'en'] as const) {
        const a = arts.find((x) => x.slug === e.helpArticle && x.lang === lang);
        expect(a?.capabilities.find((c) => c.id === e.id)?.version, `${e.id}/${lang}`).toBe(e.version);
        expect(a?.appPath, `${e.id}/${lang}`).toBe('/templates');
      }
    }
  });
});

describe('capability help guard: every live merchant-facing capability has a linked ar+en guide (sources)', () => {
  const articles = guideArticles();
  it('reads every guide in both languages (counted from the folder, so adding a guide never edits this test)', () => {
    const onDisk = (lang: string) => readdirSync(join(ROOT, 'docs/help', lang)).filter((f) => /^\d+-.+\.md$/.test(f)).length;
    expect(articles.filter((a) => a.lang === 'ar')).toHaveLength(onDisk('ar'));
    expect(articles.filter((a) => a.lang === 'en')).toHaveLength(onDisk('en'));
    expect(onDisk('ar')).toBe(onDisk('en'));
  });
  it('has no new help violation and no stale baseline id (the 23 needs-help ids are the debt)', () => {
    expect(judge('help', checkHelp(entries, articles, guardConfig)).failures).toEqual([]);
  });
  it('the help baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkHelp(entries, articles, guardConfig)));
    expect(loadBaseline('help').filter((id) => !current.has(id))).toEqual([]);
  });
  it('a guide present in one language only fails (mutation proof)', () => {
    const v = checkHelp(entries, articles.filter((a) => !(a.slug === 'whatsapp/ai-agent' && a.lang === 'en')), guardConfig);
    expect(v.some((x) => x.rule === 'help-twin-missing' && x.key === 'whatsapp/ai-agent')).toBe(true);
  });
  it('a guide that lost its capabilities link fails help-unlinked (mutation proof)', () => {
    const v = checkHelp(entries, articles.map((a) => (a.slug === 'whatsapp/ai-agent' ? { ...a, capabilities: [] } : a)), guardConfig);
    expect(v.some((x) => x.rule === 'help-unlinked')).toBe(true);
  });
});

describe('Smart Layer bypass: no direct model call outside the Smart Layer', () => {
  const files = bypassFiles();
  it('scans the real tree (positive control)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.path === 'wrangler.jsonc')).toBe(true);
  });
  it('has no new direct model call and no stale baseline id', () => {
    expect(judge('bypass', checkModelBypass(files, guardConfig)).failures).toEqual([]);
  });
  it('the bypass baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkModelBypass(files, guardConfig)));
    expect(loadBaseline('bypass').filter((id) => !current.has(id))).toEqual([]);
  });
  it('a deliberately added model call fails (mutation proof)', () => {
    const extra = { path: 'src/zz-invented.ts', src: 'const r = await env.AI.run(model, input);' };
    expect(checkModelBypass([...files, extra], guardConfig).some((v) => v.key.startsWith('src/zz-invented.ts'))).toBe(true);
  });
});
