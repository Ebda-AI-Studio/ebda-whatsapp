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
    expect(entries.length).toBe(172);
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

describe('capability help guard: every live merchant-facing capability has a linked ar+en guide (sources)', () => {
  const articles = guideArticles();
  it('reads the 15 guides in both languages', () => {
    expect(articles.filter((a) => a.lang === 'ar')).toHaveLength(15);
    expect(articles.filter((a) => a.lang === 'en')).toHaveLength(15);
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
