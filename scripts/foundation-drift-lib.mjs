// Pure logic of the foundation drift check (no I/O, so a test can drive it). Rule (register row "Foundation version drift"):
// the vendored foundation tag may be at most ONE release behind the newest foundation tag; once it is two or more behind it has
// SEVEN days to catch up, counted from the day the SECOND newer release was published (the day it became "more than one behind").
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const parseTag = tag => {
  const m = SEMVER.exec(String(tag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * @param {{ lockTag: string, tags: Array<{ name: string, date: string | Date }>, now?: Date, maxDays?: number }} input
 * @returns {{ status: 'ok' | 'fail' | 'unknown', behind: number, message: string }}
 */
export function evaluateDrift({ lockTag, tags, now = new Date(), maxDays = 7 }) {
  const lock = parseTag(lockTag);
  if (!lock) return { status: 'unknown', behind: 0, message: `foundation.lock.json tag "${lockTag}" is not vMAJOR.MINOR.PATCH` };
  const newer = tags
    .map(t => ({ ...t, v: parseTag(t.name) }))
    .filter(t => t.v && cmp(t.v, lock) > 0)
    .sort((a, b) => cmp(a.v, b.v));
  const behind = newer.length;
  if (behind <= 1)
    return { status: 'ok', behind, message: behind === 0 ? `vendored ${lockTag} is the latest` : `vendored ${lockTag} is one release behind ${newer[0].name} (allowed)` };
  const second = newer[1];
  const ageDays = (now.getTime() - new Date(second.date).getTime()) / DAY_MS;
  if (Number.isNaN(ageDays)) return { status: 'unknown', behind, message: `release date of ${second.name} is unreadable` };
  if (ageDays > maxDays)
    return {
      status: 'fail',
      behind,
      message: `vendored ${lockTag} is ${behind} releases behind ${newer[behind - 1].name}; ${second.name} (the second newer one) is ${ageDays.toFixed(1)} days old, limit ${maxDays}. Merge the foundation bump PR.`,
    };
  return { status: 'ok', behind, message: `vendored ${lockTag} is ${behind} releases behind, ${second.name} is ${ageDays.toFixed(1)} days old (limit ${maxDays})` };
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref?.())]);

/**
 * The whole check against GitHub, with every read bounded: each call has its own abort signal AND a hard race (a fetch that ignores
 * its signal still cannot hang the step), and the whole run has one overall budget. Any read problem returns `{ status: 'skipped' }`
 * (warn and pass): an api.github.com outage or hang must never block every merge.
 * Dates are the ANNOTATED TAG's tagger date (a lightweight tag falls back to its commit's date): a tag pushed long after its
 * commit must not start the 7-day clock early.
 * @param {{ lockTag: string, repo: string, token?: string, fetchImpl?: typeof fetch, now?: Date, callMs?: number, budgetMs?: number, maxDays?: number }} o
 */
export async function checkDrift({ lockTag, repo, token = '', fetchImpl = globalThis.fetch, now = new Date(), callMs = 10_000, budgetMs = 30_000, maxDays = 7 }) {
  const started = Date.now();
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const get = async path => {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) throw new Error(`overall ${budgetMs} ms budget used up`);
    const ms = Math.min(callMs, left);
    const res = await withTimeout(fetchImpl(`https://api.github.com/repos/${repo}/${path}`, { headers, signal: AbortSignal.timeout(ms) }), ms, path);
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return withTimeout(res.json(), ms, `${path} body`);
  };
  try {
    const lock = parseTag(lockTag);
    if (!lock) return evaluateDrift({ lockTag, tags: [], now, maxDays });
    const tags = await get('tags?per_page=30');
    const newer = tags
      .map(t => ({ name: t.name, sha: t.commit?.sha, v: parseTag(t.name) }))
      .filter(t => t.v && cmp(t.v, lock) > 0)
      .sort((a, b) => cmp(a.v, b.v));
    // only the second newer release's date is ever read by the rule; the first is dated too so the result names real data
    const dated = [];
    for (const t of newer.slice(0, 2)) {
      let date;
      const ref = await get(`git/ref/tags/${t.name}`);
      if (ref.object?.type === 'tag') date = (await get(`git/tags/${ref.object.sha}`)).tagger?.date;
      else date = (await get(`commits/${t.sha}`)).commit?.committer?.date;
      dated.push({ name: t.name, date });
    }
    // releases beyond the second only need to exist (count), not to be dated
    for (const t of newer.slice(2)) dated.push({ name: t.name, date: now.toISOString() });
    return evaluateDrift({ lockTag, tags: dated, now, maxDays });
  } catch (err) {
    return { status: 'skipped', behind: 0, message: `could not read ${repo} tags (${err instanceof Error ? err.message : err}); check skipped` };
  }
}
