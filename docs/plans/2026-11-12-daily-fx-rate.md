# WA-FX-DAILY-1: daily USD->EGP rate with a dynamic buffer (2026-11-12)

Decision (Ahmad, 2026-11-12): Meta bills us in USD, merchants pay from an EGP wallet. Replace the hand-set `fx_rates` row with a daily FX pull plus a researched, dynamic buffer. Primary source fawazahmed0, fallback open.er-api.com, buffer between 500 and 700 bps.

## 1. Research (every source below was opened or called on 2026-11-12)

| Source | Result | Terms and limits | Verdict |
|---|---|---|---|
| fawazahmed0 currency-api via jsDelivr (`cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`) | HTTP 200, `usd.egp` = 53.32 (date 2026-11-11); dated snapshots `@YYYY-MM-DD` return history | README (github.com/fawazahmed0/exchange-api): CC0-1.0, "No Rate limits", daily update, fallback host `{date}.currency-api.pages.dev`; underlying data source not stated; no SLA | **Primary** |
| open.er-api.com (`/v6/latest/USD`) | HTTP 200, `rates.EGP` = 53.55; body carries next-update time (about 24 h) | exchangerate-api.com/docs/free: no key; 429 and a 20-minute lockout if abused (ask once per 24 h); attribution link required; caching and commercial use allowed, no redistribution; no uptime guarantee; `time_eol_unix` announces end of support | **Fallback**, one call a day, attribution in docs |
| Frankfurter / ECB (`api.frankfurter.dev/v1/currencies`) | EGP is **not** in the currency list; `latest?symbols=EGP` returns 404 | n/a | Unusable (verified) |
| Central Bank of Egypt | the rates page answers 200 but is HTML with no API I could confirm | n/a | Not automated; a human can cross-check it when `fx_rate_rejected` fires |
| Meta | developers.facebook.com/docs/whatsapp/pricing: 16 billing currencies, EGP is not one; the page names no FX source or frequency; price changes only on the first day of a quarter | n/a | We are billed in USD, so no Meta FX rate sits in our invoice. Our risk is only wallet EGP vs USD cost. Our bank or card settlement FX was not verifiable |

Both free sources agree within 0.4% today (53.32 vs 53.55), consistent with different daily snapshot times.

### EGP volatility, last 12 months (measured: 364 daily fawazahmed0 snapshots, 2025-11-12 to 2026-11-12)
Range 46.62 to 56.27; 47.20 to 53.55 over the year (+13%, one-way drift). Daily absolute move: median 0.21%, p95 1.26%, p99 2.60%, max 3.88%. Moves above 2%: 6 days. Rolling rise of EGP per USD: 3 d p95 +1.7% (max +4.9%); 7 d p95 +3.4% (max +7.3%); 14 d p95 +5.5% (max +10.5%); 30 d p95 +10.2% (max +14.1%).
The series is kept as `test/fixtures/egp-usd-364d.json`; the calibration below is replayed from it by `test/fx-buffer.test.ts`.

### Lag assumption (not verified)
A merchant tops up EGP, Meta invoices USD later; I assume 2 to 4 weeks between the two. That is why the buffer targets the 14-day tail (p95 +5.5%) and reaches 700 bps at a 10% 14-day rise (the observed maximum).

## 2. Design

**Cron.** `runDailyFx` runs from `scheduled` beside `dailyBilling` (cron `17 1 * * *`, unchanged; no weekday field, so Cloudflare's 1 = Sunday numbering is not in play). It appends one `fx_rates` row per UTC day (unique index on `obs_day`, `ON CONFLICT DO NOTHING`); old rows are never touched (immutable triggers stay). `effective_from = now + 24 h` like every operator publish, so each workspace copy holds the version before it applies.

**Validation.** Zod on each response (`usd.egp` or `result:"success"` + `rates.EGP`, finite, 1..1000). A failing source falls through to the next (jsDelivr, Pages mirror, open.er-api).

**Fresh feeds.** A payload dated before yesterday (UTC) is a failed source. **Sanity band 5%** against the newest stored rate (any source, including hand-published). Outside it: accepted automatically when the OTHER independent provider is fresh and within 1% (Ruling FX-5, `fx_large_move_accepted` P1 with both values; cost if wrong: two feeds sharing an upstream can both be wrong, a human sees the P1 the same day and publishes a correction); otherwise no insert, `fx_rate_rejected` (P1) with both values (Ruling FX-1: the external fact is recorded in the alert and an operator publishes it by hand if real; I follow Ahmad's "reject + alert" over the memory rule "record, never abort" because no ledger write depends on this row. Cost if wrong: during a real >5% devaluation prices lag until a human publishes, covered only by the buffer). Fetch failure: last rate stays, `fx_fetch_failed` (P1). Newest observed day (`obs_day`) more than 48 h old, or no row: `fx_rate_stale` (P1).

**Holds and credits.** A hold is estimated at `now`, the charge is priced at DELIVERY time with the version in effect then (`engine.ts` `priceAt`). A falling rate therefore only lowers a later charge; the hold was reserved at the higher rate and its surplus is released, so we never under-charge on a hold. A rising rate raises the charge above the hold; that existing shortfall path (wallet plus overdraft) is what the buffer is sized for. No code change was needed to keep this invariant; the 24 h lead guarantees a quoted hold is never re-priced mid-flight.

**Buffer (`src/core/billing/fx-buffer.ts`, pure).**
`buffer = clamp(500, 700, 500 + A x max(0, vol - baseline) + B x max(0, drift))`, A = 1 bps per bps/day, B = 20 bps per percent.
- vol: sample stdev of the daily log returns of the last 14 calendar days, bps/day. baseline: median of that 14-day vol over the trailing 365 days (46.2 bps/day on the real series).
- drift: 14-day % move of EGP per USD, only a rise counts.
- Everything over calendar days (a gap day makes a multi-day return, normalised by sqrt(days) for vol, and is never a one-day jump). Jump: a one-day RISE above 3% (signed, like drift) sets 700 at once. Hysteresis: it rises at once, falls at most 50 bps a day, and never exceeds 700 after an unpin (a pin itself may set any value). Fewer than 60 vol windows of history: 700.
- Stored on each row: `buffer_bps`, `vol_bps`, `drift_pct`, `buffer_mode` (computed / jump / short_history / pinned), `source`.
- It adds to `pricing_settings.fx_buffer_bps` (existing operator extra, default 0), as `priceAt` already sums them.
- Pin: `PUT /api/v1/operator/fx-buffer-pin {bufferBps|null, reason}` (append-only table `fx_buffer_pins`, audited); the newest pin replaces the computed value on every later daily row.

**Cold start and backfill.** Without history the first 14 days would run at 700 (the safe default). Decision 2026-11-12 (Ahmad): a one-off, idempotent operator backfill (`POST /fx-backfill`, never automatic) loads up to 365 dated jsDelivr snapshots as `source=backfill` rows; only the newest inserted row gets a computed buffer (previous buffer = none), the older rows are 700-buffer inputs. Ruling FX-4 (revised after review): backfilled rows are NEVER priceable; `pullPricing` skips `source = backfill`, so the first priced row is the first cron row (effective 24 h after it). Cost if wrong: until that first cron row takes effect there is no FX in a fresh environment (sends defer as `pending_rate`, never free).

### Calibration on the real 364-day series
Replayed CAUSALLY and over CALENDAR days (the series has 364 points over 366 days; its two gaps are handled as multi-day returns), day by day exactly as the cron would see it (history = rows before that day, baseline = median of the 14-day vol over the history so far, previous buffer = yesterday's). 363 replayed days: the first 68 are `short_history` (700, fewer than 60 vol windows); the other 295 are evaluable. A = 1, B = 20, signed jump, hysteresis, cap 700:

| Buffer (295 evaluable days) | Days |
|---|---|
| exactly 500 | 25 |
| 501 to 549 (about 500) | 180 |
| 550 to 649 (about 600) | 64 |
| 650 to 699 | 18 |
| exactly 700 | 8 |
| nearest of 500 / 600 / 700 | 205 / 64 / 26 |

Mean 549 bps over the evaluable days. The 3 days with a 14-day rise of 9.5% or more all sit at 700. One jump day (a one-day rise above 3%) in the year. The year-long +13% drift keeps the drift term active, which is the point; hysteresis is why only 25 days sit exactly on 500. With the 365-day backfill the 60-window rule is satisfied at once, so production never runs the 68 short-history days. Larger A (2 to 20) pushed far more days to 700 and failed the "calm sits near 500" aim, so A = 1. In-sample on one year of one source; A and B are two constants in one file.

## 3. Ruling log
- Ruling FX-1: see sanity band. Cost if wrong: prices lag a real >5% move until a human publishes.
- Ruling FX-2 (revised 2026-11-12): staleness is checked by `checkFxStale` from `dailyBilling`, independent of the fetch task, keyed on the observed day (`obs_day`), plus `/health` fields `fxObsDay` / `fxAgeHours` for the OS watchdog (alert at > 48 h). Cost if wrong: if the whole cron trigger dies both stop; the missing `daily_billing` log line is the signal.
- Ruling FX-3: manual `POST /fx-rates` rows count for the band and `prev` buffer but not for the volatility history. Cost if wrong: a hand-published odd rate is not in the vol window.

## 4. Open
- Source terms: open.er-api.com requires an attribution link wherever its rates are shown; we show none to merchants (docs only), so attribution lives in docs/billing.md.
- No secrets or env vars are added (both sources are keyless), so no `.env.example` or wrangler secret change.
