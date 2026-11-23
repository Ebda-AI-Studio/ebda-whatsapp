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
