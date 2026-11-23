import { normalizeApi, type Capability, type Violation } from './capability';
import type { CodeFacts } from './capability-coverage';

/** Operator/super-admin routes need a written reason in the registry (192.2); a reason the standard rejects is a self-service gap to close. */
export function checkSelfServiceRoutes(facts: CodeFacts, entries: Capability[]): Violation[] {
  const out: Violation[] = [];
  const claimers = new Map<string, Capability[]>();
  for (const e of entries) for (const a of e.api) {
    const k = normalizeApi(a);
    claimers.set(k, [...(claimers.get(k) ?? []), e]);
  }
  const reasoned = (e: Capability) => !!e.operatorReason?.code && e.policy === 'forbidden' && e.roles.length > 0 && e.roles.every((r) => r === 'super_admin' || r === 'operator');
  for (const r of facts.routes) {
    if (r.kind !== 'super_admin' && r.kind !== 'operator') continue;
    const who = claimers.get(normalizeApi(`${r.method} ${r.path}`)) ?? [];
    if (who.length === 0 || !who.every(reasoned)) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      out.push({ rule: 'superadmin-route-unreasoned', key, message: `${key} is staff-only without a written reason in its registry entry` });
    }
  }
  for (const e of entries) if (e.operatorReason?.validUnderRule === false) out.push({ rule: 'operator-reason-invalid', key: e.id, message: `${e.id}: the staff-only reason is not valid under the self-service rule` });
  return out;
}
