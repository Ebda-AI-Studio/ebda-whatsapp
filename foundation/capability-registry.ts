import { capabilitySchema, normalizeApi, type Capability, type GuardConfig, type Violation } from './capability';

const splitApi = (a: string): { method: string; path: string } => {
  const m = /^(\S+)\s+(.*)$/.exec(a.trim());
  return { method: (m ? m[1]! : '').toUpperCase(), path: m ? m[2]! : a };
};

/** Registry-internal rules. Pure: never throws on bad JSON (a schema failure is a violation and the entry is dropped). */
export function checkRegistry(files: { name: string; json: unknown }[], cfg: GuardConfig): { entries: Capability[]; violations: Violation[] } {
  const entries: Capability[] = [];
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const add = (rule: string, key: string, message: string) => violations.push({ rule, key, message });
  const mustConfirm = cfg.mustConfirm.map((m) => ({ method: m.method?.toUpperCase(), re: new RegExp(m.pattern) }));

  for (const f of files) {
    const parsed = capabilitySchema.safeParse(f.json);
    if (!parsed.success) {
      add('schema', f.name, `${f.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    const e = parsed.data;
    if (f.name !== `${e.id}.capability.json`) add('id-filename', e.id, `${f.name} must be named ${e.id}.capability.json`);
    if (seen.has(e.id)) {
      add('id-duplicate', e.id, `${f.name} repeats id ${e.id}`);
      continue;
    }
    seen.add(e.id);
    entries.push(e);

    if (e.status === 'in-pr' && !e.pr) add('lifecycle', e.id, 'in-pr needs pr');
    if (e.status === 'planned' && !e.plan) add('lifecycle', e.id, 'planned needs plan');

    const apis = e.api.map(splitApi);
    // readOnlyPost excuses only the POST routes it names (compared normalised); PUT/PATCH/DELETE and every unnamed POST are writes.
    const excused = new Set((e.readOnlyPost?.routes ?? []).map(normalizeApi));
    const apiNorm = new Set(e.api.map(normalizeApi));
    for (const r of e.readOnlyPost?.routes ?? []) {
      const n = normalizeApi(r);
      if (!n.startsWith('POST ') || !apiNorm.has(n)) add('readonlypost-unknown-route', `${e.id} ${r}`, `readOnlyPost names ${r}, which is not a POST route in api`);
    }
    const writes = e.api.some((a, i) => apis[i]!.method !== 'GET' && !(apis[i]!.method === 'POST' && excused.has(normalizeApi(a))));
    if (e.policy === 'free' && writes) add('policy-free-writes', e.id, 'policy free but an api method writes (declare readOnlyPost with a reason if it only reads)');

    // match the pattern against the raw and the normalised spelling, so a trailing slash, case, double slashes or a param-name variant cannot dodge it
    const needsConfirm = e.api.some((a, i) => {
      const n = splitApi(normalizeApi(a));
      return apis[i]!.method === 'DELETE' || mustConfirm.some((m) => (!m.method || m.method === apis[i]!.method) && (m.re.test(apis[i]!.path) || m.re.test(n.path)));
    });
    for (const s of e.screens) {
      // a wildcard may only end a path with depth >= 1 ("/x/*"): "/*" or a mid-path star would claim pages it does not name
      if (s.includes('*') && !/^\/[^*]+\/\*$/.test(s)) add('screen-wildcard', `${e.id} ${s}`, `${s}: a wildcard screen must be /<path>/* with a concrete base`);
    }
    if (needsConfirm && e.policy !== 'confirm' && e.policy !== 'forbidden') add('policy-must-confirm', e.id, 'money, customer messaging and deletes need confirm or forbidden');

    if (e.undo.class === 'irreversible' && (e.policy === 'free' || e.policy === 'preview')) add('policy-irreversible', e.id, 'irreversible actions are always confirm or forbidden');

    const operatorOnly = e.roles.length > 0 && e.roles.every((r) => r === 'super_admin' || r === 'operator');
    if (operatorOnly) {
      if (e.policy !== 'forbidden') add('operator-forbidden', e.id, 'operator-only capability must be forbidden to the assistant');
      if (!e.operatorReason?.code) add('operator-reason', e.id, 'operator-only capability needs operatorReason.code');
    }

    const { ar, en } = e.questions;
    const ok = e.status === 'live' ? ar.length >= 3 && ar.length <= 6 && en.length >= 1 && en.length <= 3 : ar.length >= 1 && en.length >= 1;
    if (!ok) add('questions-count', e.id, `questions out of range (ar ${ar.length}, en ${en.length})`);

    if (e.undo.class === 'unclassified') add('undo-unclassified', e.id, 'undo class not set');
  }
  return { entries, violations };
}
