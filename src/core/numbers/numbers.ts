import type { Env } from '../../env';
import type { ConnectNumberRequest, NumberDto } from '../api/contract';
import { encryptSecret } from '../ai/secrets';
import { recordSignupUser } from '../meta/signup-users';
import { resolveNoticesForWaba } from '../meta/notices';
import { decryptAny, tokenKeys } from '../enc-keys';
import { recordNumberFunding } from '../billing/funding';
import { listOwnedWabas } from '../meta/catalog-api';
import { TIER_LIMITS } from '../throttle';
import { HISTORY_DECLINED_CODE, REGISTRATION_LOCKED_CODE, deregisterNumber, exchangeCode, fetchPhone, tokenOwner, fetchWabaNumbers, registerNumber, requestSync, subscribeApp, unsubscribeApp, type GraphFail, type PhoneStatus } from './graph';
import { graphTokenFor, invalidateNumber, invalidateWaba, TokenUnavailable } from './token';
import { alert } from '../observability';
import { funnel } from '../funnel';

/** Meta fixes the throughput of a number that stays on the WhatsApp Business app at 20 messages per second. */
export const BUSINESS_APP_MPS = 20;
/** After onboarding a Business app number has 24 hours to request its one-time contacts and history syncs. */
export const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SignupConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`embedded signup is on but not configured: ${missing.join(', ')}`);
  }
}
export const signupEnabled = (env: Env): boolean => env.EMBEDDED_SIGNUP_ENABLED === '1' || env.EMBEDDED_SIGNUP_ENABLED?.toLowerCase() === 'true';

/** Fails loud (names the missing keys, never their values) when the switch is on and a secret is missing or malformed. */
export function signupConfig(env: Env): { appId: string; encKey: string } {
  const missing = (['META_APP_ID', 'META_APP_SECRET', 'TOKEN_ENC_KEY'] as const).filter((k) => !env[k]);
  if (!missing.length) {
    try {
      if (atob(env.TOKEN_ENC_KEY!.replace(/-/g, '+').replace(/_/g, '/')).length !== 32) missing.push('TOKEN_ENC_KEY');
    } catch {
      missing.push('TOKEN_ENC_KEY');
    }
  }
  if (missing.length) throw new SignupConfigError(missing);
  return { appId: env.META_APP_ID!, encKey: env.TOKEN_ENC_KEY! };
}

// ---- rows and the DTO ------------------------------------------------------------------------------------------------

export const NUMBER_COLUMNS = `phone_number_id, waba_id, workspace_id, display_phone, status, kind, onboarding, verified_name, quality_rating, messaging_limit_tier,
  throughput_level, name_status, platform_type, is_on_biz_app, registration, sync_requested_at, last_status_sync_at, connected_at, subscribed_at, history_sync, contacts_sync, pin_enc, health_state`;
export type NumberRow = {
  phone_number_id: string; waba_id: string; workspace_id: string; display_phone: string | null; status: 'active' | 'disconnected'; kind: 'own' | 'platform';
  onboarding: 'cloud_api' | 'business_app' | null; verified_name: string | null; quality_rating: string | null; messaging_limit_tier: string | null;
  throughput_level: string | null; name_status: string | null; platform_type: string | null; is_on_biz_app: number | null;
  registration: NumberDto['registration']; sync_requested_at: number | null; last_status_sync_at: number | null; connected_at: number | null; subscribed_at: number | null;
  history_sync: NumberDto['historySync']; contacts_sync: NumberDto['contactsSync']; pin_enc: string | null; health_state: 'green' | 'yellow' | 'red' | 'restricted';
};

/** Never carries the token, the PIN or the workspace id. */
export function numberDto(r: NumberRow): NumberDto {
  return {
    phoneNumberId: r.phone_number_id, wabaId: r.waba_id, displayPhone: r.display_phone, verifiedName: r.verified_name, kind: r.kind, onboarding: r.onboarding,
    status: r.status, registration: r.registration, qualityRating: r.quality_rating, messagingLimitTier: r.messaging_limit_tier, throughputLevel: r.throughput_level,
    nameStatus: r.name_status, platformType: r.platform_type, isOnBizApp: r.is_on_biz_app === null ? null : r.is_on_biz_app === 1,
    historySync: r.history_sync, contactsSync: r.contacts_sync, connectedAt: r.connected_at,
    syncDeadlineAt: r.onboarding === 'business_app' && r.connected_at ? r.connected_at + SYNC_WINDOW_MS : null,
    lastStatusSyncAt: r.last_status_sync_at, health: r.health_state,
  };
}

export async function listNumbers(env: Env, workspaceId: string): Promise<NumberDto[]> {
  const { results } = await env.DB.prepare(`SELECT ${NUMBER_COLUMNS} FROM phone_numbers WHERE workspace_id = ? ORDER BY rowid`).bind(workspaceId).all<NumberRow>();
  return results.map(numberDto);
}

async function numberRow(env: Env, workspaceId: string, phoneNumberId: string): Promise<NumberRow | null> {
  return env.DB.prepare(`SELECT ${NUMBER_COLUMNS} FROM phone_numbers WHERE phone_number_id = ? AND workspace_id = ?`).bind(phoneNumberId, workspaceId).first<NumberRow>();
}

// ---- results ---------------------------------------------------------------------------------------------------------

export type NumberFailure = { ok: false; status: 400 | 404 | 409 | 429 | 503; error: 'invalid_request' | 'not_found' | 'number_conflict' | 'registration_locked' | 'signup_failed' | 'signup_unavailable'; message: string; number?: NumberDto };
export type NumberSuccess = { ok: true; number: NumberDto; warnings: string[] };
export type NumberResult = NumberSuccess | NumberFailure;

const fail = (status: NumberFailure['status'], error: NumberFailure['error'], message: string, number?: NumberDto): NumberFailure => ({ ok: false, status, error, message, ...(number ? { number } : {}) });
/** A Graph failure → what the client sees: retryable ones are 503 (try again), the rest are the merchant's to fix. */
const graphFailure = (g: GraphFail, message: string, number?: NumberDto): NumberFailure =>
  g.retryable ? fail(503, 'signup_unavailable', message, number) : fail(400, 'signup_failed', message, number);

/** Six uniformly random digits (rejection sampling: no modulo bias). */
export function generatePin(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
}

/**
 * Runs after a number finished connecting (and again whenever a half-finished connect is completed, so it must be idempotent).
 * billing records funding = merchant_card here (Ruling WA-FUND-1). Intentionally empty until Phase 7's number_funding is merged.
 */
/**
 * Ruling WA-FUND-1: Meta bills the merchant's own card for an own number, so the wallet never pays Meta for it. Funding is written
 * explicitly here (no default anywhere: a number without it cannot send), then the workspace's copy of the price inputs is refreshed
 * at once so the number is usable now rather than after the next 30-minute pull. Idempotent: a resumed connect calls it again.
 */
export async function onNumberConnected(env: Env, n: { workspaceId: string; phoneNumberId: string; wabaId: string; kind: 'own' }): Promise<void> {
  funnel(env, 'number_connected', n.workspaceId);
  await recordNumberFunding(env, n.phoneNumberId, 'merchant_card');
  await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(n.workspaceId)).refreshPricing();
}

// ---- status ----------------------------------------------------------------------------------------------------------

async function applyStatus(env: Env, workspaceId: string, phoneNumberId: string, st: PhoneStatus, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE phone_numbers SET display_phone = coalesce(?, display_phone), verified_name = coalesce(?, verified_name), quality_rating = coalesce(?, quality_rating),
       messaging_limit_tier = coalesce(?, messaging_limit_tier), throughput_level = coalesce(?, throughput_level), name_status = coalesce(?, name_status),
       platform_type = coalesce(?, platform_type), is_on_biz_app = coalesce(?, is_on_biz_app), last_status_sync_at = ?
     WHERE phone_number_id = ? AND workspace_id = ?`,
  ).bind(st.display_phone_number ?? null, st.verified_name ?? null, st.quality_rating ?? null, st.messaging_limit_tier ?? null, st.throughput?.level ?? null, st.name_status ?? null,
    st.platform_type ?? null, st.is_on_biz_app === undefined ? null : st.is_on_biz_app ? 1 : 0, now, phoneNumberId, workspaceId).run();
  const tier = st.messaging_limit_tier ? TIER_LIMITS[st.messaging_limit_tier] : undefined;
  const row = await env.DB.prepare('SELECT onboarding FROM phone_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first<{ onboarding: string | null }>();
  const limits = { ...(tier !== undefined ? { tier } : {}), ...(row?.onboarding === 'business_app' ? { mps: BUSINESS_APP_MPS } : {}) };
  const stub = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
  if (Object.keys(limits).length) await stub.setNumberLimits(phoneNumberId, limits);
  // The rating Meta reports is a health signal too (a webhook can be missed): RED / YELLOW worsen the state, GREEN recovers it.
  if (st.quality_rating) await stub.applyNumberHealth(phoneNumberId, { kind: 'rating', rating: st.quality_rating });
}

/** Reads the number's state from Meta into D1 (no-op on a Graph failure; the caller decides whether that matters). */
export async function pullStatus(env: Env, workspaceId: string, phoneNumberId: string, token: string): Promise<boolean> {
  const st = await fetchPhone(env, token, phoneNumberId);
  if (!st.ok) return false;
  await applyStatus(env, workspaceId, phoneNumberId, st.value, Date.now());
  return true;
}

// ---- connect ---------------------------------------------------------------------------------------------------------

/** Another workspace already has this number or WABA (or is in the middle of connecting it). Never silently moved. */
async function conflicts(env: Env, workspaceId: string, wabaId: string, phoneNumberId: string): Promise<boolean> {
  const [num, cred, waba, platform] = await env.DB.batch([
    env.DB.prepare("SELECT 1 FROM phone_numbers WHERE phone_number_id = ? AND workspace_id != ? AND (status = 'active' OR registration IN ('pending', 'failed', 'locked'))").bind(phoneNumberId, workspaceId),
    env.DB.prepare('SELECT 1 FROM waba_credentials WHERE waba_id = ? AND workspace_id != ?').bind(wabaId, workspaceId),
    env.DB.prepare("SELECT 1 FROM phone_numbers WHERE waba_id = ? AND workspace_id != ? AND (status = 'active' OR registration IN ('pending', 'failed', 'locked'))").bind(wabaId, workspaceId),
    // The platform number is nobody's own number: a store row carrying its id would shadow it in every lookup keyed by that id.
    env.DB.prepare('SELECT 1 FROM shared_numbers WHERE phone_number_id = ?').bind(phoneNumberId),
  ]);
  return [num, cred, waba, platform].some((r) => (r!.results as unknown[]).length > 0);
}

/** The business id when Meta confirms it owns the WABA, else null (logged as `business_id_unverified`, no phone numbers, never throws). */
async function verifiedBusinessId(env: Env, workspaceId: string, token: string, businessId: string, wabaId: string): Promise<string | null> {
  const owned = await listOwnedWabas({ token, graphVersion: env.META_GRAPH_VERSION, businessId });
  if (owned.ok && owned.value.includes(wabaId)) return businessId;
  alert('business_id_unverified', { workspace: workspaceId, why: owned.ok ? 'not_owner' : 'graph_error' });
  return null;
}

/**
 * Embedded Signup finished in the browser: turn its one-time code into a working number.
 * Order matters. The code lives 30 seconds, so it is exchanged first (only fast D1 reads precede it). Nothing is stored
 * until the token has proved it can read the WABA and the number (otherwise anyone could park a token on someone else's WABA).
 * After that every step is resumable: a failure leaves the number `disconnected` with the step that failed visible, and
 * `resumeSetup` (POST /numbers/:id/register) finishes it without a new code.
 */
export async function connectNumber(env: Env, workspaceId: string, req: ConnectNumberRequest): Promise<NumberResult> {
  const cfg = signupConfig(env);
  const { wabaId, phoneNumberId } = req;
  if (await conflicts(env, workspaceId, wabaId, phoneNumberId)) return fail(409, 'number_conflict', 'number_belongs_to_another_workspace');

  const ex = await exchangeCode(env, cfg.appId, req.code);
  if (!ex.ok) return ex.retryable ? fail(503, 'signup_unavailable', 'code_exchange_unavailable') : fail(400, 'signup_failed', 'code_rejected');
  const token = ex.value.access_token;
  const owner = await tokenOwner(env, cfg.appId, token);

  const listed = await fetchWabaNumbers(env, token, wabaId);
  if (!listed.ok) return listed.retryable ? fail(503, 'signup_unavailable', 'waba_unreachable') : fail(400, 'signup_failed', 'waba_not_accessible');
  const phone = listed.value.data.find((p) => p.id === phoneNumberId);
  if (!phone) return fail(400, 'signup_failed', 'number_not_in_waba');

  // The business id is browser-supplied: keep it only when Meta, asked with the merchant's own token, lists this WABA among that business's. Never fails the connect.
  const businessId = req.businessId ? await verifiedBusinessId(env, workspaceId, token, req.businessId, wabaId) : null;

  const existing = await env.DB.prepare(`SELECT ${NUMBER_COLUMNS} FROM phone_numbers WHERE phone_number_id = ?`).bind(phoneNumberId).first<NumberRow>();
  const mine = existing?.workspace_id === workspaceId;
  const cloud = req.event === 'FINISH';
  const now = Date.now();
  const tokenEnc = await encryptSecret(token, cfg.encKey, workspaceId);
  // The PIN is stored before Meta ever sees it, so a crash between the two can never lose the one that was registered.
  const pinEnc = cloud ? (mine && existing.pin_enc ? existing.pin_enc : await encryptSecret(generatePin(), cfg.encKey, workspaceId)) : null;
  const registration: NumberRow['registration'] = cloud ? (mine && existing.registration === 'registered' ? 'registered' : 'pending') : 'not_needed';

  const cred = await env.DB.prepare(
    `INSERT INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at, business_id) VALUES (?, ?, ?, 'own', ?, ?, ?)
     ON CONFLICT(waba_id) DO UPDATE SET token_enc = excluded.token_enc, updated_at = excluded.updated_at, business_id = coalesce(excluded.business_id, waba_credentials.business_id)
     WHERE waba_credentials.workspace_id = excluded.workspace_id`,
  ).bind(wabaId, workspaceId, tokenEnc, now, now, businessId).run();
  if (!cred.meta.changes) return fail(409, 'number_conflict', 'number_belongs_to_another_workspace');
  // Who connected it: asked of Meta about the token we just exchanged (never the browser's claim), kept as a keyed hash so Meta's deletion callback can find the person's mapping.
  await recordSignupUser(env, workspaceId, wabaId, owner, now);
  // Reconnecting keeps what was already learned; a number released by another workspace starts clean. The WHERE is the race guard.
  const up = await env.DB.prepare(
    `INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, kind, onboarding, pin_enc, registration, display_phone, connected_at, subscribed_at)
     VALUES (?, ?, ?, ?, 'own', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(phone_number_id) DO UPDATE SET waba_id = excluded.waba_id, workspace_id = excluded.workspace_id, status = excluded.status, kind = 'own', onboarding = excluded.onboarding,
       pin_enc = excluded.pin_enc, registration = excluded.registration, display_phone = coalesce(excluded.display_phone, phone_numbers.display_phone), subscribed_at = NULL
     WHERE phone_numbers.workspace_id = excluded.workspace_id OR (phone_numbers.status = 'disconnected' AND coalesce(phone_numbers.registration, '') NOT IN ('pending', 'failed', 'locked'))`,
  ).bind(phoneNumberId, wabaId, workspaceId, mine ? existing.status : 'disconnected', cloud ? 'cloud_api' : 'business_app', pinEnc, registration, phone.display_phone_number ?? null, mine ? existing.connected_at : null).run();
  if (!up.meta.changes) return fail(409, 'number_conflict', 'number_belongs_to_another_workspace');
  if (existing && !mine) {
    // Released by another workspace: nothing of its sync history or status carries over.
    await env.DB.prepare('UPDATE phone_numbers SET sync_requested_at = NULL, history_sync = NULL, contacts_sync = NULL, connected_at = NULL, last_status_sync_at = NULL WHERE phone_number_id = ?').bind(phoneNumberId).run();
  }
  invalidateWaba(wabaId);
  invalidateNumber(phoneNumberId);
  await applyStatus(env, workspaceId, phoneNumberId, phone, now);
  return completeSetup(env, workspaceId, phoneNumberId, token);
}

/** Retry whatever step of a half-finished connect is still open (webhook subscription, registration, syncs). */
export async function resumeSetup(env: Env, workspaceId: string, phoneNumberId: string): Promise<NumberResult> {
  const row = await numberRow(env, workspaceId, phoneNumberId);
  if (!row) return fail(404, 'not_found', 'no_such_number');
  if (row.kind !== 'own') return fail(400, 'invalid_request', 'not_an_own_number');
  if (row.onboarding === 'business_app' && row.status === 'active' && row.subscribed_at) return fail(400, 'invalid_request', 'registration_not_needed', numberDto(row));
  let token: string;
  try {
    token = await graphTokenFor(env, { phoneNumberId });
  } catch (err) {
    if (err instanceof TokenUnavailable) return fail(400, 'signup_failed', 'token_unavailable', numberDto(row));
    throw err;
  }
  return completeSetup(env, workspaceId, phoneNumberId, token);
}

async function completeSetup(env: Env, workspaceId: string, phoneNumberId: string, token: string): Promise<NumberResult> {
  const cfg = signupConfig(env);
  const warnings: string[] = [];
  const reload = async () => numberDto((await numberRow(env, workspaceId, phoneNumberId))!);
  let row = (await numberRow(env, workspaceId, phoneNumberId))!;

  // A number without webhooks is silently deaf, so a failed subscription is a hard failure, not a warning (Ruling WA-SIGNUP-SUBSCRIBE).
  if (!row.subscribed_at) {
    const sub = await subscribeApp(env, token, row.waba_id);
    if (!sub.ok || !sub.value.success) return graphFailure(sub.ok ? { ok: false, status: 200, code: 0, retryable: false } : sub, 'webhook_subscription_failed', await reload());
    await env.DB.prepare('UPDATE phone_numbers SET subscribed_at = ? WHERE phone_number_id = ?').bind(Date.now(), phoneNumberId).run();
  }

  if (row.onboarding === 'cloud_api' && row.registration !== 'registered') {
    const pin = row.pin_enc ? ((await decryptAny(row.pin_enc, tokenKeys(env), workspaceId))?.value ?? null) : null;
    if (!pin) return fail(400, 'signup_failed', 'pin_unreadable', await reload());
    const reg = await registerNumber(env, token, phoneNumberId, pin);
    if (!reg.ok || !reg.value.success) {
      const locked = !reg.ok && reg.code === REGISTRATION_LOCKED_CODE;
      await env.DB.prepare('UPDATE phone_numbers SET registration = ? WHERE phone_number_id = ?').bind(locked ? 'locked' : 'failed', phoneNumberId).run();
      if (locked) return fail(429, 'registration_locked', 'registration_locked_72h', await reload());
      return graphFailure(reg.ok ? { ok: false, status: 200, code: 0, retryable: false } : reg, 'registration_failed', await reload());
    }
    await env.DB.prepare("UPDATE phone_numbers SET registration = 'registered' WHERE phone_number_id = ?").bind(phoneNumberId).run();
  }

  row = (await numberRow(env, workspaceId, phoneNumberId))!;
  if (row.onboarding === 'business_app' && !row.sync_requested_at) {
    // Each sync can be requested once. A refusal is shown to the merchant, never thrown: the number works without the history.
    const now = Date.now();
    const contacts = await requestSync(env, token, phoneNumberId, 'smb_app_state_sync');
    const history = await requestSync(env, token, phoneNumberId, 'history');
    if (!contacts.ok) warnings.push('contacts_sync_refused');
    if (!history.ok) warnings.push('history_sync_refused');
    await env.DB.prepare('UPDATE phone_numbers SET sync_requested_at = ?, contacts_sync = ?, history_sync = ? WHERE phone_number_id = ?')
      .bind(now, contacts.ok ? 'requested' : 'refused', history.ok ? 'requested' : 'refused', phoneNumberId).run();
  }

  const now = Date.now();
  await env.DB.prepare("UPDATE phone_numbers SET status = 'active', connected_at = coalesce(connected_at, ?) WHERE phone_number_id = ? AND workspace_id = ?").bind(now, phoneNumberId, workspaceId).run();
  await pullStatus(env, workspaceId, phoneNumberId, token); // best effort: the numbers screen has a refresh button
  invalidateNumber(phoneNumberId);
  await onNumberConnected(env, { workspaceId, phoneNumberId, wabaId: row.waba_id, kind: 'own' });
  console.log(JSON.stringify({ audit: 'number_connected', workspace: workspaceId, phoneNumberId, onboarding: row.onboarding }));
  return { ok: true, number: await reload(), warnings };
}

// ---- refresh and disconnect ------------------------------------------------------------------------------------------

export async function refreshNumber(env: Env, workspaceId: string, phoneNumberId: string): Promise<NumberResult> {
  const row = await numberRow(env, workspaceId, phoneNumberId);
  if (!row) return fail(404, 'not_found', 'no_such_number');
  let token: string;
  try {
    token = await graphTokenFor(env, { phoneNumberId });
  } catch (err) {
    if (err instanceof TokenUnavailable) return fail(400, 'signup_failed', 'token_unavailable', numberDto(row));
    throw err;
  }
  const st = await fetchPhone(env, token, phoneNumberId);
  if (!st.ok) return graphFailure(st, 'status_unavailable', numberDto(row));
  await applyStatus(env, workspaceId, phoneNumberId, st.value, Date.now());
  return { ok: true, number: numberDto((await numberRow(env, workspaceId, phoneNumberId))!), warnings: [] };
}

/**
 * Takes a merchant's own number out of service. The local change always happens (sending stops at once); the Meta-side
 * clean-up is best effort and reported as warnings. The webhook subscription and the credential go only when no other
 * number of this workspace still uses the WABA.
 */
export async function disconnectNumber(env: Env, workspaceId: string, phoneNumberId: string): Promise<NumberResult> {
  const row = await numberRow(env, workspaceId, phoneNumberId);
  if (!row) return fail(404, 'not_found', 'no_such_number');
  if (row.kind !== 'own') return fail(400, 'invalid_request', 'not_an_own_number');
  const warnings: string[] = [];
  let token: string | null = null;
  try {
    token = await graphTokenFor(env, { phoneNumberId });
  } catch (err) {
    if (!(err instanceof TokenUnavailable)) throw err;
    warnings.push('token_unavailable');
  }
  const others = await env.DB.prepare("SELECT 1 FROM phone_numbers WHERE waba_id = ? AND phone_number_id != ? AND kind = 'own' AND status = 'active'").bind(row.waba_id, phoneNumberId).first();
  // Stop first, clean up after: the cache entry for this isolate is dropped before and after the write.
  invalidateNumber(phoneNumberId);
  await env.DB.prepare("UPDATE phone_numbers SET status = 'disconnected', pin_enc = NULL, subscribed_at = NULL WHERE phone_number_id = ? AND workspace_id = ?").bind(phoneNumberId, workspaceId).run();
  if (token && row.onboarding === 'cloud_api') {
    const d = await deregisterNumber(env, token, phoneNumberId);
    if (!d.ok) warnings.push('deregister_failed');
  }
  if (!others) {
    if (token) {
      const u = await unsubscribeApp(env, token, row.waba_id);
      if (!u.ok) warnings.push('unsubscribe_failed');
    }
    await env.DB.prepare('DELETE FROM waba_credentials WHERE waba_id = ? AND workspace_id = ?').bind(row.waba_id, workspaceId).run();
  }
  invalidateWaba(row.waba_id);
  await resolveNoticesForWaba(env, workspaceId, row.waba_id, 'disconnect').catch(() => undefined); // the owner's decision is made: the Meta-user notice about this WABA is settled
  console.log(JSON.stringify({ audit: 'number_disconnected', workspace: workspaceId, phoneNumberId, warnings }));
  return { ok: true, number: numberDto((await numberRow(env, workspaceId, phoneNumberId))!), warnings };
}

export { HISTORY_DECLINED_CODE };
