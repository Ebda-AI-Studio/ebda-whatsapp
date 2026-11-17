/** Cohen's kappa between two raters over the same items (categories are any numbers). Used to decide whether the LLM judge may count (ruling SL-JUDGE-1). */
export function cohensKappa(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) throw new Error('cohensKappa needs two equal, non-empty label lists');
  const n = a.length;
  const cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  if (pe === 1) return po === 1 ? 1 : 0; // both raters constant and equal: perfect; constant but different: no information
  return (po - pe) / (1 - pe);
}
