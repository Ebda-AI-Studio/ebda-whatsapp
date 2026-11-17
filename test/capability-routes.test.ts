// Workers project: route + page coverage and the self-service route guard over Chat's real Hono table. Registry via import.meta.glob, no fs.
import { describe, expect, it } from 'vitest';
import railSource from '../web/src/components/Rail.tsx?raw';
import { apiRoutes } from '../src/index';
import { checkCoverage } from '../foundation/capability-coverage';
import { checkSelfServiceRoutes } from '../foundation/self-service-routes';
import { chatCodeFacts, railViews, type HonoRoute } from './helpers/capability-facts';
import { guardConfig, idsOf, judge, loadBaseline, loadRegistry } from './helpers/capability-guard';

const facts = chatCodeFacts(guardConfig, apiRoutes.routes as HonoRoute[], railSource);
const { entries } = loadRegistry();

describe('chat code facts come from the real code', () => {
  it('reads the rail views as pages', () => {
    expect(railViews(railSource)).toEqual(expect.arrayContaining(['inbox', 'operator']));
    expect(facts.pages).toEqual(expect.arrayContaining(['/inbox', '/operator']));
  });
  it('walks the Hono table: store routes are merchant, /operator routes are operator, no wildcard middleware', () => {
    expect(facts.routes.length).toBeGreaterThan(100);
    expect(facts.routes).toContainEqual({ method: 'GET', path: '/stores/:storeId/me', kind: 'merchant' });
    const op = facts.routes.filter((r) => r.path.startsWith('/operator/'));
    expect(op.length).toBeGreaterThan(15);
    expect(op.every((r) => r.kind === 'operator')).toBe(true);
    expect(facts.routes.some((r) => r.path.includes('*') || r.method === 'ALL')).toBe(false);
  });
});

describe('capability coverage: every page and route belongs to a capability', () => {
  it('has no new uncovered page or route and no stale baseline id', () => {
    expect(judge('coverage', checkCoverage(facts, entries)).failures).toEqual([]);
  });
  it('the coverage baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkCoverage(facts, entries)));
    expect(loadBaseline('coverage').filter((id) => !current.has(id))).toEqual([]);
  });
  it('a deliberately unregistered fake route fails coverage (mutation proof)', () => {
    const extra = [...(apiRoutes.routes as HonoRoute[]), { method: 'POST', path: '/api/v1/stores/:storeId/zz-invented' }];
    const v = checkCoverage(chatCodeFacts(guardConfig, extra, railSource), entries);
    expect(idsOf(v)).toContain('route-uncovered|POST /stores/:storeId/zz-invented');
  });
  it('a deliberately unregistered fake view fails coverage (mutation proof)', () => {
    const v = checkCoverage(chatCodeFacts(guardConfig, apiRoutes.routes as HonoRoute[], railSource.replace("'operator';", "'operator' | 'zzinvented';")), entries);
    expect(idsOf(v)).toContain('page-uncovered|/zzinvented');
  });
  it('dropping a discovered route from the facts surfaces the dangling live entry (adapter mutation proof)', () => {
    const target = 'GET /stores/:storeId/me';
    const without = { ...facts, routes: facts.routes.filter((r) => `${r.method} ${r.path}` !== target) };
    expect(checkCoverage(facts, entries).some((v) => v.rule === 'route-dangling' && v.key.endsWith(` ${target}`))).toBe(false);
    expect(checkCoverage(without, entries).some((v) => v.rule === 'route-dangling' && v.key.endsWith(` ${target}`))).toBe(true);
  });
});

describe('self-service routes: operator routes carry a valid operator reason', () => {
  it('has no new unreasoned operator route or invalid reason and no stale baseline id', () => {
    expect(judge('superadmin', checkSelfServiceRoutes(facts, entries)).failures).toEqual([]);
  });
  it('the superadmin baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkSelfServiceRoutes(facts, entries)));
    expect(loadBaseline('superadmin').filter((id) => !current.has(id))).toEqual([]);
  });
  it('a deliberately unreasoned operator route fails (mutation proof)', () => {
    const v = checkSelfServiceRoutes({ ...facts, routes: [...facts.routes, { method: 'POST', path: '/operator/zz-invented', kind: 'operator' }] }, entries);
    expect(idsOf(v)).toContain('superadmin-route-unreasoned|POST /operator/zz-invented');
  });
});
