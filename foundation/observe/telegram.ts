/**
 * The out-of-band alert channel for every Ebda product (F6, Ruling FDN-OBSERVE-1): one Telegram bot, one message shape, one set of masks.
 * Canonical sources: the Store's `alerts.service.ts` (header shape, throttle, deadline, never throws) and Ebda Chat's `alert()` (denied-key
 * field rendering, suppressed-count line, runbook URL). Pure transport: no config, logger, Redis or Sentry import; the product injects its
 * secrets, `fetch` and a throttle. Telegram is sent in plain text (no parse_mode: MarkdownV2 escaping bugs silently drop messages).
 *
 * Stricter than either product alone: the title, body, scope line and every field/context value pass `maskPhones` + `redactEmails`, and a
 * denied key (name, phone, token, ...) is never rendered. The Store used to send body/context unmasked.
 */
import { maskPhones, redactEmails } from './mask';

export type AlertLevel = 'p0' | 'p1' | 'info';
export type AlertOutcome = 'sent' | 'throttled' | 'skipped' | 'failed';
export type AlertScope = 'platform' | 'workspace' | 'store';

export interface AlertMessage {
  /** Which product broke (one bot serves the whole suite): `Ebda Store`, `Ebda Chat`, ... */
  product: string;
  level: AlertLevel;
  /** `platform` (default) = everyone feels it; `workspace` / `store` = one tenant. */
  scope?: AlertScope;
  /** One line naming the tenant, built by the product (`Demo Shop (demo-shop · 00000000…)`, `abcd1234…`). Rendered as `<scope>=<line>`. */
  scopeLine?: string;
  /** Stable per event class (it is also the default throttle key). */
  title: string;
  source?: string;
  env?: string;
  /** Absolute https URL or repo-relative path of the incident runbook. */
  runbook?: string;
  body?: string;
  /** `key=value` lines. Denied keys and non-scalar values are dropped; each value is masked and cut to 80 chars; at most 12. */
  fields?: Record<string, unknown>;
  /** Structured context appended as JSON, masked deeply. */
  context?: Record<string, unknown>;
  /** How many identical alerts the throttle swallowed since the last one. */
  suppressed?: number;
}

export const TELEGRAM_MAX_LEN = 4096;
export const BODY_MAX_LEN = 3500;
const LEVEL_EMOJI: Record<AlertLevel, string> = { p0: '🔴', p1: '🟠', info: '🔵' };

/** Keys whose values can be a person's data or a credential: never rendered, whatever the caller passed. */
export const DENIED_KEY = /^(to|from|body|text|code|email|caption|address|message|name|customer\w*)$|phone|wa_?id|token|secret|password|authorization/i;

/** Context is product-authored JSON (a stack, an error name, queue stats): only credentials are dropped by key, every string value is masked. */
export const CONTEXT_DENIED_KEY = /token|secret|password|authorization|api[_-]?key/i;

/** Alert text is masked in full (a body is cut to 3500 first; 8192 only bounds a hostile context string). */
const MASK_MAX = 8192;
const mask = (s: string): string => redactEmails(maskPhones(s), MASK_MAX);
/** The scope line is built by the product from ids and names (a UUID prefix of 8 digits looks like a phone and must stay readable): e-mails only. */
const maskScope = (s: string): string => redactEmails(s, MASK_MAX);

function maskDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return mask(v);
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).filter(([k]) => !CONTEXT_DENIED_KEY.test(k)).map(([k, x]) => [k, maskDeep(x, depth + 1)]));
}

export function renderFields(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (DENIED_KEY.test(k)) continue;
    const raw = Array.isArray(v) ? v.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).join(',') : ['string', 'number', 'boolean'].includes(typeof v) ? String(v) : '';
    if (!raw) continue;
    out.push(`${k}=${mask(raw).slice(0, 80)}`);
  }
  return out.slice(0, 12);
}

/** The runbook link of one alert as a phone can open it: `base/<name>.md`; a non-https base falls back to the repo-relative `fallback`. */
export function runbookUrl(name: string, base: string | undefined, fallback = 'docs/runbooks/alerts'): string {
  return `${typeof base === 'string' && /^https:\/\//.test(base) ? base.replace(/\/$/, '') : fallback}/${name}.md`;
}

/**
 * Header shape:
 *   🔴 Ebda Store: payment.webhook.hmac_fail
 *   [P0 STORE]
 *   store=Demo Shop (demo-shop · 00000000…)
 *   env=production · source=… · runbook=…
 */
export function buildAlertText(a: AlertMessage): string {
  const scope = a.scope ?? 'platform';
  const lines: string[] = [`${LEVEL_EMOJI[a.level]} ${mask(a.product)}: ${mask(a.title)}`, `[${a.level.toUpperCase()} ${scope.toUpperCase()}]`];
  if (scope !== 'platform' && a.scopeLine) lines.push(`${scope}=${maskScope(a.scopeLine)}`);
  const meta = [`env=${a.env ?? 'production'}`];
  if (a.source) meta.push(`source=${mask(a.source)}`);
  if (a.runbook) meta.push(`runbook=${a.runbook}`);
  lines.push(meta.join(' · '));
  if (a.fields) lines.push(...renderFields(a.fields));
  if (a.body) {
    const b = mask(a.body.length > BODY_MAX_LEN ? a.body.slice(0, BODY_MAX_LEN) : a.body);
    lines.push('', a.body.length > BODY_MAX_LEN ? `${b}…` : b);
  }
  if (a.context && Object.keys(a.context).length > 0) {
    try {
      lines.push('', JSON.stringify(maskDeep(a.context), null, 2));
    } catch { /* unrenderable context (circular): skip */ }
  }
  if (a.suppressed && a.suppressed > 0) lines.push(`(suppressed ${a.suppressed} more since the last alert)`);
  const text = lines.join('\n');
  return text.length > TELEGRAM_MAX_LEN ? `${text.slice(0, TELEGRAM_MAX_LEN - 1)}…` : text;
}

export interface ThrottleStore {
  /** `send: false` = an identical alert went out within `ttlMs`. `suppressed` = how many were swallowed since the last send. */
  claim(key: string, ttlMs: number): Promise<{ send: boolean; suppressed: number }> | { send: boolean; suppressed: number };
}

/** Per-isolate throttle (Chat). A shared store (Redis, KV) implements `ThrottleStore` itself. */
export function memoryThrottle(now: () => number = () => Date.now()): { claim(key: string, ttlMs: number): { send: boolean; suppressed: number }; reset(): void } {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return {
    claim(key, ttlMs) {
      const t = now();
      const prev = seen.get(key);
      if (prev && t - prev.at < ttlMs) {
        prev.suppressed++;
        return { send: false, suppressed: 0 };
      }
      seen.set(key, { at: t, suppressed: 0 });
      return { send: true, suppressed: prev?.suppressed ?? 0 };
    },
    reset: () => seen.clear(),
  };
}

export interface TelegramConfig {
  token?: string;
  chatId?: string;
  fetch?: typeof fetch;
  /** Hard cap on connect + headers + body. Default 5000. */
  timeoutMs?: number;
  /** Telegram's `disable_web_page_preview` (the Store sets it; runbook links in Chat keep their preview). Default false. */
  disableWebPagePreview?: boolean;
  /** Called (never throws into the sender) when delivery fails, so the product logs it with ITS logger: `status` + `detail` for a rejection, `err` for a throw. */
  onError?: (info: { status?: number; detail?: string; err?: unknown }) => void;
}
export interface TelegramAlertOptions {
  throttle?: ThrottleStore;
  /** Default 10 minutes. */
  throttleMs?: number;
  /** Default `<level>|<title>|<scopeLine>`. */
  throttleKey?: string;
}

/**
 * Send one alert. NEVER throws, never rejects: an alert about a broken server must not break the server. `skipped` = token or chat
 * missing (the caller logs once at boot), `throttled` = identical within the window, `failed` = Telegram rejected, errored or timed out.
 * On Workers hand the returned promise to `ctx.waitUntil`.
 */
export async function telegramAlert(cfg: TelegramConfig, alert: AlertMessage, opts: TelegramAlertOptions = {}): Promise<AlertOutcome> {
  try {
    if (!cfg.token || !cfg.chatId) return 'skipped';
    let suppressed = alert.suppressed ?? 0;
    if (opts.throttle) {
      const claim = await opts.throttle.claim(opts.throttleKey ?? `${alert.level}|${alert.title}|${alert.scopeLine ?? ''}`, opts.throttleMs ?? 10 * 60_000);
      if (!claim.send) return 'throttled';
      suppressed = claim.suppressed || suppressed;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await (cfg.fetch ?? fetch)(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: buildAlertText({ ...alert, suppressed }), ...(cfg.disableWebPagePreview ? { disable_web_page_preview: true } : {}) }),
        signal: controller.signal,
      });
      const detail = await res.text().catch(() => '');
      if (!res.ok) {
        notify(cfg, { status: res.status, detail: detail.slice(0, 500) });
        return 'failed';
      }
      return 'sent';
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    notify(cfg, { err });
    return 'failed';
  }
}

function notify(cfg: TelegramConfig, info: { status?: number; detail?: string; err?: unknown }): void {
  try {
    cfg.onError?.(info);
  } catch { /* a broken logger must not break the sender */ }
}
