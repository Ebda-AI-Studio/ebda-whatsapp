/**
 * WA-CI-STALL-1 diagnostics. A test that hangs is killed by vitest with only "timed out"; this module keeps the list of operations the code under test started
 * and has not seen finish (outbound fetches, Durable Object RPC calls, queue sends) so that, a moment BEFORE the deadline, one structured line says which
 * await is stuck. Labels are a host/path or a method name: never a body, a query string, or a run of 8+ digits (a phone number, a wamid).
 */
type Op = { label: string; at: number };
const ops = new Map<symbol, Op>();

export function track<T>(label: string, p: PromiseLike<T>): Promise<T> {
  const id = Symbol(label);
  ops.set(id, { label, at: Date.now() });
  const done = () => { ops.delete(id); };
  return Promise.resolve(p).then((v) => { done(); return v; }, (e) => { done(); throw e; });
}
export const pendingOps = (now = Date.now()): { label: string; ageMs: number }[] => [...ops.values()].map((o) => ({ label: o.label, ageMs: now - o.at })).sort((a, b) => b.ageMs - a.ageMs);
export const clearOps = (): void => ops.clear();

export function labelForUrl(url: string): string {
  try {
    const u = new URL(url);
    return `fetch ${u.host}${u.pathname.replace(/\/bot[^/]+/, '/bot[token]').replace(/\d{8,}/g, '[n]')}`;
  } catch {
    return 'fetch (unparsable url)';
  }
}

// Durable Object RPC calls are NOT wrapped: `runInDurableObject` brand-checks its stub natively ("parameter 1 is not of type DurableObjectStub"), so a Proxy around a
// stub breaks every test that uses it (tried, 2026-10-27). A stall inside a DO call therefore shows as `pending: []` while the test is stuck: that itself says "inside a
// Durable Object call or in the test body, not in an outbound fetch or a queue send". A test may name its own operation with `track('do.<method>', promise)`.

/**
 * Arms a timer for `timeoutMs - marginMs`; when it fires it calls `emit` once with `{"stall":"<test name>","pending":[{label,ageMs}...]}`. The returned function disarms it
 * (a test that finishes in time prints nothing).
 */
export function watchStall(o: { name: string; timeoutMs: number; marginMs?: number; emit: (line: string) => void }): () => void {
  const margin = o.marginMs ?? Math.min(2000, Math.floor(o.timeoutMs / 4));
  const timer = setTimeout(() => o.emit(JSON.stringify({ stall: o.name, pending: pendingOps() })), Math.max(1, o.timeoutMs - margin));
  return () => clearTimeout(timer);
}
