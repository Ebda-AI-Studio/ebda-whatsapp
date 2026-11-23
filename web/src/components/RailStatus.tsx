import { Gauge, PhoneCall, PhoneOff, PlugZap } from 'lucide-react';
import { num, type Lang, type Strings } from '../i18n';
import type { ConnectionStatus, Health } from '../lib/connectionStatus';
import type { View } from './Rail';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const toneOf = (h: Health): Tone => (h.kind === 'ok' ? 'ok' : h.kind === 'warn' ? 'warn' : h.kind === 'bad' || h.kind === 'down' ? 'bad' : 'idle');
const TIER_NUM = (n: number, lang: Lang) => num(n, lang);

/** The words for a health state (short label for the tile, one sentence for the strip and the tooltip). */
export function healthCopy(t: Strings, lang: Lang, h: Health): { label: string; body: string; tier: string | null } | null {
  if (h.kind === 'unknown') return null;
  const tier = 'tier' in h && h.tier ? t.hu.tier(TIER_NUM(h.tier, lang)) : null;
  return { label: t.hu[h.kind], body: t.hu[`${h.kind}Body` as 'okBody'], tier };
}

/** Desktop rail: the number's health and the plan meter, always visible. Without a connected number both give way to one "connect" prompt. Phones get the strip in the inbox instead. */
export function RailStatus({ t, lang, status, onNavigate }: { t: Strings; lang: Lang; status: ConnectionStatus; onNavigate: (v: View) => void }) {
  const copy = healthCopy(t, lang, status.health);
  const tone = toneOf(status.health);
  const none = status.health.kind === 'none';
  const go = (v: View) => (e: React.MouseEvent) => { e.preventDefault(); onNavigate(v); };
  if (!copy && !status.usage) return null;
  const Icon = none ? PlugZap : status.health.kind === 'down' ? PhoneOff : PhoneCall;
  const u = status.usage;
  const usageText = u ? (u.usedPct !== null ? t.hu.usageAria(num(u.left, lang), num(u.allowance, lang)) : t.hu.usageAriaNoCap(num(u.left, lang))) : '';
  return (
    <div className="rail-status" role="group" aria-label={t.hu.railStatus}>
      {copy && (
        <a href="#numbers" className="rs-tile" data-tone={tone} title={[copy.body, copy.tier].filter(Boolean).join(' ')} aria-label={`${t.hu.healthTitle}: ${copy.label}. ${copy.body}${copy.tier ? ` ${copy.tier}.` : ''}`} onClick={go('numbers')}>
          <span className="rs-icon"><Icon size={20} aria-hidden /><i className="rs-dot" aria-hidden /></span>
          <span>{copy.label}</span>
        </a>
      )}
      {u && !none && (
        <a href="#wallet" className="rs-tile" data-tone={u.level} title={[usageText, u.level === 'bad' ? t.hu.usageBad : u.level === 'warn' ? (u.walletLow ? t.hu.walletLow : t.hu.usageWarn) : ''].filter(Boolean).join(' ')} aria-label={`${t.hu.usageTitle}: ${usageText}`} onClick={go('wallet')}>
          <span className="rs-icon"><Gauge size={20} aria-hidden /><i className="rs-dot" aria-hidden /></span>
          <span>{num(u.left, lang)}</span>
          {u.usedPct !== null && <span className="rs-meter" aria-hidden><span style={{ inlineSize: `${u.usedPct}%` }} /></span>}
        </a>
      )}
    </div>
  );
}

/** Inbox strip (every width): only when the number needs a person, with the way to fix it. A healthy or unknown state says nothing. */
export function ConnectStrip({ t, lang, health, onNavigate }: { t: Strings; lang: Lang; health: Health; onNavigate: (v: View) => void }) {
  if (health.kind === 'ok' || health.kind === 'unknown') return null;
  const copy = healthCopy(t, lang, health)!;
  const none = health.kind === 'none';
  return (
    <div className="connect-strip" data-tone={toneOf(health)} data-banner="number" role={health.kind === 'bad' || health.kind === 'down' ? 'alert' : 'note'}>
      <span><strong>{copy.label}</strong> {copy.body}{copy.tier ? ` ${copy.tier}.` : ''}</span>
      <a href="#numbers" onClick={(e) => { e.preventDefault(); onNavigate('numbers'); }}>{none ? t.hu.connect : t.hu.fix}</a>
    </div>
  );
}
