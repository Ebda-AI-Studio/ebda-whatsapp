import { useEffect, useState } from 'react';
import type { NumberDto, SharedNumberDto, WalletDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';

export type Level = 'ok' | 'warn' | 'bad';
/** `none` = nothing connected yet (a prompt, not a fault); `unknown` = the answer did not arrive (never rendered as healthy or as empty). */
export type Health =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'down' | 'bad' | 'warn' | 'ok'; tier: number | null; quality: string | null };

const TIERS: Record<string, number> = { TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000 };

/** One answer from the numbers the API already lists: the worst active number decides. */
export function healthOf(numbers: NumberDto[], shared: SharedNumberDto | null): Health {
  const active = numbers.filter((n) => n.status === 'active');
  if (numbers.length === 0 && !shared?.member) return { kind: 'none' };
  if (active.length === 0) return shared?.member ? { kind: 'ok', tier: null, quality: null } : { kind: 'down', tier: null, quality: null };
  const tier = Math.min(...active.map((n) => (n.messagingLimitTier ? TIERS[n.messagingLimitTier] ?? Infinity : Infinity)));
  const quality = active.find((n) => n.qualityRating && n.qualityRating !== 'GREEN')?.qualityRating ?? active.find((n) => n.qualityRating)?.qualityRating ?? null;
  const t = Number.isFinite(tier) ? tier : null;
  if (active.some((n) => n.health === 'red' || n.health === 'restricted')) return { kind: 'bad', tier: t, quality };
  if (active.some((n) => n.health === 'yellow' || n.qualityRating === 'YELLOW' || n.qualityRating === 'RED') || numbers.some((n) => n.status !== 'active' && n.kind === 'own')) return { kind: 'warn', tier: t, quality };
  return { kind: 'ok', tier: t, quality };
}

export type Usage = { level: Level; left: number; allowance: number; usedPct: number | null; walletLow: boolean };

/** The package meter: AI credits left against the monthly allowance, plus the wallet's own low flag. Both come from the wallet read the inbox already makes. */
export function usageOf(w: WalletDto): Usage {
  const { available, allowance, low } = w.aiCredits;
  const usedPct = allowance > 0 ? Math.min(100, Math.max(0, Math.round(((allowance - available) / allowance) * 100))) : null;
  const walletLow = w.lowBalance || w.debtMinor > 0;
  const level: Level = available <= 0 && allowance > 0 ? 'bad' : low || walletLow || (usedPct !== null && usedPct >= 80) ? 'warn' : 'ok';
  return { level, left: available, allowance, usedPct, walletLow };
}

export type ConnectionStatus = { health: Health; usage: Usage | null };

/** Reads numbers + wallet once, and again after the person leaves the numbers or wallet screen (so fixing a number or topping up shows at once). A failed read leaves that half unknown. */
export function useConnectionStatus(source: InboxSource, view: string): ConnectionStatus {
  const [state, setState] = useState<ConnectionStatus>({ health: { kind: 'unknown' }, usage: null });
  const listsNumbers = !!source.numbers && source.capabilities.numbers === true;
  // Re-read when the person comes back from the screens that change these answers (numbers, wallet), not while they are on them.
  const settled = view !== 'numbers' && view !== 'wallet';
  useEffect(() => {
    if (!settled) return;
    let live = true;
    const numbers = listsNumbers
      ? Promise.all([source.numbers!.list(), source.numbers!.shared ? source.numbers!.shared.status().catch(() => null) : Promise.resolve(null)]).then(([l, s]) => healthOf(l, s), (): Health => ({ kind: 'unknown' }))
      : Promise.resolve<Health>({ kind: 'unknown' });
    const wallet = source.wallet ? source.wallet.wallet().then(usageOf, () => null) : Promise.resolve(null);
    void Promise.all([numbers, wallet]).then(([health, usage]) => { if (live) setState((s) => ({ health, usage: usage ?? s.usage })); });
    return () => { live = false; };
  }, [source, settled, listsNumbers]);
  return state;
}
