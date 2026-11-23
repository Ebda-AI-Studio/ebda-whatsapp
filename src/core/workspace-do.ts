import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { DEFAULT_CHUNK_ROWS, exportTable, highWaterMarks } from './backup-export';
import { BACKUP_HOUR_LOCAL, BACKUP_ORDER, BACKUP_TABLES, BACKUP_TIME_ZONE, backupManifestSchema, backupPrefix, nextLocalHour, sha256Hex, signManifest, toNdjson, verifyManifestSignature, type BackupManifest } from './backup';
import { DO_MIGRATIONS, migrate } from './do-migrations';
import { SL_OPS, doStorageOps, type SlOp } from './smart-layer/storage-do';
import type { SendResult } from './meta/client';
import type { CoexMessage, InboundMessage, StatusEvent, StatusPricing, SyncedContact } from './meta/webhook-schema';
import type { SendJob } from './send-queue';
import { jobKind, sendToMeta } from './send-queue';
import type { MessageDto, SendMessageRequest } from './api/contract';
import { MESSAGE_COLUMNS, WINDOW_MS, messageDto, type MessageRow } from './dto';
import { activeNumberFor } from './routing';
import { eraseSharedFor } from './shared/shared-number';
import { dropErased } from './erasure';
import { deleteTargets } from './erasure-targets';
import { exportContact, mergeContacts, renameContact } from './contact-data';
import { proactiveRecsView, runProactiveRecs, writeProactiveRecs } from './store-link/proactive-recs';
import { RETENTION_BATCH, RETENTION_MAX_BATCHES, cutoffFor, hasExpired, purgeBatch, purgeOldEvents, retentionView, stillReferenced, writeRetentionDays } from './retention';
import { MEDIA_FETCH_MAX_ATTEMPTS, downloadToR2, outboundMediaFor } from './media';
import { detectOptOutMessage, matchOptIn } from './consent';
import { MEMBER_BLOCK_MS, QUALITY_ERROR_CODES, blockMember, blocksTemplates, currentHealth, memberBlockedUntil, isSuspended, debtHold, storeHold, suspensionState, type SuspensionState, HEALTH_STATES, lastSignalAt, logHealth, mirrorHealth, nextHealth, noteQualityError, recordSignalAt, setSuspendedFlag, signalSource, worsened, type HealthSignal, type HealthState } from './numbers/health';
import { syncSuspendedMirror } from './ops/suspension-mirror';
import { applySharedHealth, noteSharedError, noteSharedSend } from './numbers/health-events';
import { writeSessionState } from './identity/session';
import { DAILY_KINDS, addTask, dailyHour, retryDelayMs, claimDueTasks, earliestDue, type TaskKind } from './scheduler';
import { sendJobSchema } from './send-queue';
import { phoneDigits } from './text-normalise';
import { conversationDto, type ConversationRow } from './dto';
import type { ConversationDto, NoteDto } from './api/contract';
import { DEFAULT_MPS, DEFAULT_TIER, TIER_WINDOW_MS, bucketDecision } from './throttle';
import { bodyTextOf, componentsSchema, paramCount, renderTemplate } from './templates';
import { isEnumLikeReason, knownReason, rejectionAdvice } from './template-advice';
import { refreshPendingWith } from './templates-service';
import { graphTokenFor } from './numbers/token';
import type { TemplateDto } from './api/contract';
import type { StoreEvent } from './api/store-events';
import type { z } from 'zod';
import type { LinkHost, OutboundRow } from './store-link/host';
import { applyStoreEvent, type StoreEventOutcome } from './store-link/events';
import { getState, putState, readSettings, writeSettings, type StoreLinkSettings } from './store-link/settings';
import { CONFIRM_MAX_PENDING, CONFIRM_TTL_MS, type ConfirmOutcome } from './settings-confirm';
import { ensureCatalogReconcile, runCatalogReconcile, runCatalogSync } from './store-link/catalog';
import { provisionCatalog, type ProvisionResult } from './store-link/catalog-provision';
import { commerceAuth, ensureCommerce, type CommerceState } from './store-link/catalog-commerce';
import { catalogStatus } from './store-link/catalog-status';
import { errClass, safeMessage, alert, bindAlerts } from './observability';
import { recordClick } from './campaigns/campaigns';
import { campaignReport, consentEvidence } from './campaigns/report';
import { PAGE_SIZE, PARK_MS, campaignActivate, campaignPage, campaignStart, cancelCampaign, createCampaign, deleteDraft, endInstance, gateFor, getCampaign, launchCampaign, listCampaigns, pauseCampaign, resumeCampaign, sendCampaign, settleWallet, sweepCampaigns, type CreateArgs } from './campaigns/campaigns';
import { audiencePage, createSegment, deleteSegment, getSegment, listSegments, previewAudience, updateSegment } from './campaigns/segments';
import { MAX_QUICK_REPLIES, type QuickReplyDto, type SegmentCriteria } from './api/contract';
import { MAX_IMPORT_ROWS, applyImportChunk, createImport, failImport, importState, importSummary, listContacts, listImports, listRejects, setContactTags, type ApplyArgs, type ContactQuery, type ImportState } from './campaigns/contacts';
import type { DigestDto, AgentSettingsDto, BotFunnelDto, CatalogStatusDto } from './api/contract';
import { funnelOnce } from './funnel';
import { digestCounts, digestEnabled, setDigestEnabled } from './digest';
import { holdCredits, lowCreditsThreshold, monthlyAllowance, creditBalance, creditsAvailable, expireGrant, expireGrantFraction, expirePackUnused, grantCredits, lastGrantStart, postCredit, releaseHold, revokeGrantExcess, settleHold, upgradeGrant, type CreditKind, type HoldResult, type Posted } from './ai/credits';
import { staffReplied } from './ai/handoff';
import { abandonVoiceTurn } from './ai/agent';
import { dropProfile } from './ai/context';
import { DIGEST_HOUR_LOCAL, ensureDigestTask, prepareOwnerNotice, runHandoffDigest } from './ai/handoff-notify';
import { knowledgeReady, nextKbVersion, prepareChunks, runCatalogEmbed, runKbIndex, scheduleCatalogEmbed, stageFaq } from './ai/knowledge';
import { hasApiKey, planAgentUpdate, readAgentSettings, writeAgentSettings, type AgentSettingsUpdate, type SettingsRefusal } from './ai/settings';
import { OTP_RATE_WINDOW_MS } from './otp-policy';
import { OTP_MASK } from './templates';
import type { OtpResult } from './otp';
import { queueTemplate } from './store-link/outbound';
import { recordConsentProof } from './consent-proof';
import { forgetBuyer, noteOptOutChange, pushOptOut } from './store-link/consent';
import { storeLink } from './store-link';
import { eraseFunnelMarkers, funnelRollup, readFunnel } from './bot-funnel';
import { botInputFrom, botInputSchema, orderingActive } from './ordering/bot';
import { agentActive } from './ai/agent';
import { runTurn } from './ai/router';
import { frontDeskActive, frontDeskOwnsReplies } from './front-desk';
import { testConnector } from './connectors/registry';
import { connectorDto, deleteConnector, listConnectors, planConnectorPut, writeConnector, type PutRefusal } from './connectors/store';
import type { ConnectorDto, ConnectorPut } from './api/contract';
import { Billing, type ClaimBill } from './billing/engine';
import { unusedCreditsToRemove } from '../../foundation/instapay-state';
import { checkMirror, drainOutbox } from './billing/mirror';
import { buildStatement } from './billing/statement';
import { runTrueup } from './billing/trueup';
import { countryToDigits } from './billing/country';
import type { WalletPosted } from './billing/engine';
import { PRICING_MAX_AGE_MS, applyPricing, copyCursor, fundingOf, pullPricing } from './billing/pricing';
import { parentHoldRef } from './campaigns/campaigns';
import { indexContactName, rebuildContactIndex } from './contact-index';
import { ftsMatch, searchFoldOf, searchWords, syncSearchFold } from './search-fold';
import { currentEvent, rollRenewals } from './billing/subscriptions';
import { overdueOne } from './billing/instapay';
import { bridgeForWorkspace } from './store-link';
import { assignSeat, listSeats, pruneSeats, removeSeat, seatState, seatsOverLimit, type AssignResult, type SeatRow, type SeatState } from './seats';
import { applyEntitlement, expireSubscription, runCreditMonth, featureAllowed, marketingBlocked, memberLimit, readEntitlement, serviceAllowed, type EntitlementEvent, type PlanFeature } from './billing/entitlements';
import { closeUnanswered, handleCodReply, pushErasedOrders, merchantCod, pushCodOutcome, type MerchantCodArgs } from './store-link/orders';

/** How many realtime events a client can resync from. */
export const EVENTS_KEPT = 1000;
export const PREVIEW_CHARS = 280;
export const INLINE_BODY_BYTES = 1024;
/** A claim older than this is presumed crashed and may be re-claimed once (duplicate risk vs drop risk: we accept one possible duplicate). */
/** Headers the Worker sets on the upgrade it forwards to the DO (never read from the client: the route overwrites them). */
export const WS_EXP_HEADER = 'x-socket-token-exp';
export const WS_ROLE_HEADER = 'x-socket-role';
export const WS_USER_HEADER = 'x-socket-user';
export const WS_SESSION_HEADER = 'x-socket-session';
/** WA-6: a socket never outlives this, whatever the token's own expiry (the client reconnects through the full guard). */
export const WS_MAX_LIFETIME_S = 600;
/** WA-6: how often open sockets are re-checked against the live membership and the session. */
export const WS_SWEEP_MS = 60_000;
/** Close code for a socket whose access token has expired: the client refreshes its token and reconnects. */
export const WS_CLOSE_TOKEN_EXPIRED = 4401;
/** Close code for a staff socket whose seat is gone (removed, left the team, or beyond the package's limit): it receives nothing more (WA-SEATS-1). */
export const WS_CLOSE_NO_SEAT = 4403;
type SocketAttachment = { exp: number; role: string; userId?: string; sessionId?: string };
export const BOT_TURN_MAX_ATTEMPTS = 6;
export const STALE_CLAIM_MS = 2 * 60 * 1000;
/** failed sits between sent and delivered: it beats a late 'sent', but never undoes a delivery. */
const STATUS_RANK = { sent: 1, failed: 2, delivered: 3, read: 4 } as const;

export type IngestBatch = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[]; receivedAt: number };
export type CoexBatch = { phoneNumberId: string; echoes: CoexMessage[]; history: CoexMessage[]; contacts: SyncedContact[] };
export type IngestResult = { stored: number; duplicates: number; replies: SendJob[] };
export type WorkspaceConfig = { autoReplyText?: string; optInKeywords?: string[] };
const TEMPLATE_COLS = 'name, language, category, status, components, rejected_reason, updated_at, meta_id, label, quality';
type TemplateRowSql = { name: string; language: string; category: string; status: string; components: string; rejected_reason: string | null; updated_at: number; meta_id: string | null; label: string | null; quality: string | null };
const TEMPLATE_EDIT_DAY_MS = 86_400_000;
const TEMPLATE_EDIT_MONTH_MS = 30 * 86_400_000;
const TEMPLATE_EDITS_PER_MONTH = 10;
const TEMPLATE_INFLIGHT_MS = 5 * 60_000;
const TEMPLATE_PENDING_AFTER_MS = 60 * 60_000;

export type OutboundRefusal = 'window_closed' | 'opted_out' | 'plan_blocked' | 'plan_required' | 'wallet_empty' | 'funding_unknown' | 'rate_unavailable' | 'template_not_approved' | 'unsupported_media' | 'invalid_request' | 'not_found';
export type QueueOutboundResult = { ok: true; message: MessageDto; job: SendJob | null } | { ok: false; reason: OutboundRefusal; message?: string };
/** What a scheduled task may carry. Stored as JSON and re-validated when it runs. */
export type TaskPayload = { job?: SendJob; phoneNumberId?: string; reason?: 'tier' | 'throughput' | 'frequency_cap' | 'event'; n?: number; messageId?: number; mediaId?: string; orderId?: string };
export type ClaimResult = 'claimed' | 'already_sent' | 'in_flight' | 'dropped' | 'deferred';
export type ThrottleReport = { tier: number; mps: number; usedInWindow: number; waiting: number; nextSlotAt: number | null };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** First PREVIEW_CHARS user-perceived characters; never splits an emoji or a combining mark. */
export function previewOf(text: string): string {
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (n++ === PREVIEW_CHARS) break;
    out += segment;
  }
  return out;
}

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;
/** R2 accepts at most 1000 keys per delete call. */
export const R2_DELETE_BATCH = 1000;

export type EraseResult = { found: boolean; messages: number; statusEvents: number; r2Objects: number; r2Pending: number; /** When the Durable Object finished (its own clock): the erasure record is completed with it. */ completedAt: number };

/** One tenant's data: a SQLite-backed Durable Object per workspace. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Highest event seq already pushed to connected sockets (earlier events are history for a fresh connection). */
  private lastBroadcast = 0;
  private flushScheduled = false;
  /** Set by the wallet when it adds a scheduler row inside a transaction; the next awaiting caller re-arms the alarm. */
  private armPending = false;
  private readonly billing: Billing;
  private pricingPull: Promise<void> | null = null;
  private pricingPulledAt = 0;
  /** Set once the workspace was deleted (OFFBOARD-1): the storage holds only a tombstone and nothing recreates the schema. */
  private offboarded = false;
  /** Set at the START of a deletion: new snapshots are refused and the wipe waits for the ones in flight (so no backup lands after the backups were listed). */
  private offboarding = false;
  private readonly snapshotRuns = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    bindAlerts({ env, waitUntil: (p) => ctx.waitUntil(p) }); // alert() from DO code outlives the call via the DO's own waitUntil
    this.billing = new Billing(this.sql, () => this.workspaceId, () => { this.armPending = true; });
    // 'ping' from a hibernated client is answered without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.get('offboarded')) { this.offboarded = true; return; }
      migrate(ctx.storage);
      this.reindexIfEmpty();
      this.reindexContactsIfEmpty();
      // Platform flag SEARCH_FOLD ('v2' = shared foundation fold). Off by default; flipping it re-indexes this workspace once, in one transaction.
      // Failure-isolated: a throw rolls the whole transaction back (marker + index), the old index keeps serving, an alert fires, and the next wake retries. It must never fail construction.
      try {
        this.ctx.storage.transactionSync(() => syncSearchFold(this.sql, env.SEARCH_FOLD === 'v2', () => this.rebuildFts()));
      } catch (err) {
        alert('search_fold_rebuild_failed', { workspace: this.workspaceId, error: errClass(err) });
      }
      this.lastBroadcast = this.sql.exec<{ s: number | null }>('SELECT max(seq) AS s FROM events').one().s ?? 0;
    });
  }

  /**
   * Refreshes the copy of the price inputs from D1 when it is older than PRICING_MAX_AGE_MS (or `always`). Concurrent callers share one
   * pull, so the very first send of a workspace never prices itself from an empty copy. A failed pull keeps the old copy and retries soon.
   */
  async ensurePricing(now = Date.now(), always = false): Promise<void> {
    if (this.pricingPull) return this.pricingPull;
    if (!always && now - this.pricingPulledAt < PRICING_MAX_AGE_MS) return;
    this.pricingPull = (async () => {
      try {
        const snap = await pullPricing(this.env, this.workspaceId, copyCursor(this.sql));
        this.ctx.storage.transactionSync(() => {
          applyPricing(this.sql, snap);
          if (snap.rates.length || snap.fx.length || snap.settings.length) this.billing.retryPendingRates(now); // a new version may be the one a delivery waited for
        });
        await this.flushArm();
        this.pricingPulledAt = now;
      } catch (err) {
        this.pricingPulledAt = now - PRICING_MAX_AGE_MS + 60_000;
        alert('pricing_pull_failed', { workspace: this.workspaceId, error: errClass(err) });
      } finally {
        this.pricingPull = null;
      }
    })();
    return this.pricingPull;
  }

  private lastEagerPull = 0;
  /** A number the copy does not know may have been connected after the last pull: look again at once (at most every 10 s), then decide. */
  private async repullIfUnknown(phoneNumberId: string, now: number): Promise<void> {
    if (fundingOf(this.sql, phoneNumberId) !== 'unknown' || now - this.lastEagerPull < 10_000) return;
    this.lastEagerPull = now;
    await this.ensurePricing(now, true);
  }

  async refreshPricing(): Promise<void> {
    await this.ensurePricing(Date.now(), true);
  }

  private async flushArm(): Promise<void> {
    if (!this.armPending) return;
    this.armPending = false;
    await this.arm();
  }

  /** The workspace id is the DO name. Never fall back to the hex id: idFromName(hex) is a different, empty DO. */
  private get workspaceId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error('WorkspaceDO must be addressed with idFromName(workspaceId)');
    return name;
  }

  private bodyColumns(text: string | undefined, r2Key: string | undefined): { preview: string | null; body: string | null; key: string | null } {
    if (text === undefined) return { preview: null, body: null, key: null };
    return { preview: previewOf(text), body: r2Key ? null : text, key: r2Key ?? null };
  }

  async ingest(batch: IngestBatch, initialConfig: WorkspaceConfig = {}): Promise<IngestResult> {
    let config = initialConfig;
    const workspaceId = this.workspaceId;
    // While the ordering bot is on it owns the conversation: the generic auto reply would talk over it.
    const ordering = orderingActive(this.host());
    const agent = agentActive(this.host());
    const front = frontDeskActive(this.host());
    if (ordering || agent || frontDeskOwnsReplies(this.host(), Date.now())) config = { ...config, autoReplyText: undefined };
    // Large bodies go to R2 first (outside the transaction); skipped for a wamid we already stored, so redelivery writes nothing.
    const bodies = new Map<string, string>();
    for (const m of batch.inbound) {
      if (!m.text || byteLength(m.text) <= INLINE_BODY_BYTES) continue;
      if (this.sql.exec('SELECT 1 FROM messages WHERE wamid = ?', m.wamid).toArray().length) continue;
      const key = `bodies/${workspaceId}/${m.wamid}`;
      await this.env.MEDIA.put(key, m.text);
      bodies.set(m.wamid, key);
    }
    if (batch.statuses.length) await this.ensurePricing();
    await this.ensureBackupAlarm();
    const result: IngestResult = { stored: 0, duplicates: 0, replies: [] };
    let scheduledMedia = false;
    let linkWork = false;
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const m of batch.inbound) {
        const contactId = this.sql.exec<{ id: number }>(
          `INSERT INTO contacts (wa_id, profile_name, last_inbound_at) VALUES (?, ?, ?)
           ON CONFLICT(wa_id) DO UPDATE SET profile_name = CASE WHEN name_edited = 1 THEN profile_name ELSE coalesce(excluded.profile_name, profile_name) END, last_inbound_at = max(coalesce(last_inbound_at, 0), excluded.last_inbound_at)
           RETURNING id`,
          m.from, m.profileName ?? null, m.ts,
        ).one().id;
        if (m.profileName) indexContactName(this.sql, contactId);
        const conversationId = this.sql.exec<{ id: number }>(
          `INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?)
           ON CONFLICT(contact_id) DO UPDATE SET last_message_at = max(coalesce(last_message_at, 0), excluded.last_message_at)
           RETURNING id`,
          contactId, m.ts,
        ).one().id;
        const optOut = detectOptOutMessage(m);
        const cols = this.bodyColumns(m.text ?? m.caption, bodies.get(m.wamid));
        const inserted = this.sql.exec<{ id: number }>(
          `INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, body_r2_key, media_mime, created_at, updated_at)
           VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wamid) DO NOTHING RETURNING id`,
          m.wamid, conversationId, m.type, cols.preview, cols.body, cols.key, m.media?.mime ?? null, m.ts * 1000, now,
        ).toArray()[0];
        if (!inserted) {
          result.duplicates++;
          // Redelivery heals a lost enqueue: offer the reply again until its send is claimed (claimSend dedupes).
          const claimed = this.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', `reply:${m.wamid}`).toArray().length > 0;
          if (!claimed && !optOut && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
          continue;
        }
        funnelOnce(this.host(), 'first_inbound');
        result.stored++;
        this.indexMessage(inserted.id, cols.preview);
        if (m.media) {
          addTask(this.sql, 'media_fetch', now, { messageId: inserted.id, mediaId: m.media.id, phoneNumberId: batch.phoneNumberId });
          scheduledMedia = true;
        }
        this.emitMessageCreated(inserted.id);
        this.sql.exec('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
        if (optOut) {
          // A reply to STOP is optional under Meta's rules and we send none: the opt-out is silent and immediate.
          const wasOptedOut = this.sql.exec<{ o: number | null }>('SELECT opted_out_at AS o FROM contacts WHERE id = ?', contactId).one().o != null;
          this.sql.exec("UPDATE contacts SET opted_out_at = max(coalesce(opted_out_at, 0), ?), consent_source = 'keyword_stop', consent_at = ? WHERE id = ?", m.ts * 1000, now, contactId);
          if (!wasOptedOut && noteOptOutChange(this.host(), m.from, true, m.ts * 1000, now)) linkWork = true;
        } else if (m.type === 'text' && m.text && matchOptIn(m.text, config.optInKeywords)) {
          const cleared = this.sql.exec("UPDATE contacts SET opted_out_at = NULL, consent_source = 'keyword_start', consent_at = ? WHERE id = ? AND opted_out_at IS NOT NULL", now, contactId).rowsWritten > 0;
          if (cleared) recordConsentProof(this.sql, { contactId, source: 'opt_in', attestedBy: 'customer', wording: matchOptIn(m.text, config.optInKeywords) ?? '', at: now }); // the keyword only, not the customer's message
          if (cleared && noteOptOutChange(this.host(), m.from, false, now, now)) linkWork = true;
        }
        const wasCodReply = !!m.reply && handleCodReply(this.host(), m, batch.phoneNumberId, now);
        if (wasCodReply) linkWork = true;
        else if ((ordering || agent || front) && !optOut && (m.type === 'text' || m.type === 'interactive' || m.type === 'order' || m.type === 'image' || (agent && (m.type === 'audio' || m.type === 'video' || m.type === 'document' || m.type === 'sticker')) || ((ordering || agent) && m.type === 'location' && !!m.location))) {
          addTask(this.sql, 'bot_turn', now, botInputFrom(m, inserted.id, batch.phoneNumberId));
          linkWork = true;
        }
        this.emitConversationUpdated(conversationId);
        if (!optOut && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
      }
      for (const st of batch.statuses) this.applyStatusSync(st);
    });
    if (scheduledMedia || linkWork || this.armPending) {
      this.armPending = false;
      await this.arm();
    }
    for (const f of this.freshQualityErrors.splice(0)) await this.noteSendError(batch.phoneNumberId, f.code, Date.now(), f.template);
    return result;
  }

  /**
   * Coexistence (a number kept on the merchant's WhatsApp Business app). Echoes are what the merchant typed in the app: stored as
   * outgoing messages by 'app', never sent. History is the past chat, stored with its original timestamps. Neither opens a 24 h
   * window, raises unread, wakes the bot or agent, or sends an auto reply. Synced contacts get NO consent. All idempotent on wamid.
   */
  async ingestCoexistence(batch: CoexBatch): Promise<{ echoes: number; history: number; contacts: number; duplicates: number }> {
    const workspaceId = this.workspaceId;
    const all = [...batch.echoes.map((m) => ({ m, live: true })), ...batch.history.map((m) => ({ m, live: false }))];
    const bodies = new Map<string, string>();
    for (const { m } of all) {
      if (!m.text || byteLength(m.text) <= INLINE_BODY_BYTES) continue;
      if (this.sql.exec('SELECT 1 FROM messages WHERE wamid = ?', m.wamid).toArray().length) continue;
      const key = `bodies/${workspaceId}/${m.wamid}`;
      await this.env.MEDIA.put(key, m.text);
      bodies.set(m.wamid, key);
    }
    await this.ensureBackupAlarm();
    const out = { echoes: 0, history: 0, contacts: 0, duplicates: 0 };
    let scheduledMedia = false;
    const touched = new Set<number>();
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const { m, live } of all) {
        const { conversationId } = this.ensureConversation(m.customer, m.ts * 1000);
        const cols = this.bodyColumns(m.text ?? m.caption, bodies.get(m.wamid));
        const out_ = m.direction === 'out';
        const status = out_ ? (live ? 'sent' : (m.status ?? 'sent')) : null;
        const inserted = this.sql.exec<{ id: number }>(
          `INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, body_r2_key, media_mime, status, status_rank, author, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wamid) DO NOTHING RETURNING id`,
          m.wamid, conversationId, m.direction, m.type, cols.preview, cols.body, cols.key, live ? (m.media?.mime ?? null) : null,
          status, status ? STATUS_RANK[status as keyof typeof STATUS_RANK] : 0, out_ ? 'app' : null, m.ts * 1000, now,
        ).toArray()[0];
        if (!inserted) {
          out.duplicates++;
          continue;
        }
        live ? out.echoes++ : out.history++;
        this.indexMessage(inserted.id, cols.preview);
        this.sql.exec('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?', m.ts, conversationId);
        touched.add(conversationId);
        if (live) {
          if (m.media) {
            addTask(this.sql, 'media_fetch', now, { messageId: inserted.id, mediaId: m.media.id, phoneNumberId: batch.phoneNumberId });
            scheduledMedia = true;
          }
          // A person answered from the app: the bot stays silent for a fresh handoff window (no-op when none is open).
          staffReplied(this.host(), m.customer, now);
          this.emitMessageCreated(inserted.id);
        }
      }
      for (const c of batch.contacts) {
        const r = this.sql.exec(
          'INSERT INTO contacts (wa_id, profile_name) VALUES (?, ?) ON CONFLICT(wa_id) DO UPDATE SET profile_name = coalesce(profile_name, excluded.profile_name) RETURNING id', c.waId, c.name ?? null,
        );
        const cid = r.one().id as number;
        if (r.rowsWritten) out.contacts++;
        if (c.name) indexContactName(this.sql, cid);
      }
      // One update per conversation, not per message: a history import can carry thousands of messages.
      for (const id of touched) this.emitConversationUpdated(id);
    });
    if (scheduledMedia) await this.arm();
    return out;
  }

  private replyJob(workspaceId: string, batch: IngestBatch, m: InboundMessage, text: string): SendJob {
    return { workspaceId, phoneNumberId: batch.phoneNumberId, to: m.from, text, idempotencyKey: `reply:${m.wamid}`, inboundAt: m.ts * 1000, receivedAt: batch.receivedAt };
  }

  /**
   * Claims the right to send `job` once. Only 'claimed' may call Meta. 'dropped' = nothing left to send (the row was
   * erased with its contact, or an API job lost its row): the consumer acks it without calling Meta.
   */
  async claimSend(job: SendJob, now = Date.now(), opts: { noDefer?: boolean } = {}): Promise<ClaimResult> {
    await this.ensurePricing(now);
    await this.repullIfUnknown(job.phoneNumberId, now);
    let deferred = false;
    const result = this.ctx.storage.transactionSync((): ClaimResult => {
      const claim = this.claimRow(job, now);
      if (claim !== 'claimed') return claim;
      // The wallet decides before Meta's limits do: an unpayable send must not take a tier slot or a throughput token.
      const paid = this.billClaim(job, now);
      if (paid !== 'ok') return paid;
      const wait = this.throttle(job, now);
      if (!wait) return 'claimed';
      if (opts.noDefer) {
        // Time-critical content (a one-time code) is never parked: it fails now and the caller falls back to another channel.
        const row = this.sql.exec<{ id: number }>("UPDATE messages SET status = 'failed', error_reason = 'rate_limited', claim_attempts = max(0, claim_attempts - 1), updated_at = ? WHERE idempotency_key = ? RETURNING id", now, job.idempotencyKey).toArray()[0];
        if (row) this.emitMessageStatus(row.id);
        this.billing.settleHold(job.idempotencyKey, 'rate_limited', now);
        return 'dropped';
      }
      // Over a Meta limit: give the claim back, keep the message 'queued', and let the scheduler release it later.
      this.sql.exec("UPDATE messages SET status = 'queued', claim_attempts = max(0, claim_attempts - 1), updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
      this.addReleaseOnce(job, wait.dueAt, wait.reason);
      deferred = true;
      return 'deferred';
    });
    if (deferred || this.armPending) {
      this.armPending = false;
      await this.arm();
    }
    // A send on the platform number is counted per member (the denominator of its error rate): ids and a count, nothing else. Not awaited: counting never delays a send.
    // Only what can produce the counted errors (a business-initiated TEMPLATE) and only the FIRST claim of a job (`claim_attempts` is 1 on a first claim; a deferral gives it back,
    // a retry or a stale re-claim makes it 2+): a redelivery, a retry or a reply never dilutes the rate.
    if (result === 'claimed' && jobKind(job) === 'template' && this.sql.exec('SELECT 1 FROM store_state WHERE key = ?', `shared.number:${job.phoneNumberId}`).toArray().length
      && this.sql.exec<{ claim_attempts: number }>('SELECT claim_attempts FROM messages WHERE idempotency_key = ?', job.idempotencyKey).toArray()[0]?.claim_attempts === 1) {
      this.ctx.waitUntil(noteSharedSend(this.env, job.phoneNumberId, this.workspaceId, now).catch(() => undefined));
    }
    return result;
  }

  /**
   * Takes the wallet's pre-send decision for a claimed message (see Billing.onClaim). Refused: the message is failed with the reason and,
   * for a campaign message, the campaign pauses (the Phase 6 pause path). Cannot pay yet: the claim is given back, the message stays
   * 'queued' and a wallet_wait row releases it when funds arrive or fails it at wait_until.
   */
  private billClaim(job: SendJob, now: number): 'ok' | 'dropped' | 'deferred' {
    const msg = this.sql.exec<{ id: number; created_at: number }>('SELECT id, created_at FROM messages WHERE idempotency_key = ?', job.idempotencyKey).toArray()[0];
    const last = jobKind(job) === 'template' ? null : this.sql.exec<{ t: number | null }>('SELECT last_inbound_at AS t FROM contacts WHERE wa_id = ?', job.to).toArray()[0]?.t ?? null;
    const bill: ClaimBill = this.billing.onClaim(job, {
      now, createdAt: msg?.created_at ?? now, windowEndsAt: last ? last * 1000 + WINDOW_MS : null, parentRef: parentHoldRef(this.host(), job.idempotencyKey),
    });
    if (bill.kind === 'ok') return 'ok';
    if (bill.kind === 'defer') {
      // The price inputs have never been pulled (D1 unreachable): no wallet decision may run on an empty copy. Give the claim back and try again soon.
      this.sql.exec("UPDATE messages SET status = 'queued', claim_attempts = max(0, claim_attempts - 1), updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
      this.addReleaseOnce(job, now + 60_000, 'pricing_unavailable');
      this.armPending = true;
      alert('pricing_copy_missing', { workspace: this.workspaceId });
      return 'deferred';
    }
    if (bill.kind === 'empty') {
      this.sql.exec("UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE idempotency_key = ?", bill.reason, now, job.idempotencyKey);
      if (msg) this.emitMessageStatus(msg.id);
      if (job.idempotencyKey.startsWith('camp:')) {
        const cid = job.idempotencyKey.split(':')[1];
        this.sql.exec("UPDATE campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'", bill.reason === 'wallet_empty_expired' ? 'wallet_empty' : bill.reason, now, cid);
      }
      if (bill.reason === 'wallet_empty_expired') alert('wallet_wait_expired', { workspace: this.workspaceId });
      return 'dropped';
    }
    this.sql.exec("UPDATE messages SET status = 'queued', claim_attempts = max(0, claim_attempts - 1), updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
    const pending = this.sql.exec("SELECT 1 FROM scheduled_tasks WHERE kind = 'wallet_wait' AND lease_until IS NULL AND json_extract(payload, '$.job.idempotencyKey') = ? LIMIT 1", job.idempotencyKey).toArray().length;
    if (!pending) addTask(this.sql, 'wallet_wait', bill.waitUntil, { job });
    this.armPending = true;
    return 'deferred';
  }

  /** Why this send must not leave right now, or null. Suspended stops everything; a red / restricted number stops business-initiated templates only. */
  private sendRefusal(job: SendJob): 'workspace_suspended' | 'number_restricted' | null {
    if (isSuspended(this.sql)) return 'workspace_suspended';
    if (jobKind(job) === 'template' && (blocksTemplates(currentHealth(this.sql, job.phoneNumberId)) || memberBlockedUntil(this.sql, job.phoneNumberId) > Date.now())) return 'number_restricted';
    return null;
  }

  private freshQualityErrors: { code: number; template: boolean }[] = [];

  private claimRow(job: SendJob, now: number): ClaimResult {
    {
      // WA-NOFREE-1 / WA-GRACE-1: a message that waited in the queue (or an automatic reply) is refused if the plan lapsed meanwhile, whatever its category.
      if (!serviceAllowed(this.sql, now)) {
        const queued = this.sql.exec<{ id: number; status: string }>('SELECT id, status FROM messages WHERE idempotency_key = ?', job.idempotencyKey).toArray()[0];
        if (queued && (queued.status === 'queued' || queued.status === 'retry')) {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = 'plan_required', updated_at = ? WHERE id = ?", now, queued.id);
          this.emitMessageStatus(queued.id);
        }
        // A claim only seconds old may really be with Meta, so it is left to the normal path; one stuck in `claimed` past STALE_CLAIM_MS would be
        // re-claimed and sent by that path, so it is failed here like a queued one.
        const stale = queued?.status === 'claimed' && now - (this.sql.exec<{ u: number }>('SELECT updated_at AS u FROM messages WHERE id = ?', queued.id).one().u) > STALE_CLAIM_MS;
        if (stale) {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = 'plan_required', updated_at = ? WHERE id = ?", now, queued!.id);
          this.emitMessageStatus(queued!.id);
        }
        if (!queued || queued.status === 'queued' || queued.status === 'retry' || stale) {
          this.billing.settleHold(job.idempotencyKey, 'dropped', now);
          return 'dropped';
        }
      }
      const existing = this.sql
        .exec<{ id: number; status: string; updated_at: number; claim_attempts: number }>('SELECT id, status, updated_at, claim_attempts FROM messages WHERE idempotency_key = ?', job.idempotencyKey)
        .toArray()[0];
      if (!existing) {
        // Only auto-reply jobs (no row yet) may create their row; a job created by the API always has one, so a missing row means it was erased.
        if (jobKind(job) !== 'text' || job.idempotencyKey.startsWith('ui:') || !job.text) return 'dropped';
        if (this.sendRefusal(job)) return 'dropped'; // an auto reply that has no row yet: nothing to settle
        if (this.sql.exec('SELECT 1 FROM erased_keys WHERE key = ?', job.idempotencyKey).toArray().length) {
          this.billing.settleHold(job.idempotencyKey, 'erased', now);
          return 'dropped';
        }
        const contactId = this.sql.exec<{ id: number }>(
          'INSERT INTO contacts (wa_id) VALUES (?) ON CONFLICT(wa_id) DO UPDATE SET wa_id = wa_id RETURNING id', job.to,
        ).one().id;
        const conversationId = this.sql.exec<{ id: number }>(
          'INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?) ON CONFLICT(contact_id) DO UPDATE SET last_message_at = excluded.last_message_at RETURNING id',
          contactId, Math.floor(now / 1000),
        ).one().id;
        const replyId = this.sql.exec<{ id: number }>(
          `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, claim_attempts, created_at, updated_at)
           VALUES (?, 'out', 'text', ?, ?, 'claimed', ?, 1, ?, ?) RETURNING id`,
          conversationId, previewOf(job.text), job.text, job.idempotencyKey, now, now,
        ).one().id;
        this.indexMessage(replyId, previewOf(job.text));
        this.emitMessageCreated(replyId);
        this.emitConversationUpdated(conversationId);
        return 'claimed';
      }
      if ((existing.status === 'queued' || existing.status === 'retry') && job.idempotencyKey.startsWith('camp:')) {
        // A campaign message follows its campaign: cancelled = never sent; paused = parked until resume (the send_release row moves, nothing is lost).
        const gate = gateFor(this.host(), job.idempotencyKey);
        if (gate === 'cancelled') {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = 'campaign_cancelled', updated_at = ? WHERE id = ?", now, existing.id);
          this.emitMessageStatus(existing.id);
          this.billing.settleHold(job.idempotencyKey, 'cancelled', now);
          return 'dropped';
        }
        if (gate === 'paused') {
          this.addReleaseOnce(job, now + PARK_MS, 'campaign_paused');
          return 'deferred';
        }
      }
      // Operator suspension and a red / restricted number: NEVER-stale gates read from this workspace's own copy on every claim, so the alarms, retries and queued
      // jobs that never pass the Worker are stopped too (defense in depth next to the Worker's check). Only AFTER the duplicate checks above: a redelivered job
      // whose message already went to Meta keeps its hold (the charge lands later), and a job another attempt holds is still `in_flight`, never acked away.
      const refused = this.sendRefusal(job);
      if (refused && (existing.status === 'queued' || existing.status === 'retry')) {
        this.sql.exec("UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE id = ?", refused, now, existing.id);
        this.emitMessageStatus(existing.id);
        this.billing.settleHold(job.idempotencyKey, 'failed', now);
        return 'dropped';
      }
      if (refused && existing.status === 'claimed' && now - existing.updated_at > STALE_CLAIM_MS && existing.claim_attempts < 2) {
        // A claim nobody finished: it may have reached Meta before the crash, so its hold is NOT released here (a late status settles it); the row just stops being retried.
        this.sql.exec("UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE id = ?", refused, now, existing.id);
        this.emitMessageStatus(existing.id);
        return 'dropped';
      }
      if (existing.status === 'queued' || existing.status === 'retry') {
        // A marketing template that waited (tier, throughput or Meta's frequency cap) must honour an opt-out given meanwhile.
        if (this.marketingToOptedOut(job)) {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = 'opted_out', updated_at = ? WHERE id = ?", now, existing.id);
          this.emitMessageStatus(existing.id);
          this.billing.settleHold(job.idempotencyKey, 'opted_out', now);
          return 'dropped';
        }
        if (this.isMarketingJob(job) && marketingBlocked(this.sql, now)) {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = 'plan_blocked', updated_at = ? WHERE id = ?", now, existing.id);
          this.emitMessageStatus(existing.id);
          this.billing.settleHold(job.idempotencyKey, 'dropped', now);
          return 'dropped';
        }
      }
      if (existing.status === 'queued' || existing.status === 'retry' || (existing.status === 'claimed' && now - existing.updated_at > STALE_CLAIM_MS && existing.claim_attempts < 2)) {
        this.sql.exec("UPDATE messages SET status = 'claimed', claim_attempts = claim_attempts + 1, updated_at = ? WHERE id = ?", now, existing.id);
        return 'claimed';
      }
      return existing.status === 'claimed' ? 'in_flight' : 'already_sent';
    }
  }

  private isMarketingJob(job: SendJob): boolean {
    if (jobKind(job) !== 'template' || !job.template) return false;
    return this.sql.exec<{ category: string }>('SELECT category FROM templates WHERE name = ? AND language = ?', job.template.name, job.template.language).toArray()[0]?.category === 'MARKETING';
  }

  private marketingToOptedOut(job: SendJob): boolean {
    if (jobKind(job) !== 'template' || !job.template) return false;
    const cat = this.sql.exec<{ category: string }>('SELECT category FROM templates WHERE name = ? AND language = ?', job.template.name, job.template.language).toArray()[0]?.category;
    if (cat !== 'MARKETING') return false;
    return this.sql.exec<{ opted_out_at: number | null }>('SELECT opted_out_at FROM contacts WHERE wa_id = ?', job.to).toArray()[0]?.opted_out_at != null;
  }

  private limitsFor(phoneNumberId: string): { tier: number; mps: number; tokens: number; tokens_at: number; alerted_at: number } {
    return (
      this.sql.exec<{ tier: number; mps: number; tokens: number; tokens_at: number; alerted_at: number }>('SELECT tier, mps, tokens, tokens_at, alerted_at FROM number_limits WHERE phone_number_id = ?', phoneNumberId).toArray()[0]
      ?? { tier: DEFAULT_TIER, mps: DEFAULT_MPS, tokens: DEFAULT_MPS, tokens_at: 0, alerted_at: 0 }
    );
  }

  /**
   * The two Meta limits, checked in one transaction with the claim. Returns null to go ahead (and records the slot and
   * the token), or when and why to retry. (1) tier: a recipient whose 24 h window is closed is business-initiated and
   * takes a slot among the number's unique recipients of the rolling 24 h; replies inside an open window never do.
   * (2) throughput: one token per message from a bucket refilled at the number's MPS.
   */
  private throttle(job: SendJob, now: number): { dueAt: number; reason: 'tier' | 'throughput' } | null {
    const pn = job.phoneNumberId;
    const lim = this.limitsFor(pn);
    const contact = this.sql.exec<{ id: number; last_inbound_at: number | null }>('SELECT id, last_inbound_at FROM contacts WHERE wa_id = ?', job.to).toArray()[0];
    const initiated = !(contact?.last_inbound_at && contact.last_inbound_at * 1000 + WINDOW_MS > now);
    const since = now - TIER_WINDOW_MS;
    let needsSlot = false;
    if (initiated && contact) {
      const slot = this.sql.exec<{ started_at: number }>('SELECT started_at FROM tier_slots WHERE phone_number_id = ? AND contact_id = ?', pn, contact.id).toArray()[0];
      needsSlot = !slot || slot.started_at <= since;
      if (needsSlot) {
        const used = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM tier_slots WHERE phone_number_id = ? AND started_at > ?', pn, since).one().n;
        if (used >= lim.tier) {
          const waiting = this.waitingFor(pn);
          // Spread the waiters over the slots as they expire (k-th waiter takes the k-th expiry; beyond one lap, the next day).
          const idx = waiting % used;
          const lap = Math.floor(waiting / used) + 1;
          const nth = this.sql.exec<{ started_at: number }>('SELECT started_at FROM tier_slots WHERE phone_number_id = ? AND started_at > ? ORDER BY started_at LIMIT 1 OFFSET ?', pn, since, idx).one().started_at;
          if (now - lim.alerted_at > 600_000) {
            this.sql.exec(
              `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(phone_number_id) DO UPDATE SET alerted_at = excluded.alerted_at`, pn, lim.tier, lim.mps, lim.tokens, lim.tokens_at, now,
            );
            alert('send_tier_exhausted', { workspace: this.workspaceId, phoneNumberId: pn, tier: lim.tier, waiting: waiting + 1 });
          }
          return { dueAt: nth + lap * TIER_WINDOW_MS + 1000, reason: 'tier' };
        }
      }
    }
    const bucket = bucketDecision(lim.tokens_at === 0 ? lim.mps : lim.tokens, lim.mps, now, lim.tokens_at === 0 ? now : lim.tokens_at);
    if (!bucket.ok) return { dueAt: now + bucket.delayMs, reason: 'throughput' };
    this.sql.exec(
      `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET tokens = excluded.tokens, tokens_at = excluded.tokens_at`, pn, lim.tier, lim.mps, bucket.tokens, now, lim.alerted_at,
    );
    if (needsSlot && contact) {
      this.sql.exec(
        `INSERT INTO tier_slots (phone_number_id, contact_id, started_at) VALUES (?, ?, ?)
         ON CONFLICT(phone_number_id, contact_id) DO UPDATE SET started_at = excluded.started_at`, pn, contact.id, now,
      );
    }
    return null;
  }

  /** One pending release per idempotency key: a duplicate queue delivery of a throttled job must not release (and so send) it twice. */
  private addReleaseOnce(job: SendJob, dueAt: number, reason: string): void {
    const pending = this.sql.exec("SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.job.idempotencyKey') = ? LIMIT 1", job.idempotencyKey).toArray().length;
    if (!pending) addTask(this.sql, 'send_release', dueAt, { job, reason });
  }

  private waitingFor(phoneNumberId: string): number {
    return this.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.reason') = 'tier' AND json_extract(payload, '$.job.phoneNumberId') = ?", phoneNumberId,
    ).one().n;
  }

  /** Meta's tier (from quality/tier webhooks) and throughput for one number. */
  async setNumberLimits(phoneNumberId: string, limits: { tier?: number; mps?: number }): Promise<void> {
    const cur = this.limitsFor(phoneNumberId);
    const mps = limits.mps ?? cur.mps;
    this.sql.exec(
      `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET tier = excluded.tier, mps = excluded.mps, tokens = min(tokens, excluded.mps)`,
      phoneNumberId, limits.tier ?? cur.tier, mps, Math.min(cur.tokens, mps), cur.tokens_at, cur.alerted_at,
    );
  }

  // ---- Number health (W2-META) and the operator kill switch (W2-OPS) ------------------------------------------------------------

  async numberHealth(phoneNumberId: string): Promise<HealthState> {
    return currentHealth(this.sql, phoneNumberId);
  }

  /**
   * Feeds one signal into the number's state machine. A change is logged here, mirrored to D1 (awaited: a failure answers the webhook 5xx so Meta
   * redelivers, and the mirror only writes when D1 differs, so a redelivery repairs it), and every worsening (and every spike) pauses the number's
   * running / scheduled campaigns and tells a human. Recovery changes the state and nothing else: a paused campaign is resumed by the merchant.
   */
  async applyNumberHealth(phoneNumberId: string, signal: HealthSignal, now = Date.now(), signalAt?: number): Promise<{ from: HealthState; to: HealthState; changed: boolean; paused: number; dropped?: true }> {
    const from = currentHealth(this.sql, phoneNumberId);
    const to = nextHealth(from, signal);
    // Meta retries a webhook for days. ORDERING MAY ONLY DROP A STALE RECOVERY: a Meta-timed signal older than the newest one already applied AND lowering the state is
    // dropped; a signal that worsens (restricted / red / flagged / spike) is ALWAYS applied, whatever its time. Locally generated signals (spike, a rating read, no Meta time)
    // never take part in the ordering and never advance the ordering column, so they cannot make a later, earlier-stamped Meta DISABLE look stale.
    if (signalAt !== undefined && signalAt < lastSignalAt(this.sql, phoneNumberId) && HEALTH_STATES.indexOf(to) < HEALTH_STATES.indexOf(from)) return { from, to: from, changed: false, paused: 0, dropped: true };
    const source = signalSource(signal);
    this.ctx.storage.transactionSync(() => {
      if (signalAt !== undefined) recordSignalAt(this.sql, phoneNumberId, signalAt);
      if (to !== from) logHealth(this.sql, phoneNumberId, from, to, source, null, now);
    });
    await mirrorHealth(this.env.DB, 'phone_numbers', phoneNumberId, to, source, now, signalAt ?? 0);
    let paused = 0;
    if (worsened(from, to) || signal.kind === 'spike') paused = await this.pauseCampaignsOn(phoneNumberId, 'quality_flagged', now);
    const fields = { workspace: this.workspaceId, phoneNumberId, from, to, source, pausedCampaigns: paused };
    if (signal.kind === 'spike') alert('number_error_spike', fields);
    else if (worsened(from, to)) {
      if (to === 'yellow') alert('number_quality_flagged', fields);
      else alert('number_restricted', fields);
    }
    return { from, to, changed: to !== from, paused };
  }

  /** This store dominated a spike on the platform number: its OWN template sends on that number stop for a day. Nobody else is touched. */
  async blockSharedSends(phoneNumberId: string, until: number): Promise<void> {
    blockMember(this.sql, phoneNumberId, until);
  }

  /**
   * The platform (shared) number's state, SET on this member's copy by the Worker (never replayed as a signal, never alerting: the one alert is raised at the platform
   * level). Ordered by Meta's time like every signal. A worsening pauses this store's campaigns on that number.
   */
  async syncSharedHealth(phoneNumberId: string, state: HealthState, version: number, now = Date.now()): Promise<void> {
    const signalAt = version;
    if (signalAt < lastSignalAt(this.sql, phoneNumberId)) return; // for the platform number this column holds the push version (processing time), not Meta's
    const from = currentHealth(this.sql, phoneNumberId);
    this.ctx.storage.transactionSync(() => {
      recordSignalAt(this.sql, phoneNumberId, signalAt);
      if (state !== from) logHealth(this.sql, phoneNumberId, from, state, 'shared', null, now);
    });
    this.sql.exec("INSERT INTO store_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING", `shared.number:${phoneNumberId}`); // this store sends on the platform number: its sends are counted
    if (worsened(from, state)) await this.pauseCampaignsOn(phoneNumberId, 'quality_flagged', now);
  }

  /** Counts a Meta quality error (131049 / 131026) for the number; enough of them inside the window is a spike. */
  async noteSendError(phoneNumberId: string, code: number, now = Date.now(), template = true): Promise<void> {
    if (!QUALITY_ERROR_CODES.has(code)) return;
    // The platform number is counted per NUMBER (every member together, in D1) and tripped once at the platform level; an own number is counted here.
    const shared = await this.env.DB.prepare('SELECT 1 FROM shared_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first();
    if (shared) {
      if (!template) return; // sends are counted for templates only, so only a template's failure may count against the rate
      const verdict = await noteSharedError(this.env, phoneNumberId, this.workspaceId, now);
      if (verdict.kind === 'platform' || (verdict.kind === 'member' && verdict.platform)) await applySharedHealth(this.env, phoneNumberId, { kind: 'spike' }, undefined, (f) => this.ctx.waitUntil(f()), now);
      if (verdict.kind === 'member') {
        // One store produced (nearly) all of it: stop THAT store's templates on the number, not everyone's.
        if (verdict.workspaceId === this.workspaceId) blockMember(this.sql, phoneNumberId, now + MEMBER_BLOCK_MS);
        else await this.env.WORKSPACE_DO.get(this.env.WORKSPACE_DO.idFromName(verdict.workspaceId)).blockSharedSends(phoneNumberId, now + MEMBER_BLOCK_MS);
        alert('number_member_abuse', { workspace: verdict.workspaceId, phoneNumberId, shared: true });
      } else if (verdict.kind === 'ambiguous') alert('number_error_spike', { phoneNumberId, shared: true, ambiguous: true });
      return;
    }
    if (noteQualityError(this.sql, phoneNumberId, now)) await this.applyNumberHealth(phoneNumberId, { kind: 'spike' }, now);
  }

  /** running | scheduled -> paused for one reason, on one number (or every number when null). The merchant resumes them; nothing here ever does. */
  async pauseCampaignsOn(phoneNumberId: string | null, reason: 'quality_flagged' | 'operator_paused' | 'store_suspended' | 'wallet_empty', now = Date.now(), park = false): Promise<number> {
    const ids = this.sql
      .exec<{ id: string }>(`SELECT id FROM campaigns WHERE status IN ('running', 'scheduled') ${phoneNumberId === null ? '' : 'AND phone_number_id = ?'}`, ...(phoneNumberId === null ? [] : [phoneNumberId]))
      .toArray();
    let n = 0;
    for (const { id } of ids) {
      const r = await pauseCampaign(this.host(), id, reason, now, park);
      if (r.ok) { n++; await endInstance(this.host(), id, this.campaignAttempt(id)); }
    }
    return n;
  }

  /** The operator's suspend / unsuspend. Suspending also pauses every campaign (reason operator_paused); unsuspending resumes nothing. */
  async setSuspended(suspended: boolean, reason: string, now = Date.now()): Promise<{ paused: number }> {
    setSuspendedFlag(this.sql, suspended, reason);
    return { paused: suspended ? await this.pauseCampaignsOn(null, 'operator_paused', now) : 0 };
  }

  /** Every reason this workspace may not spend (operator, Store, wallet debt): what D1's `suspended_*` is derived from (`syncSuspendedMirror`). */
  async suspensionState(): Promise<SuspensionState> {
    return suspensionState(this.sql);
  }

  async suspended(): Promise<boolean> {
    return isSuspended(this.sql);
  }

  /** The Store hold's reason (STORE-STANDING-1), or null: the operator unsuspend keeps D1 in step with it. */
  async storeHold(): Promise<string | null> {
    return storeHold(this.sql);
  }

  async throttleReport(phoneNumberId: string, now = Date.now()): Promise<ThrottleReport> {
    const lim = this.limitsFor(phoneNumberId);
    const since = now - TIER_WINDOW_MS;
    const used = this.sql.exec<{ n: number; first: number | null }>('SELECT count(*) AS n, min(started_at) AS first FROM tier_slots WHERE phone_number_id = ? AND started_at > ?', phoneNumberId, since).one();
    return { tier: lim.tier, mps: lim.mps, usedInWindow: used.n, waiting: this.waitingFor(phoneNumberId), nextSlotAt: used.n >= lim.tier && used.first !== null ? used.first + TIER_WINDOW_MS : null };
  }

  /**
   * Error 131049 (Meta's marketing frequency cap) is not a ban and not the contact's fault: put the message back to
   * 'queued' and try again in 24 h; after two deferrals give up and fail it. The contact is never touched.
   */
  async rescheduleFrequencyCap(job: SendJob, now = Date.now()): Promise<'rescheduled' | 'failed'> {
    const deferrals = job.deferrals ?? 0;
    const status = deferrals >= 2 ? 'failed' : 'queued';
    await this.noteSendError(job.phoneNumberId, 131049, now);
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ id: number }>('UPDATE messages SET status = ?, error_code = 131049, updated_at = ? WHERE idempotency_key = ? RETURNING id', status, now, job.idempotencyKey).toArray()[0];
      if (row) this.emitMessageStatus(row.id);
      if (status === 'failed') this.billing.settleHold(job.idempotencyKey, 'failed', now); // a deferred send keeps its hold: it will be claimed again
    });
    if (status === 'failed') return 'failed';
    this.addReleaseOnce({ ...job, deferrals: deferrals + 1 }, now + TIER_WINDOW_MS, 'frequency_cap');
    await this.arm();
    return 'rescheduled';
  }

  /**
   * The API send path: validates against the 24 h window, consent and the template set, stores a 'queued' message and
   * returns the job to enqueue. Expected refusals come back as a result object (a throw would cross the RPC boundary).
   * A repeated clientId returns the stored message and no job, so a retried POST sends once.
   */
  async queueOutbound(conversationId: number, phoneNumberId: string, req: SendMessageRequest, now = Date.now()): Promise<QueueOutboundResult> {
    const workspaceId = this.workspaceId;
    await this.ensurePricing(now);
    await this.repullIfUnknown(phoneNumberId, now);
    const out = this.ctx.storage.transactionSync((): QueueOutboundResult => {
      const conv = this.sql
        .exec<{ id: number; wa_id: string; last_inbound_at: number | null; opted_out_at: number | null }>(
          'SELECT c.id, ct.wa_id, ct.last_inbound_at, ct.opted_out_at FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?', conversationId,
        ).toArray()[0];
      if (!conv) return { ok: false, reason: 'not_found' };
      const key = `ui:${req.clientId}`;
      const dup = this.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.idempotency_key = ?`, key).toArray()[0];
      if (dup) return { ok: true, message: messageDto(dup, workspaceId), job: null };
      if (!serviceAllowed(this.sql, now)) return { ok: false, reason: 'plan_required' }; // WA-NOFREE-1
      const windowOpen = conv.last_inbound_at !== null && conv.last_inbound_at * 1000 + WINDOW_MS > now;
      const base = { workspaceId, phoneNumberId, to: conv.wa_id, idempotencyKey: key };
      let type: string;
      let preview: string;
      let col: { template_name?: string; template_lang?: string; media_mime?: string; media_size?: number; media_r2_key?: string } = {};
      let job: SendJob;
      switch (req.type) {
        case 'text':
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          type = 'text'; preview = req.text;
          job = { ...base, kind: 'text', text: req.text };
          break;
        case 'interactive':
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          type = 'interactive'; preview = req.body;
          job = { ...base, kind: 'interactive', interactive: { body: req.body, buttons: req.buttons } };
          break;
        case 'media': {
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          const up = this.sql.exec<{ meta_media_id: string; mime: string; size: number; filename: string | null; r2_key: string }>('SELECT meta_media_id, mime, size, filename, r2_key FROM uploads WHERE id = ?', req.uploadId).toArray()[0];
          if (!up) return { ok: false, reason: 'invalid_request', message: 'unknown uploadId' };
          const allowed = outboundMediaFor(up.mime);
          if (!allowed) return { ok: false, reason: 'unsupported_media' };
          if (req.caption && allowed.kind === 'audio') return { ok: false, reason: 'invalid_request', message: 'audio cannot have a caption' };
          type = allowed.kind; preview = req.caption ?? '';
          col = { media_mime: up.mime, media_size: up.size, media_r2_key: up.r2_key };
          job = { ...base, kind: 'media', media: { kind: allowed.kind, mediaId: up.meta_media_id, ...(req.caption ? { caption: req.caption } : {}), ...(up.filename ? { filename: up.filename } : {}) } };
          break;
        }
        case 'template': {
          const t = this.sql.exec<{ category: string; status: string; components: string }>('SELECT category, status, components FROM templates WHERE name = ? AND language = ?', req.name, req.language).toArray()[0];
          if (!t || t.status !== 'APPROVED') return { ok: false, reason: 'template_not_approved' };
          if (t.category === 'MARKETING' && conv.opted_out_at !== null) return { ok: false, reason: 'opted_out' };
          if (t.category === 'MARKETING' && marketingBlocked(this.sql, now)) return { ok: false, reason: 'plan_blocked' };
          const stored = componentsSchema.safeParse(JSON.parse(t.components));
          if (!stored.success) return { ok: false, reason: 'invalid_request', message: 'stored template is malformed' };
          const rendered = renderTemplate(stored.data, req.params, t.category);
          if (!rendered.ok) return { ok: false, reason: 'invalid_request', message: rendered.message };
          type = 'template'; preview = rendered.text;
          col = { template_name: req.name, template_lang: req.language };
          job = { ...base, kind: 'template', template: { name: req.name, language: req.language, components: rendered.components } };
          break;
        }
      }
      // The wallet's answer comes first, so a refusal leaves no half-written message behind.
      const bill = this.billing.onClaim(job, { now, createdAt: now, windowEndsAt: req.type === 'template' ? null : (conv.last_inbound_at ?? 0) * 1000 + WINDOW_MS, atQueue: true });
      if (bill.kind === 'defer') return { ok: false, reason: 'funding_unknown' };
      if (bill.kind === 'empty') return { ok: false, reason: bill.reason === 'wallet_empty_expired' ? 'wallet_empty' : bill.reason };
      const id = this.sql.exec<{ id: number }>(
        `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, template_name, template_lang, media_mime, media_size, media_r2_key, author, created_at, updated_at)
         VALUES (?, 'out', ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 'staff', ?, ?) RETURNING id`,
        conversationId, type, previewOf(preview), preview.length ? preview : null, key,
        col.template_name ?? null, col.template_lang ?? null, col.media_mime ?? null, col.media_size ?? null, col.media_r2_key ?? null, now, now,
      ).one().id;
      this.indexMessage(id, preview.length ? previewOf(preview) : null);
      this.sql.exec('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?', Math.floor(now / 1000), conversationId);
      const row = this.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ?`, id).one();
      this.emitMessageCreated(id);
      staffReplied(this.host(), conv.wa_id, now); // a person is on it: the bot stays out of the way
      this.emitConversationUpdated(conversationId);
      return { ok: true, message: messageDto(row, workspaceId), job };
    });
    await this.flushArm();
    return out;
  }

  async listTemplates(now = Date.now()): Promise<TemplateDto[]> {
    return this.sql
      .exec<TemplateRowSql>(`SELECT ${TEMPLATE_COLS} FROM templates ORDER BY name, language`)
      .toArray()
      .map((t) => this.templateDto(t, now));
  }

  private templateDto(t: TemplateRowSql, now: number): TemplateDto {
    const comps = componentsSchema.safeParse(JSON.parse(t.components));
    const parts = comps.success ? comps.data : [];
    return {
      name: t.name, language: t.language, category: t.category as TemplateDto['category'], status: t.status as TemplateDto['status'],
      bodyText: bodyTextOf(parts), paramCount: paramCount(parts, t.category), rejectedReason: t.rejected_reason,
      label: t.label, quality: (t.quality as TemplateDto['quality']) ?? null, components: parts, updatedAt: t.updated_at, editAllowance: this.editAllowanceOf(t.name, t.language, t.status, now),
      ...(rejectionAdvice(t.rejected_reason, t.status) ? { advice: rejectionAdvice(t.rejected_reason, t.status)! } : {}),
    };
  }

  /** One template with everything the detail screen and the editor need; null when we do not have it. */
  async getTemplate(name: string, language: string, now = Date.now()): Promise<(TemplateDto & { metaId: string | null; label: string | null; submittedAt: number | null; components: NonNullable<TemplateDto['components']> }) | null> {
    const t = this.sql.exec<TemplateRowSql>(`SELECT ${TEMPLATE_COLS}, submitted_at FROM templates WHERE name = ? AND language = ?`, name, language).toArray()[0];
    if (!t) return null;
    const comps = componentsSchema.safeParse(JSON.parse(t.components));
    return { ...this.templateDto(t, now), metaId: t.meta_id, label: t.label, submittedAt: (t as TemplateRowSql & { submitted_at: number | null }).submitted_at, components: comps.success ? comps.data : [] };
  }

  private editAllowanceOf(name: string, language: string, status: string, now: number): NonNullable<TemplateDto['editAllowance']> {
    if (status === 'REJECTED' || status === 'PAUSED') return { allowed: true };
    if (status !== 'APPROVED') return { allowed: false, reason: 'status', retryAt: null };
    // Meta: an APPROVED template may be edited once per 24 h and 10 times per 30 days. If both bite, the later unlock wins.
    const last = this.sql.exec<{ at: number | null }>('SELECT max(at) AS at FROM template_edits WHERE name = ? AND language = ? AND at > ?', name, language, now - TEMPLATE_EDIT_DAY_MS).toArray()[0]?.at ?? null;
    const month = this.sql.exec<{ at: number }>('SELECT at FROM template_edits WHERE name = ? AND language = ? AND at > ? ORDER BY at DESC LIMIT ?', name, language, now - TEMPLATE_EDIT_MONTH_MS, TEMPLATE_EDITS_PER_MONTH).toArray();
    const daily = last === null ? null : last + TEMPLATE_EDIT_DAY_MS;
    const monthly = month.length >= TEMPLATE_EDITS_PER_MONTH ? month[month.length - 1]!.at + TEMPLATE_EDIT_MONTH_MS : null;
    if (daily === null && monthly === null) return { allowed: true };
    return monthly !== null && (daily === null || monthly >= daily) ? { allowed: false, reason: 'monthly', retryAt: monthly } : { allowed: false, reason: 'daily', retryAt: daily! };
  }

  async editAllowance(name: string, language: string, now = Date.now()): Promise<NonNullable<TemplateDto['editAllowance']>> {
    const t = this.sql.exec<{ status: string }>('SELECT status FROM templates WHERE name = ? AND language = ?', name, language).toArray()[0];
    return this.editAllowanceOf(name, language, t?.status ?? '', now);
  }

  /**
   * One edit of a template in flight at a time (the DO runs this synchronously, so two callers can never both win). A claim older than two
   * minutes is dead (the call that took it was cut off) and is taken over. False = another edit is running.
   */
  async claimTemplateEdit(name: string, language: string, now = Date.now()): Promise<boolean> {
    const r = this.sql.exec(
      "INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(store_state.value AS INTEGER) < ?",
      `templates.editing:${name}:${language}`, String(now), now - 120_000,
    );
    return r.rowsWritten > 0;
  }

  async releaseTemplateEdit(name: string, language: string): Promise<void> {
    this.sql.exec('DELETE FROM store_state WHERE key = ?', `templates.editing:${name}:${language}`);
  }

  async recordTemplateEdit(name: string, language: string, at: number): Promise<void> {
    this.sql.exec('INSERT INTO template_edits (name, language, at) VALUES (?, ?, ?)', name, language, at);
  }

  async removeTemplate(name: string, language: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const r = this.sql.exec('DELETE FROM templates WHERE name = ? AND language = ?', name, language);
      this.sql.exec('DELETE FROM template_edits WHERE name = ? AND language = ?', name, language);
      return r.rowsWritten > 0;
    });
  }

  /** Whether a campaign that has not finished, or a message still waiting to leave, uses this template (deleting it would break them). */
  async templateInUse(name: string, language: string): Promise<'campaign' | 'queued' | null> {
    if (this.sql.exec("SELECT 1 FROM campaigns WHERE template_name = ? AND template_language = ? AND status IN ('draft', 'scheduled', 'running', 'paused') LIMIT 1", name, language).toArray().length > 0) return 'campaign';
    if (this.sql.exec("SELECT 1 FROM messages WHERE direction = 'out' AND template_name = ? AND template_lang = ? AND status IN ('queued', 'retry') LIMIT 1", name, language).toArray().length > 0) return 'queued';
    return null;
  }

  /** Submitted templates Meta has not answered for `olderThanMs`: the sweep asks Meta about them (a status webhook can be lost or arrive before our save). */
  async pendingTemplates(olderThanMs: number, now = Date.now()): Promise<{ name: string; language: string; metaId: string | null }[]> {
    return this.sql.exec<{ name: string; language: string; meta_id: string | null }>("SELECT name, language, meta_id FROM templates WHERE status = 'PENDING' AND updated_at < ? ORDER BY updated_at LIMIT 20", now - olderThanMs)
      .toArray().map((r) => ({ name: r.name, language: r.language, metaId: r.meta_id }));
  }

  /** Replaces the template set with what Meta returned (the caller fetched every page, so absence means deleted at Meta). */
  async syncTemplates(items: { name: string; language: string; category: string; status: string; components: unknown[]; rejectedReason: string | null; metaId?: string | null }[]): Promise<{ upserted: number; removed: number }> {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const keep = new Set<string>();
      for (const t of items) {
        keep.add(`${t.name}\u0000${t.language}`);
        this.upsertTemplate(t.name, t.language, t.category, t.status, JSON.stringify(t.components), t.rejectedReason, now, t.metaId ?? null);
      }
      let removed = 0;
      for (const t of this.sql.exec<{ id: number; name: string; language: string }>('SELECT id, name, language FROM templates').toArray()) {
        if (keep.has(`${t.name}\u0000${t.language}`)) continue;
        // a submission still on its way to Meta (reserved, no Meta id yet) is not "deleted at Meta"
        if (this.sql.exec("SELECT 1 FROM templates WHERE id = ? AND meta_id IS NULL AND status = 'PENDING' AND updated_at > ?", t.id, now - TEMPLATE_INFLIGHT_MS).toArray().length > 0) continue;
        this.sql.exec('DELETE FROM templates WHERE id = ?', t.id);
        removed++;
      }
      return { upserted: items.length, removed };
    });
  }

  /** A template we just submitted (or re-submitted) to Meta. `category` is what META answered, never what was requested. */
  async saveSubmittedTemplate(t: { name: string; language: string; category: string; status: string; components: unknown[]; metaId?: string | null; label?: string | null }): Promise<void> {
    const now = Date.now();
    this.upsertTemplate(t.name, t.language, t.category, t.status, JSON.stringify(t.components), null, now, t.metaId ?? null, t.label ?? null, now);
    // Meta's answer normally arrives by webhook within minutes; if it is lost (or beat this save) the sweep asks Meta once the row is an hour old.
    if (t.status === 'PENDING') await this.schedule('template_refresh', now + TEMPLATE_PENDING_AFTER_MS);
  }

  /**
   * Claims name+language BEFORE the Meta call, atomically (the DO runs this synchronously), so two taps or two staff tabs can never both submit.
   * False = the name is taken. The caller removes the row again if Meta refuses; a row left by a crashed call is dropped by the pending sweep.
   */
  async reserveTemplate(t: { name: string; language: string; category: string; components: unknown[]; label: string | null }): Promise<boolean> {
    const now = Date.now();
    const r = this.sql.exec(
      "INSERT INTO templates (name, language, category, status, components, rejected_reason, updated_at, meta_id, label, submitted_at) VALUES (?, ?, ?, 'PENDING', ?, NULL, ?, NULL, ?, ?) ON CONFLICT(name, language) DO NOTHING",
      t.name, t.language, t.category, JSON.stringify(t.components), now, t.label, now,
    );
    if (r.rowsWritten > 0) await this.schedule('template_refresh', now + TEMPLATE_PENDING_AFTER_MS);
    return r.rowsWritten > 0;
  }

  /** Whether the brand's starter set is fully in place for this WABA (written by the connect hook or the install-defaults retry). */
  async starterInstalled(wabaId: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM store_state WHERE key = ? AND value = 'done'", `templates.starter:${wabaId}`).toArray().length > 0;
  }

  /** Where this store's customers shop (from `store.linked`), or null until the Store has said. The COD v2 template's fixed URL base. */
  async storeOrigin(): Promise<string | null> {
    return this.sql.exec<{ value: string }>("SELECT value FROM store_state WHERE key = 'storefront_origin'").toArray()[0]?.value ?? null;
  }

  async markStarterInstalled(wabaId: string): Promise<void> {
    this.sql.exec("INSERT INTO store_state (key, value) VALUES (?, 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'", `templates.starter:${wabaId}`);
  }

  async hasTemplate(name: string, language: string): Promise<boolean> {
    return this.sql.exec('SELECT 1 FROM templates WHERE name = ? AND language = ?', name, language).toArray().length > 0;
  }

  /** Meta's template-status webhook (or a sweep). Unknown templates are ignored (they arrive with the next sync). Reason NONE/empty is no reason; APPROVED clears it. */
  async applyTemplateStatus(name: string, language: string, status: string, reason: string | null, metaId: string | null = null): Promise<{ applied: boolean }> {
    // Meta redelivers and does not keep order: a PENDING that arrives after a decision is a replay, never a step backwards. (Our own re-review after an
    // edit is written by saveSubmittedTemplate, not by a webhook, so it is unaffected; an appeal that is really decided arrives as APPROVED / REJECTED.)
    if (status === 'PENDING' && this.sql.exec("SELECT 1 FROM templates WHERE name = ? AND language = ? AND status <> 'PENDING'", name, language).toArray().length > 0) return { applied: false };
    const clean = status === 'APPROVED' || !reason || reason === 'NONE' ? null : reason;
    // The real set of rejection codes is not in Meta's docs: an unfamiliar enum is logged (code only, never free text) so it can be added to the advice and the fixture.
    if (clean && status === 'REJECTED' && !knownReason(clean) && isEnumLikeReason(clean)) console.log(JSON.stringify({ event: 'template_reason_unmapped', code: clean }));
    const r = this.sql.exec('UPDATE templates SET status = ?, rejected_reason = ?, meta_id = COALESCE(?, meta_id), updated_at = ? WHERE name = ? AND language = ?', status, clean, metaId, Date.now(), name, language);
    return { applied: r.rowsWritten > 0 };
  }

  /** Meta rated a template (green / yellow / red / unknown). Only the rating column changes: not the status, not the edit clock. Redelivery is harmless (same value). */
  async applyTemplateQuality(name: string, language: string, score: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'): Promise<{ applied: boolean }> {
    const r = this.sql.exec('UPDATE templates SET quality = ? WHERE name = ? AND language = ?', score, name, language);
    return { applied: r.rowsWritten > 0 };
  }

  /**
   * Meta changed a template's category. Messages of that template still waiting to be sent are checked again: a template that became
   * marketing needs the contact's opt-in state and a marketing-priced hold (the wallet may now refuse it); one that became cheaper gives
   * the difference back. Sent messages are untouched: Meta's own pricing object on their statuses decides what they cost.
   */
  async applyTemplateCategory(name: string, language: string, category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION', now = Date.now()): Promise<{ rechecked: number; failed: number }> {
    await this.ensurePricing(now);
    const out = this.ctx.storage.transactionSync(() => {
      const t = this.sql.exec<{ category: string }>('SELECT category FROM templates WHERE name = ? AND language = ?', name, language).toArray()[0];
      if (!t) return { rechecked: 0, failed: 0 };
      this.sql.exec('UPDATE templates SET category = ?, updated_at = ? WHERE name = ? AND language = ?', category, now, name, language);
      if (t.category === category) return { rechecked: 0, failed: 0 };
      let rechecked = 0;
      let failed = 0;
      const waiting = this.sql.exec<{ id: number; key: string; wa_id: string; opted_out_at: number | null }>(
        `SELECT m.id, m.idempotency_key AS key, ct.wa_id, ct.opted_out_at FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
          WHERE m.direction = 'out' AND m.template_name = ? AND m.template_lang = ? AND m.status IN ('queued', 'retry') AND m.idempotency_key IS NOT NULL`, name, language,
      ).toArray();
      for (const m of waiting) {
        const fail = (reason: string) => {
          this.sql.exec("UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE id = ?", reason, now, m.id);
          this.emitMessageStatus(m.id);
          this.billing.settleHold(m.key, 'failed', now);
          failed++;
        };
        rechecked++;
        if (category === 'MARKETING' && m.opted_out_at !== null) {
          fail('opted_out');
          continue;
        }
        if (category === 'MARKETING' && marketingBlocked(this.sql, now)) {
          fail('plan_blocked');
          continue;
        }
        const h = this.sql.exec<{ number_id: string | null; funding: string | null; state: string }>('SELECT number_id, funding, state FROM wallet_holds WHERE ref = ?', `msg:${m.key}`).toArray()[0];
        if (!h || h.state !== 'held' || h.funding !== 'platform_line' || !h.number_id) continue; // not held against the wallet: the claim decides
        this.billing.settleHold(m.key, 'dropped', now);
        const bill = this.billing.onClaim({ workspaceId: this.workspaceId, phoneNumberId: h.number_id, to: m.wa_id, idempotencyKey: m.key, kind: 'template', template: { name, language, components: [] } }, { now, createdAt: now, windowEndsAt: null, atQueue: true });
        if (bill.kind === 'empty') fail(bill.reason === 'wallet_empty_expired' ? 'wallet_empty' : bill.reason);
      }
      return { rechecked, failed };
    });
    await this.flushArm();
    return out;
  }

  private upsertTemplate(name: string, language: string, category: string, status: string, components: string, rejectedReason: string | null, now: number, metaId: string | null = null, label: string | null = null, submittedAt: number | null = null): void {
    this.sql.exec(
      `INSERT INTO templates (name, language, category, status, components, rejected_reason, updated_at, meta_id, label, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, language) DO UPDATE SET category = excluded.category, status = excluded.status, components = excluded.components, rejected_reason = excluded.rejected_reason, updated_at = excluded.updated_at,
         meta_id = COALESCE(excluded.meta_id, meta_id), label = COALESCE(excluded.label, label), submitted_at = COALESCE(excluded.submitted_at, submitted_at)`,
      name, language, category, status, components, rejectedReason, now, metaId, label, submittedAt,
    );
  }

  /** The enqueue after queueOutbound threw: the message will never be sent, so say so instead of leaving it 'queued'. */
  async markEnqueueFailed(idempotencyKey: string): Promise<void> {
    this.failUnsent(idempotencyKey, 'enqueue_failed');
  }

  /** The queue consumer found the sender number gone: the message can never leave, so fail it and give the wallet hold back. */
  async failUnsendable(idempotencyKey: string, reason: 'sender_unavailable'): Promise<void> {
    this.failUnsent(idempotencyKey, reason);
  }

  /**
   * The send queue gave up on this job (dead letter). Only a row that PROVABLY never left (queued / retry) is failed `send_dlq` and its hold released.
   * A `claimed` row may be in flight to Meta (sent, recorded later): failing it could mark a delivered message failed and release the hold of a paid
   * send, so it is left to the stale-claim recovery (no status change, no hold release) and reported as 'claimed' so the alert shows a human.
   */
  async failDeadLetter(idempotencyKey: string): Promise<'failed' | 'claimed' | 'other'> {
    if (this.failUnsent(idempotencyKey, 'send_dlq')) return 'failed';
    const st = this.sql.exec<{ status: string }>('SELECT status FROM messages WHERE idempotency_key = ?', idempotencyKey).toArray()[0]?.status;
    return st === 'claimed' ? 'claimed' : 'other';
  }

  private failUnsent(idempotencyKey: string, reason: 'enqueue_failed' | 'sender_unavailable' | 'send_dlq', from: string[] = ['queued', 'retry']): boolean {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.sql.exec<{ id: number }>(`UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE idempotency_key = ? AND status IN (${from.map(() => '?').join(', ')}) RETURNING id`, reason, now, idempotencyKey, ...from).toArray()[0];
      if (row) {
        this.emitMessageStatus(row.id);
        this.billing.settleHold(idempotencyKey, reason, now);
      }
      return !!row;
    });
  }

  async recordOutbound(idempotencyKey: string, result: SendResult): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      if (result.ok) {
        const accepted = this.sql.exec<{ id: number }>("UPDATE messages SET wamid = ?, status = 'accepted', updated_at = ? WHERE idempotency_key = ? RETURNING id", result.wamid, now, idempotencyKey).toArray()[0];
        if (accepted) this.emitMessageStatus(accepted.id);
        this.billing.onAccepted(idempotencyKey, result.wamid, now);
        // Meta often sends 'sent'/'failed' before we store the wamid: replay what arrived early, oldest first.
        const early = this.sql
          .exec<{ id: number; status: StatusEvent['status']; ts: number; error_code: number | null; pricing_json: string | null }>(
            'SELECT id, status, ts, error_code, pricing_json FROM message_status_events WHERE wamid = ? AND applied = 0 ORDER BY ts, id', result.wamid,
          )
          .toArray();
        for (const e of early) {
          const pricing = e.pricing_json ? (JSON.parse(e.pricing_json) as StatusPricing) : undefined;
          if (this.applyToMessage({ wamid: result.wamid, status: e.status, ts: e.ts, ...(e.error_code !== null ? { errorCode: e.error_code } : {}) })) {
            this.sql.exec('UPDATE message_status_events SET applied = 1 WHERE id = ?', e.id);
          }
          this.billing.onStatus({ wamid: result.wamid, status: e.status, ts: e.ts, ...(pricing ? { pricing } : {}) }, now);
        }
      } else {
        const failed = this.sql.exec<{ id: number }>('UPDATE messages SET status = ?, error_code = ?, updated_at = ? WHERE idempotency_key = ? RETURNING id', result.retryable ? 'retry' : 'failed', result.code, now, idempotencyKey).toArray()[0];
        if (failed) this.emitMessageStatus(failed.id);
        if (!result.retryable) this.billing.settleHold(idempotencyKey, 'failed', now);
      }
    });
    await this.flushArm();
  }

  async applyStatus(e: StatusEvent): Promise<{ applied: boolean }> {
    await this.ensurePricing();
    const r = this.ctx.storage.transactionSync(() => ({ applied: this.applyStatusSync(e) }));
    this.freshQualityErrors.length = 0; // no phone number id on this path: only the ingest path counts them
    await this.flushArm();
    return r;
  }

  /** Records each distinct status event once; the message keeps its highest state. */
  private applyStatusSync(e: StatusEvent): boolean {
    const isNew = this.sql.exec(
      'INSERT INTO message_status_events (wamid, status, ts, applied, error_code, pricing_json) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(wamid, status, ts) DO NOTHING',
      e.wamid, e.status, e.ts, e.errorCode ?? null, e.pricing ? JSON.stringify(e.pricing) : null,
    ).rowsWritten > 0;
    if (!isNew) return false;
    if (e.status === 'failed' && e.errorCode !== undefined && QUALITY_ERROR_CODES.has(e.errorCode)) this.freshQualityErrors.push({ code: e.errorCode, template: this.sql.exec('SELECT 1 FROM messages WHERE wamid = ? AND template_name IS NOT NULL', e.wamid).toArray().length > 0 }); // counted once per NEW event, never for a redelivery
    const applied = this.applyToMessage(e);
    if (applied) this.sql.exec('UPDATE message_status_events SET applied = 1 WHERE wamid = ? AND status = ? AND ts = ?', e.wamid, e.status, e.ts);
    // The money side runs for every NEW event, applied to a message row or not: a late billable status still charges.
    this.billing.onStatus({ wamid: e.wamid, status: e.status, ts: e.ts, ...(e.pricing ? { pricing: e.pricing } : {}) }, Date.now());
    return applied;
  }

  private applyToMessage(e: StatusEvent): boolean {
    const msg = this.sql.exec<{ id: number; status_rank: number }>('SELECT id, status_rank FROM messages WHERE wamid = ?', e.wamid).toArray()[0];
    if (!msg) return false;
    const rank = STATUS_RANK[e.status];
    if (rank <= msg.status_rank || (e.status === 'failed' && msg.status_rank >= STATUS_RANK.delivered)) return false;
    this.sql.exec('UPDATE messages SET status = ?, status_rank = ?, error_code = coalesce(?, error_code), updated_at = ? WHERE id = ?', e.status, rank, e.errorCode ?? null, Date.now(), msg.id);
    this.emitMessageStatus(msg.id);
    return true;
  }

  // ---- Store link (Phase 4) ---------------------------------------------------------------------------------------

  private linkHost?: LinkHost;
  /** Pause between two sends of one bot turn (WhatsApp keeps them in order). A field so tests can set it to 0. */
  botSendGapMs = 150;
  /** The narrow view of this DO the Store-link code works against (see store-link/host.ts). */
  private host(): LinkHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (this.linkHost ??= {
      sql: this.sql,
      storage: this.ctx.storage,
      env: this.env,
      workspaceId: this.workspaceId,
      billing: this.billing,
      ensurePricing: () => this.ensurePricing(),
      ensureConversation: (waId, now, profileName) => this.ensureConversation(waId, now, profileName),
      insertOutbound: (conversationId, row, now) => this.insertOutbound(conversationId, row, now),
      emitConversationUpdated: (id) => this.emitConversationUpdated(id),
      recordVoice: (id, transcript) => this.recordVoice(id, transcript),
      arm: () => this.arm(),
      eraseContact: (waId) => this.eraseContact(waId),
      deliver: (job) => this.deliverNow(job),
      get sendGapMs() { return self.botSendGapMs; },
    });
  }

  /**
   * Sends a stored message right now, through the same claim/throttle/record steps as the queue consumer. Used where the
   * order of messages matters (the ordering bot); a retryable Meta failure hands the job to the send queue, whose retry ladder takes over.
   */
  private async deliverNow(job: SendJob): Promise<void> {
    const claim = await this.claimSend(job);
    if (claim !== 'claimed') return; // deferred (the scheduler releases it), or already sent / in flight / dropped
    const sent = await sendToMeta(this.env, sendJobSchema.parse(job));
    if (!sent.ok && sent.code === 131049) {
      await this.rescheduleFrequencyCap(job);
      return;
    }
    await this.recordOutbound(job.idempotencyKey, sent);
    if (!sent.ok && sent.retryable) await this.env.SEND_QUEUE.sendBatch([{ body: job }]);
  }

  /** Contact and conversation for a WhatsApp id, created when missing (a business-initiated message to a customer who never wrote). Inside a transaction. */
  private ensureConversation(waId: string, now: number, profileName?: string | null): { contactId: number; conversationId: number } {
    const contactId = this.sql.exec<{ id: number }>(
      'INSERT INTO contacts (wa_id, profile_name) VALUES (?, ?) ON CONFLICT(wa_id) DO UPDATE SET profile_name = coalesce(profile_name, excluded.profile_name) RETURNING id', waId, profileName ?? null,
    ).one().id;
    if (profileName) indexContactName(this.sql, contactId);
    const conversationId = this.sql.exec<{ id: number }>(
      `INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET last_message_at = max(coalesce(last_message_at, 0), excluded.last_message_at) RETURNING id`, contactId, Math.floor(now / 1000),
    ).one().id;
    return { contactId, conversationId };
  }

  private insertOutbound(conversationId: number, row: OutboundRow, now: number): number {
    const id = this.sql.exec<{ id: number }>(
      `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, template_name, template_lang, author, created_at, updated_at)
       VALUES (?, 'out', ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?) RETURNING id`,
      conversationId, row.type, row.preview, row.body, row.key, row.templateName ?? null, row.templateLang ?? null, row.author ?? null, now, now,
    ).one().id;
    this.indexMessage(id, row.preview.length ? row.preview : null);
    this.sql.exec('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?', Math.floor(now / 1000), conversationId);
    this.emitMessageCreated(id);
    this.emitConversationUpdated(conversationId);
    return id;
  }

  /**
   * One event from the Store queue. Expected outcomes (duplicate, stale, skipped) come back as data; a thrown error means
   * "retry this message". `phoneNumberId` is the workspace's sender (its own active number, else the shared platform number with `shared` set), or null when it has none.
   */
  async applyStoreEvent(event: StoreEvent, opts: { phoneNumberId: string | null; shared?: boolean }): Promise<StoreEventOutcome> {
    await this.ensurePricing();
    if (opts.phoneNumberId) await this.repullIfUnknown(opts.phoneNumberId, Date.now());
    const result = await applyStoreEvent(this.host(), event, opts);
    // STORE-STANDING-1: a Store suspension or deletion also pauses every running / scheduled campaign (nothing resumes them on reactivation:
    // the merchant resumes, as after an operator suspension). The hold flag itself already stops every send at its claim.
    if (result.status === 'applied' && (event.type === 'store.suspended' || event.type === 'store.deleted')) await this.pauseCampaignsOn(null, 'store_suspended');
    return result;
  }

  /**
   * The merchant answers a COD confirmation from the inbox. Expected refusals are data. The Store is told right away when it
   * can be reached; otherwise a scheduled task keeps trying and `pushed` is false.
   */
  async merchantCodOutcome(a: MerchantCodArgs): Promise<{ ok: true; orderNumber: string; outcome: 'confirmed' | 'refused'; pushed: boolean } | { ok: false; reason: 'unknown_order' | 'conflict' | 'closed' | 'not_cod' }> {
    const res = this.ctx.storage.transactionSync(() => merchantCod(this.host(), a, Date.now()));
    if (!res.ok) return res;
    await this.arm();
    const pushed = await this.tryPushCod(res.orderId);
    return { ok: true, orderNumber: res.orderNumber, outcome: a.outcome, pushed };
  }

  /** One attempt now; the scheduled task is the retry. */
  private async tryPushCod(orderId: string): Promise<boolean> {
    try {
      const r = await pushCodOutcome(this.host(), orderId);
      if (r.pushed) this.sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'cod_outcome_push' AND json_extract(payload, '$.orderId') = ? AND lease_until IS NULL", orderId);
      return r.pushed || (r.reason === 'nothing_to_push');
    } catch (err) {
      alert('cod_outcome_push_failed', { workspace: this.workspaceId, error: errClass(err) });
      return false;
    }
  }

  /**
   * One-time code over WhatsApp (OTP-1), gated by the `otpViaWhatsApp` setting (default off). Only an AUTHENTICATION template
   * may carry it; the text is stored masked. It is sent at once or not at all: a throttled, capped or retryable-failed code
   * is marked failed (the caller falls back to email) and no scheduler row or queue message ever holds it. Bounded per phone
   * and per workspace (toll fraud), counted in the same transaction that stores the message.
   */
  async queueOtp(waId: string, phoneNumberId: string, code: string): Promise<OtpResult> {
    const copy = storeLink().copy;
    if (!copy) return { ok: false, reason: 'unavailable' };
    if (!readSettings(this.host()).otpViaWhatsApp) return { ok: false, reason: 'disabled' };
    const policy = storeLink().otp;
    const now = Date.now();
    await this.ensurePricing(now);
    await this.repullIfUnknown(phoneNumberId, now);
    const key = `otp:${crypto.randomUUID()}`;
    const queued = this.ctx.storage.transactionSync((): OtpResult | { job: SendJob } => {
      const since = now - OTP_RATE_WINDOW_MS;
      const count = (extra: string, ...params: SqlStorageValue[]) => this.sql.exec<{ n: number }>(
        `SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
         WHERE m.template_name = ? AND m.created_at > ? ${extra}`, copy.templates.otp, since, ...params,
      ).one().n;
      if (count('') >= policy.workspaceMax || count('AND ct.wa_id = ?', waId) >= policy.phoneMax) return { ok: false, reason: 'rate_limited' };
      const r = queueTemplate(this.host(), {
        waId, phoneNumberId, name: copy.templates.otp, language: 'ar', fallbackLanguage: 'en', params: [code], idempotencyKey: key,
        requireCategory: 'AUTHENTICATION', maskText: OTP_MASK, scheduleRelease: false, now,
      });
      if (!r.ok) return { ok: false, reason: r.reason === 'template_not_approved' || r.reason === 'wrong_category' ? 'template_unavailable' : r.reason === 'wallet_empty' ? 'wallet_empty' : r.reason === 'funding_unknown' || r.reason === 'rate_unavailable' || r.reason === 'plan_required' ? 'unavailable' : 'invalid' };
      return r.duplicate ? { ok: true } : { job: r.job };
    });
    if (!('job' in queued)) return queued;
    await this.deliverOtp(queued.job);
    const row = this.sql.exec<{ status: string; error_reason: string | null }>('SELECT status, error_reason FROM messages WHERE idempotency_key = ?', key).toArray()[0];
    if (row?.status === 'failed') return { ok: false, reason: row.error_reason === 'rate_limited' ? 'rate_limited' : 'send_failed' };
    return { ok: true };
  }

  /** claim (never deferring) -> Meta -> record; any failure, retryable or not, is final. */
  private async deliverOtp(job: SendJob): Promise<void> {
    const claim = await this.claimSend(job, Date.now(), { noDefer: true });
    if (claim !== 'claimed') return; // 'dropped' = failed rate_limited already recorded
    const sent = await sendToMeta(this.env, sendJobSchema.parse(job));
    await this.recordOutbound(job.idempotencyKey, sent.ok ? sent : { ...sent, retryable: false });
  }

  async getStoreLinkSettings(): Promise<StoreLinkSettings> {
    return readSettings(this.host());
  }

  /** SETTINGS-CONFIRM-1: issues a single-use token for turning customer-visible sending on. At most CONFIRM_MAX_PENDING live tokens: the oldest go first. */
  async issueSettingsConfirm(actor: string, hash: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const expiresAt = now + CONFIRM_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM store_state WHERE key LIKE 'confirm.settings.%' AND CAST(json_extract(value, '$.exp') AS INTEGER) < ?", now);
      this.sql.exec("DELETE FROM store_state WHERE key IN (SELECT key FROM store_state WHERE key LIKE 'confirm.settings.%' ORDER BY CAST(json_extract(value, '$.exp') AS INTEGER) ASC LIMIT max(0, (SELECT count(*) FROM store_state WHERE key LIKE 'confirm.settings.%') - ?))", CONFIRM_MAX_PENDING - 1);
      this.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?)', `confirm.settings.${token}`, JSON.stringify({ actor, hash, exp: expiresAt }));
    });
    return { token, expiresAt };
  }

  /** Checks and burns the token in one step (this object is single-threaded): a token is gone after ANY attempt, right or wrong. */
  async consumeSettingsConfirm(token: string, actor: string, hash: string, now = Date.now()): Promise<ConfirmOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const key = `confirm.settings.${token}`;
      const raw = this.sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', key).toArray()[0]?.value;
      if (raw === undefined) return 'invalid';
      this.sql.exec('DELETE FROM store_state WHERE key = ?', key);
      const row = JSON.parse(raw) as { actor: string; hash: string; exp: number };
      if (row.exp < now) return 'expired';
      return row.actor === actor && row.hash === hash ? 'ok' : 'mismatch';
    });
  }

  /**
   * Saves settings. A catalog id is a capability on the platform token, so changing it needs the WABA it was verified
   * against (`catalogWabaId`, checked by the caller against Meta); without it the change is refused.
   */
  async setStoreLinkSettings(patch: Partial<StoreLinkSettings>, opts: { catalogWabaId?: string } = {}): Promise<{ ok: true; settings: StoreLinkSettings } | { ok: false; reason: 'catalog_not_verified' }> {
    const before = readSettings(this.host()).catalogId;
    if (patch.catalogId && patch.catalogId !== before && !opts.catalogWabaId) return { ok: false, reason: 'catalog_not_verified' };
    const settings = this.ctx.storage.transactionSync(() => {
      const saved = writeSettings(this.host(), patch);
      if (patch.catalogId && opts.catalogWabaId) putState(this.host(), 'catalog.waba', opts.catalogWabaId);
      if (patch.catalogId === null) this.sql.exec("DELETE FROM store_state WHERE key = 'catalog.waba'");
      // A newly configured catalog gets a full reconcile soon, then nightly.
      if (saved.catalogId && saved.catalogId !== before) ensureCatalogReconcile(this.host(), Date.now(), true);
      return saved;
    });
    await this.arm();
    return { ok: true, settings };
  }

  /** Bot results for a range of Cairo days (validated at the route). Counts only. */
  async getBotFunnel(from: string, to: string): Promise<BotFunnelDto> {
    return readFunnel(this.sql, from, to);
  }

  async getCatalogStatus(): Promise<CatalogStatusDto> {
    return catalogStatus(this.host());
  }

  /** "Resync now": a fresh full pass starts within seconds (an unfinished pass is left to finish). False = no catalogue is connected. */
  async resyncCatalog(): Promise<{ started: boolean }> {
    const host = this.host();
    if (!readSettings(host).catalogId) return { started: false };
    if (!getState(host, 'catalog.pass')) ensureCatalogReconcile(host, Date.now(), true);
    else this.sql.exec("UPDATE scheduled_tasks SET due_at = ? WHERE kind = 'catalog_reconcile' AND due_at > ?", Date.now(), Date.now());
    await this.arm();
    return { started: true };
  }

  /** The shop button and cart on the business number, as the merchant wants them. Returns what Meta now has (null = no verified catalogue or number). */
  async setCatalogCommerce(want: { catalogVisible: boolean; cartEnabled: boolean }): Promise<CommerceState | null> {
    const host = this.host();
    const auth = await commerceAuth(host);
    if (!auth) return null;
    return ensureCommerce(host, auth, { fresh: true, want });
  }

  private provisioningCatalog = false;

  /** Creates and connects a Meta catalog for this workspace's WABA, then saves it (full sync scheduled). Idempotent across retries; one run at a time. */
  async provisionCatalog(a: { name?: string; wabaId: string; businessId: string }): Promise<ProvisionResult> {
    // Every Meta call is an await that opens the input gate: a second request must not interleave with a running one.
    if (this.provisioningCatalog) return { ok: false, code: 'meta_error', retryable: true };
    this.provisioningCatalog = true;
    try {
      const res = await provisionCatalog(this.host(), a, (catalogId, wabaId) => {
        this.ctx.storage.transactionSync(() => {
          writeSettings(this.host(), { catalogId });
          putState(this.host(), 'catalog.waba', wabaId);
          ensureCatalogReconcile(this.host(), Date.now(), true);
        });
      });
      await this.arm();
      return res;
    } finally {
      this.provisioningCatalog = false;
    }
  }

  // ---- Campaigns (Phase 6): contacts + imports -------------------------------------------------------------------

  async createImport(a: { id: string; filename: string; r2Key: string; size: number; consented: boolean; wording?: string | null; mapping: ImportState['mapping']; actor: string }): Promise<{ ok: true } | { ok: false; reason: 'import_in_progress' }> {
    return createImport(this.host(), { ...a, now: Date.now() });
  }

  async importState(id: string): Promise<ImportState | null> {
    return importState(this.host(), id);
  }

  /** Row cap of one import; a field so a test can lower it. */
  importMaxRows = MAX_IMPORT_ROWS;

  async applyImportChunk(a: Omit<ApplyArgs, 'now' | 'maxRows'>): Promise<{ ok: true; done: boolean } | { ok: false; reason: 'unknown_import' | 'not_running' | 'offset_mismatch' }> {
    const r = applyImportChunk(this.host(), { ...a, now: Date.now(), maxRows: this.importMaxRows });
    if (!r.ok) return r;
    if (r.keys.length) await this.settleR2();
    return { ok: true, done: r.done };
  }

  /** Ends an import that cannot go on; its uploaded file (phone numbers) is deleted from R2. */
  async failImport(id: string, reason: string): Promise<void> {
    const r = failImport(this.host(), id, reason, Date.now());
    if (r.keys.length) await this.settleR2();
  }

  async getImport(id: string) {
    return importSummary(this.host(), id);
  }

  async listImports(limit: number) {
    return listImports(this.host(), limit);
  }

  async importRejects(id: string) {
    return listRejects(this.host(), id);
  }

  async listContacts(q: ContactQuery) {
    return listContacts(this.host(), q);
  }

  async setContactTags(waId: string, tags: string[]) {
    return setContactTags(this.host(), waId, tags);
  }

  // ---- Campaigns (Phase 6): segments ---------------------------------------------------------------------------------

  async listSegments() {
    return listSegments(this.host());
  }

  async getSegment(id: number) {
    return getSegment(this.host(), id);
  }

  async createSegment(a: { name: string; criteria: SegmentCriteria; actor: string }) {
    return createSegment(this.host(), { ...a, now: Date.now() });
  }

  async updateSegment(id: number, patch: { name?: string; criteria?: SegmentCriteria }) {
    return updateSegment(this.host(), id, patch, Date.now());
  }

  async deleteSegment(id: number): Promise<boolean> {
    return deleteSegment(this.host(), id);
  }

  async previewAudience(criteria: SegmentCriteria) {
    return previewAudience(this.host(), criteria);
  }

  async audiencePage(criteria: SegmentCriteria, afterId: number, limit: number) {
    return audiencePage(this.host(), criteria, afterId, limit);
  }

  // ---- Campaigns (Phase 6): broadcasts ---------------------------------------------------------------------------------

  /** Recipients per workflow page; a field so a test can use small pages. */
  campaignPageSize = PAGE_SIZE;

  async createCampaign(a: Omit<CreateArgs, 'now'>) {
    return createCampaign(this.host(), { ...a, now: Date.now() });
  }

  async getCampaign(id: string) {
    return getCampaign(this.host(), id);
  }

  async getCampaignReport(id: string) {
    return campaignReport(this.host(), id);
  }

  async getConsentEvidence(after: number, limit: number) {
    return consentEvidence(this.sql, after, limit);
  }

  async listCampaigns(q: { status?: Parameters<typeof listCampaigns>[1]['status']; cursor?: number; limit: number }) {
    return listCampaigns(this.host(), q);
  }

  async deleteCampaignDraft(id: string) {
    return deleteDraft(this.host(), id);
  }

  /** draft -> running / scheduled, then starts the workflow. A failed start is retried by the sweep, so the campaign is never left dormant. */
  async sendCampaign(id: string, scheduledAt?: number) {
    if (this.numberBlocksCampaign(id)) return { ok: false as const, reason: 'number_restricted' as const };
    const now = Date.now();
    const r = await sendCampaign(this.host(), id, scheduledAt, now);
    if (r.ok) await launchCampaign(this.host(), id, now);
    return r;
  }

  async pauseCampaign(id: string, reason: 'manual' = 'manual') {
    const r = await pauseCampaign(this.host(), id, reason, Date.now());
    if (r.ok) await endInstance(this.host(), id, this.campaignAttempt(id));
    return r;
  }

  /** A campaign cannot start or resume while its number is red or restricted: every template would be refused at claim. */
  private numberBlocksCampaign(id: string): boolean {
    const row = this.sql.exec<{ phone_number_id: string }>('SELECT phone_number_id FROM campaigns WHERE id = ?', id).toArray()[0];
    return !!row && blocksTemplates(currentHealth(this.sql, row.phone_number_id));
  }

  async resumeCampaign(id: string) {
    if (this.numberBlocksCampaign(id)) return { ok: false as const, reason: 'number_restricted' as const };
    const now = Date.now();
    const r = await resumeCampaign(this.host(), id, now);
    if (r.ok) {
      await this.arm();
      await launchCampaign(this.host(), id, now);
    }
    return r;
  }

  async cancelCampaign(id: string) {
    const r = await cancelCampaign(this.host(), id, Date.now(), (mid) => this.emitMessageStatus(mid));
    if (r.ok) {
      await endInstance(this.host(), id, this.campaignAttempt(id));
      await settleWallet(this.host(), id);
    }
    return r;
  }

  /** A recipient opened their tracked link: where to send them (UTM added), or null when the link is unknown or its contact was erased. `count` false = a preview bot or HEAD. */
  async recordClick(code: string, count: boolean) {
    return recordClick(this.host(), code, count, Date.now());
  }

  private campaignAttempt(id: string): number {
    return this.sql.exec<{ attempt: number }>('SELECT attempt FROM campaigns WHERE id = ?', id).toArray()[0]?.attempt ?? 0;
  }

  // The three steps of the campaign workflow (see campaigns/workflows.ts).
  async campaignStart(id: string, attempt: number) {
    return campaignStart(this.host(), id, attempt);
  }

  async campaignActivate(id: string, attempt: number) {
    return campaignActivate(this.host(), id, attempt, Date.now());
  }

  async campaignPage(id: string, attempt: number, page: number) {
    return campaignPage(this.host(), id, attempt, page, Date.now(), this.campaignPageSize);
  }

  /** Deletes the R2 objects owed so far; whatever R2 refuses stays owed and is retried within the hour. */
  private async settleR2(): Promise<void> {
    if ((await this.drainR2Deletes()) > 0) await this.schedule('r2_drain', Date.now() + 3_600_000);
  }

  // ---- AI agent (Phase 5) ------------------------------------------------------------------------------------------

  /** The agent's settings as the owner sees them. The model key is never returned, only whether one is stored. */
  async getAgentSettings(): Promise<AgentSettingsDto> {
    return this.agentDto();
  }

  private agentDto(): AgentSettingsDto {
    return { ...readAgentSettings(this.sql), hasApiKey: hasApiKey(this.sql), credits: creditsAvailable(this.sql, Date.now()), knowledgeReady: knowledgeReady(this.sql) };
  }

  /** Saves (merges) the agent's settings; a refusal comes back as data and nothing is written. */
  async setAgentSettings(patch: AgentSettingsUpdate): Promise<{ ok: true; settings: AgentSettingsDto } | { ok: false; reason: SettingsRefusal }> {
    const plan = await planAgentUpdate(this.env, this.workspaceId, this.sql, patch);
    if (!plan.ok) return plan;
    const before = readAgentSettings(this.sql);
    // The FAQ is chunked (ids are hashes, hence async) before the write; a changed text becomes a new version, indexed by a task.
    const faqChanged = plan.settings.faqText !== before.faqText;
    const chunks = faqChanged ? await prepareChunks(this.workspaceId, nextKbVersion(this.sql), plan.settings.faqText) : [];
    this.ctx.storage.transactionSync(() => {
      writeAgentSettings(this.sql, plan.settings, plan.secret);
      if (faqChanged) stageFaq(this.host(), chunks, Date.now());
      if (plan.settings.enabled && !before.enabled) scheduleCatalogEmbed(this.host(), Date.now(), 0);
      if (plan.settings.notifyPhone) ensureDigestTask(this.host(), Date.now());
    });
    await this.arm();
    return { ok: true, settings: this.agentDto() };
  }

  // ---- Connectors (Phase 9.3): owner-only settings; the secret never leaves the DO ---------------------------------------

  async listConnectors(): Promise<ConnectorDto[]> {
    return listConnectors(this.sql).map(connectorDto);
  }

  async putConnector(id: string, body: ConnectorPut, actor: string | null): Promise<{ ok: true; connector: ConnectorDto } | { ok: false; reason: PutRefusal }> {
    const plan = await planConnectorPut(this.env, this.workspaceId, this.sql, id, body, actor, Date.now());
    if (!plan.ok) return plan;
    this.ctx.storage.transactionSync(() => writeConnector(this.sql, plan.row, plan.secretEnc));
    return { ok: true, connector: connectorDto(plan.row) };
  }

  private connectorTestAt = new Map<string, number>();
  /** A harmless call to the client's system (webhook ping / Odoo version + login). One per connector every 5 s; null = no such connector. */
  async testConnector(id: string): Promise<{ ok: boolean; error?: string; detail?: string } | null> {
    const last = this.connectorTestAt.get(id) ?? 0;
    if (Date.now() - last < 5_000) return { ok: false, error: 'rate_limited' };
    this.connectorTestAt.set(id, Date.now());
    return testConnector(this.host(), id);
  }

  async deleteConnector(id: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => deleteConnector(this.sql, id));
  }

  // AI credits (Phase 7 hooks: packages call these; there is no public route). All answers are result objects.

  async aiCredits(now = Date.now()): Promise<{ balance: number; available: number }> {
    return { balance: creditBalance(this.sql), available: creditsAvailable(this.sql, now) };
  }
  /** The period's grant, once per (period, package). */
  async grantAiCredits(a: { periodStart: number; packageId: string; credits: number; actor?: string }, now = Date.now()): Promise<Posted> {
    return this.ctx.storage.transactionSync(() => grantCredits(this.sql, { ...a, now }));
  }
  /** An upgrade mid-period grants only the difference. */
  async upgradeAiCredits(a: { periodStart: number; toPackage: string; toCredits: number; actor?: string }, now = Date.now()): Promise<Posted> {
    return this.ctx.storage.transactionSync(() => upgradeGrant(this.sql, { ...a, now }));
  }
  /** Period end: unused granted credits expire; returns how many. */
  async expireAiCredits(periodStart: number, now = Date.now(), ref?: string): Promise<{ expired: number }> {
    return { expired: this.ctx.storage.transactionSync(() => expireGrant(this.sql, { periodStart: lastGrantStart(this.sql, periodStart), now, ...(ref ? { ref } : {}) })) };
  }
  /** A refunded upgrade: the current month's granted credits above `keepCredits` (the allowance of the package it goes back to) expire, unused ones only (idempotent under `ref`). */
  async revokeUpgradeCredits(a: { keepCredits: number; ref: string }, now = Date.now()): Promise<{ expired: number }> {
    return {
      expired: this.ctx.storage.transactionSync(() => {
        const e = this.sql.exec<{ period_start: number }>('SELECT period_start FROM entitlements WHERE id = 1').toArray()[0];
        return e ? revokeGrantExcess(this.sql, { periodStart: lastGrantStart(this.sql, e.period_start), keep: a.keepCredits, now, ref: a.ref }) : 0;
      }),
    };
  }
  /** A partial refund of a package: `num/den` of the period's unused granted credits expire under `ref` (idempotent). */
  async expireAiCreditsFraction(a: { periodStart: number; num: number; den: number; ref: string }, now = Date.now()): Promise<{ expired: number }> {
    return { expired: this.ctx.storage.transactionSync(() => expireGrantFraction(this.sql, { ...a, now })) };
  }
  /** WA-PACK-REFUND-1: expires the unused part of a refunded credit pack (see expirePackUnused). Idempotent under `ref`. */
  async expireRefundedPack(a: { credits: number; num: number; den: number; ref: string; orderId: string }, now = Date.now()): Promise<{ expired: number; spent: number; duplicate?: true }> {
    return this.ctx.storage.transactionSync(() => expirePackUnused(this.sql, { ...a, now }));
  }
  /** A purchase, refund or operator adjustment: the ref makes it idempotent; an operator adjustment needs an actor and a reason. */
  async postAiCredits(a: { kind: Extract<CreditKind, 'purchase' | 'refund' | 'adjustment'>; amount: number; ref: string; actor?: string; note?: string }, now = Date.now()): Promise<Posted | { ok: false; reason: 'actor_and_note_required' }> {
    if (a.kind === 'adjustment' && (!a.actor || !a.note)) return { ok: false, reason: 'actor_and_note_required' };
    return this.ctx.storage.transactionSync(() => postCredit(this.sql, { ...a, now }));
  }

  // ---- Wallet (Phase 7) --------------------------------------------------------------------------------------------------
  // All answers are result objects. The only writers of money are Billing.post (one synchronous transaction per row) and the AI credit ledger.

  /** T13: the weekly digest (counts only), or `{ enabled: false }` when the owner switched it off. */
  async weeklyDigest(now = Date.now()): Promise<DigestDto> {
    if (!digestEnabled(this.sql)) return { enabled: false };
    const view = this.billing.view(now);
    const available = creditsAvailable(this.sql, now);
    const allowance = monthlyAllowance(this.sql);
    return {
      enabled: true, ...digestCounts(this.sql, now), balanceMinor: view.balanceMinor, availableMinor: view.availableMinor, lowBalance: view.lowBalance,
      aiCredits: { available, low: available < lowCreditsThreshold(allowance), lowThreshold: lowCreditsThreshold(allowance), allowance },
    };
  }
  async setDigestEnabled(enabled: boolean): Promise<void> {
    setDigestEnabled(this.sql, enabled);
  }

  async walletView(now = Date.now()) {
    await this.ensurePricing(now);
    const ent = readEntitlement(this.sql);
    return {
      ...this.billing.view(now),
      funding: Object.fromEntries(this.sql.exec<{ phone_number_id: string; funding: string }>('SELECT phone_number_id, funding FROM number_funding').toArray().map((f) => [f.phone_number_id, f.funding])),
      aiCredits: (() => {
        const available = creditsAvailable(this.sql, now);
        const allowance = monthlyAllowance(this.sql);
        return { balance: creditBalance(this.sql), available, low: available < lowCreditsThreshold(allowance), lowThreshold: lowCreditsThreshold(allowance), allowance };
      })(),
      plan: ent ? { packageId: ent.packageId, status: ent.status, periodEnd: ent.periodEnd, cancelledAt: ent.cancelledAt } : null,
    };
  }

  /**
   * A top-up, refund, chargeback or operator adjustment. `netMinor` is signed (+ credits the wallet). The ref makes it idempotent. Funds
   * arriving release the sends that waited for them. A top-up settles debt first simply by being added to a negative balance.
   */
  async postWallet(
    a: { kind: 'topup' | 'refund' | 'chargeback' | 'adjustment' | 'meta_adjust'; netMinor: number; vatMinor?: number; ref: string; actor?: string; note?: string },
    now = Date.now(),
  ): Promise<(WalletPosted & { debtSettledMinor: number }) | { ok: false; reason: 'actor_and_note_required' | 'bad_sign' }> {
    if ((a.kind === 'adjustment' || a.kind === 'meta_adjust') && (!a.actor || !a.note)) return { ok: false, reason: 'actor_and_note_required' };
    const total = a.netMinor + (a.vatMinor ?? 0);
    if ((a.kind === 'topup' && total <= 0) || ((a.kind === 'refund' || a.kind === 'chargeback') && total >= 0)) return { ok: false, reason: 'bad_sign' };
    const out = this.ctx.storage.transactionSync(() => {
      const before = this.billing.balance();
      const r = this.billing.post({ kind: a.kind, netMinor: a.netMinor, ref: a.ref, now, ...(a.vatMinor ? { vatMinor: a.vatMinor } : {}), ...(a.actor ? { actor: a.actor } : {}), ...(a.note ? { note: a.note } : {}) });
      if (r.ok && r.amountMinor > 0) this.billing.releaseWaiters(now);
      return { ...r, debtSettledMinor: r.ok && r.amountMinor > 0 && before < 0 ? Math.min(-before, r.amountMinor) : 0 };
    });
    await this.flushArm();
    return out;
  }

  /**
   * InstaPay auto-confirm revert, wallet half (INSTAPAY-REVERT-1): removes the part of ONE top-up nobody spent since it arrived, never more than the available balance and
   * never money that arrived later; consumed credits are not clawed back. Idempotent under `ref`: the first answer is stored in `store_state`, a replay returns it and posts nothing (even when the
   * first answer was "nothing to remove").
   */
  async revertInstapayWallet(a: { creditedMinor: number; creditRef: string; ref: string; actor: string; note: string }, now = Date.now()): Promise<{ removedMinor: number; usedMinor: number }> {
    const out = this.ctx.storage.transactionSync(() => {
      const key = `instapay.revert:${a.ref}`;
      const prior = this.sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', key).toArray()[0];
      if (prior) return JSON.parse(prior.value) as { removedMinor: number; usedMinor: number };
      // INSTAPAY-REVERT-1: what is removed is max(0, min(credited - spend recorded SINCE that top-up, available balance)). Money that arrived later (a card top-up after
      // this one) is never taken: spend after the top-up is counted against it first, and the balance only caps the result. No credit row = nothing was credited.
      const credit = this.sql.exec<{ id: number }>('SELECT id FROM wallet_ledger WHERE ref = ?', a.creditRef).toArray()[0];
      // Only CONSUMPTION counts as spend (Meta charges and their adjustments, AI charges): never another revert's removal (`instapay-revert:` adjustments), an operator
      // adjustment, a refund or a chargeback, which are not this money being used (review N1).
      const spent = credit ? this.sql.exec<{ s: number }>("SELECT coalesce(-sum(amount_minor), 0) AS s FROM wallet_ledger WHERE id > ? AND amount_minor < 0 AND kind IN ('meta_charge', 'meta_adjust', 'ai_charge')", credit.id).one().s : 0;
      const removedMinor = credit ? unusedCreditsToRemove({ granted: a.creditedMinor, consumed: Math.min(a.creditedMinor, spent), balance: Math.max(0, this.billing.available()) }) : 0;
      if (removedMinor > 0) this.billing.post({ kind: 'adjustment', netMinor: -removedMinor, ref: a.ref, now, actor: a.actor, note: a.note });
      const res = { removedMinor, usedMinor: Math.max(0, a.creditedMinor - removedMinor) };
      this.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?)', key, JSON.stringify(res));
      return res;
    });
    await this.flushArm();
    return out;
  }

  /**
   * InstaPay auto-confirm revert, AI-credit half: the grant of ONE package period (`grant:<periodStart>:<packageId>`) loses what nobody used (consumed and already
   * expired credits stay as they are, the balance never goes negative). Idempotent under `ref` like the wallet half.
   */
  async revertInstapayAiCredits(a: { periodStart: number; packageId: string; ref: string; actor: string; note: string }, now = Date.now()): Promise<{ removedCredits: number; usedCredits: number }> {
    return this.ctx.storage.transactionSync(() => {
      const key = `instapay.revert:${a.ref}`;
      const prior = this.sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', key).toArray()[0];
      if (prior) return JSON.parse(prior.value) as { removedCredits: number; usedCredits: number };
      const granted = this.sql.exec<{ g: number }>("SELECT coalesce(sum(amount), 0) AS g FROM credit_ledger WHERE kind = 'grant' AND ref = ?", `grant:${a.periodStart}:${a.packageId}`).one().g;
      const charged = this.sql.exec<{ u: number }>("SELECT coalesce(-sum(amount), 0) AS u FROM credit_ledger WHERE kind = 'ai_charge' AND at >= ?", a.periodStart).one().u;
      const expired = this.sql.exec<{ e: number }>("SELECT coalesce(-sum(amount), 0) AS e FROM credit_ledger WHERE kind = 'expire' AND parent_ref = ?", `period:${a.periodStart}`).one().e;
      const removedCredits = unusedCreditsToRemove({ granted, consumed: charged + expired, balance: creditsAvailable(this.sql, now) });
      if (removedCredits > 0) postCredit(this.sql, { kind: 'adjustment', amount: -removedCredits, ref: a.ref, now, actor: a.actor, note: a.note });
      const res = { removedCredits, usedCredits: Math.max(0, granted - removedCredits) };
      this.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?)', key, JSON.stringify(res));
      return res;
    });
  }

  /** What a send of `count` messages would cost the wallet now. A merchant-card number costs the wallet nothing (Meta bills the card). */
  async estimateCost(a: { phoneNumberId: string; category: string; country?: string; count: number }, now = Date.now()) {
    await this.ensurePricing(now);
    const funding = fundingOf(this.sql, a.phoneNumberId);
    if (funding === 'unknown') return { funding: 'merchant_card' as const, perMessageMinor: 0, totalMinor: 0, priced: false, paidBy: 'merchant_card' as const };
    if (funding !== 'platform_line') return { funding, perMessageMinor: 0, totalMinor: 0, priced: true, paidBy: 'merchant_card' as const };
    const e = this.billing.estimateMinor(a.country ? countryToDigits(a.country) : '20', a.category, now);
    return { funding, perMessageMinor: e.minor, totalMinor: e.minor * a.count, priced: e.priced, paidBy: 'wallet' as const };
  }

  async walletStatement(month: string) {
    return buildStatement(this.sql, month);
  }

  async drainLedger(now = Date.now()) {
    return drainOutbox(this.env, this.sql, this.workspaceId, now);
  }

  async mirrorCheck() {
    return checkMirror(this.env, this.sql, this.workspaceId);
  }

  // ---- Packages (Phase 7.1) ----------------------------------------------------------------------------------------

  /** One subscription event from the control plane. An older or equal version is ignored ('stale'). */
  async applyEntitlement(ev: EntitlementEvent, now = Date.now()): Promise<'applied' | 'stale' | 'invalid'> {
    const r = this.ctx.storage.transactionSync(() => applyEntitlement(this.sql, ev, now));
    if (r === 'applied') {
      await this.arm();
      // A downgrade never deletes anyone: staff beyond the new limit simply stop working until the owner frees a seat. The owner sees it on the Team screen; we are told once per change.
      if (seatsOverLimit(this.sql, now)) alert('seats_over_limit', { workspace: this.workspaceId });
      this.closeUnseatedSockets(this.ctx.getWebSockets());
    }
    return r;
  }

  /** Seats (WA-SEATS-1). The owner's seat-assignment routes and the staff gate in the identity middleware are the only callers. */
  async seatSummary(): Promise<{ limit: number; seats: SeatRow[] }> {
    return listSeats(this.sql);
  }
  async seatOf(userId: string): Promise<SeatState> {
    return seatState(this.sql, userId);
  }
  /** Drops rows of people who left the team, then seats `userId` if there is room: one DO call, so two requests cannot both take the last seat. */
  async assignSeat(userId: string, by: string, activeStaffIds: string[]): Promise<AssignResult> {
    const r = this.ctx.storage.transactionSync(() => {
      pruneSeats(this.sql, activeStaffIds);
      return assignSeat(this.sql, userId, by);
    });
    this.closeUnseatedSockets(this.ctx.getWebSockets()); // the prune above may have dropped a leaver's seat
    return r;
  }
  async removeSeat(userId: string): Promise<void> {
    removeSeat(this.sql, userId);
    this.closeUnseatedSockets(this.ctx.getWebSockets());
  }
  async pruneSeats(activeStaffIds: string[]): Promise<void> {
    pruneSeats(this.sql, activeStaffIds);
    this.closeUnseatedSockets(this.ctx.getWebSockets());
  }

  /** Which of these wallet refs are on the ledger (to reverse only what was really posted). */
  async walletRefsPresent(refs: string[]): Promise<string[]> {
    return refs.filter((ref) => this.sql.exec('SELECT 1 FROM wallet_ledger WHERE ref = ?', ref).toArray().length > 0);
  }

  /** WA-NOFREE-1: may this workspace send, run the agent or set a number up right now? (routes ask this before doing any of it) */
  async serviceOk(): Promise<boolean> {
    return serviceAllowed(this.sql, Date.now());
  }

  async getEntitlement() {
    return readEntitlement(this.sql);
  }

  /** Whether this workspace's plan allows a feature right now (no entitlement, a lapsed status or a package without it = false). Read per call, never cached. */
  async planAllows(feature: PlanFeature): Promise<boolean> {
    return featureAllowed(this.sql, feature, Date.now());
  }

  /** Seats the plan allows, the owner included (1 without a live entitlement). */
  async planMemberLimit(): Promise<number> {
    return memberLimit(this.sql);
  }

  /** One-shot check at an InstaPay proof's review deadline (the SLA): the control plane alerts once if the request is still under review. */
  async scheduleInstapayOverdue(requestId: string, dueAt: number): Promise<void> {
    this.ctx.storage.transactionSync(() => addTask(this.sql, 'instapay_overdue', dueAt, { instapayRequestId: requestId }));
    await this.arm();
  }

  /**
   * A message that waited for funds. Funds arrived (or its deadline did): fail it at the deadline, re-check the 24 h window for free
   * text, otherwise hand it back to the queue, where the claim takes the wallet's decision again (it may wait again, with the SAME deadline).
   */
  private async releaseWaiting(job: z.output<typeof sendJobSchema>, now: number): Promise<undefined> {
    const key = job.idempotencyKey;
    const msg = this.sql.exec<{ id: number; status: string }>('SELECT id, status FROM messages WHERE idempotency_key = ?', key).toArray()[0];
    if (!msg || msg.status !== 'queued') {
      this.sql.exec('DELETE FROM wallet_waits WHERE key = ?', key);
      return undefined;
    }
    const w = this.sql.exec<{ wait_until: number }>('SELECT wait_until FROM wallet_waits WHERE key = ?', key).toArray()[0];
    const last = jobKind(job) === 'template' ? null : this.sql.exec<{ t: number | null }>('SELECT last_inbound_at AS t FROM contacts WHERE wa_id = ?', job.to).toArray()[0]?.t ?? null;
    const windowClosed = jobKind(job) !== 'template' && !(last && last * 1000 + WINDOW_MS > now);
    const reason = !w || now >= w.wait_until ? 'wallet_empty_expired' : windowClosed ? 'window_closed' : null;
    if (reason) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE messages SET status = 'failed', error_reason = ?, updated_at = ? WHERE id = ?", reason, now, msg.id);
        this.emitMessageStatus(msg.id);
        this.billing.settleHold(key, 'failed', now);
      });
      alert('wallet_wait_expired', { workspace: this.workspaceId, reason });
      return undefined;
    }
    await this.env.SEND_QUEUE.sendBatch([{ body: job }]);
    return undefined;
  }

  /** Operator action: a full reconcile now. `allowMassDelete` lifts the automatic safety limit on archiving. */
  async reconcileCatalog(opts: { allowMassDelete?: boolean } = {}): Promise<void> {
    await runCatalogReconcile(this.host(), Date.now(), opts);
  }

  // ---- realtime ---------------------------------------------------------------------------------------------------

  /** Upgrade to a WebSocket (hibernation API: an idle socket costs nothing and the DO can be evicted). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a websocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    // Survives hibernation: the token's expiry (epoch s) and the caller's role, so a long-lived socket is re-authorised on every push.
    const exp = Number(request.headers.get(WS_EXP_HEADER));
    server.serializeAttachment({ exp: Number.isFinite(exp) && exp > 0 ? exp : 0, role: request.headers.get(WS_ROLE_HEADER) ?? 'unknown', userId: request.headers.get(WS_USER_HEADER) ?? '', sessionId: request.headers.get(WS_SESSION_HEADER) ?? '' } satisfies SocketAttachment);
    await this.schedule('ws_sweep', Date.now() + WS_SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'inbox.v1' } });
  }

  override webSocketMessage(): void {
    // Clients only listen. 'ping' is auto-answered; anything else is ignored.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  /** Appends an event (inside the caller's transaction) and schedules a push to open sockets once it has committed. */
  private recordEvent(payload: Record<string, unknown>): void {
    const seq = this.sql.exec<{ seq: number }>('INSERT INTO events (payload, at) VALUES (?, ?) RETURNING seq', JSON.stringify(payload), Date.now()).one().seq;
    if (seq > EVENTS_KEPT) this.sql.exec('DELETE FROM events WHERE seq <= ?', seq - EVENTS_KEPT);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // After the (synchronous) transaction returns; rows of a rolled-back transaction are simply not there to send.
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.broadcast();
    });
  }

  /**
   * WA-SEATS-1: a staff socket stays open only while its user holds a seat. Closes (4403) every staff socket whose user is not 'seated' now (removed seat, left the
   * team, downgrade, plan lapse). Owners and operators are untouched. Without a Store link there are no seats, so nothing is closed. Returns the sockets that may keep receiving.
   */
  private closeUnseatedSockets(sockets: WebSocket[]): WebSocket[] {
    if (!sockets.some((ws) => (ws.deserializeAttachment() as SocketAttachment | null)?.role === 'staff')) return sockets;
    if (!bridgeForWorkspace(this.env, this.workspaceId)) return sockets;
    const seated = new Set(listSeats(this.sql).seats.filter((x) => x.state === 'seated').map((x) => x.userId));
    return sockets.filter((ws) => {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.role === 'staff' && !(att.userId && seated.has(att.userId))) {
        try { ws.close(WS_CLOSE_NO_SEAT, 'no seat'); } catch { /* already closed */ }
        return false;
      }
      return true;
    });
  }

  /**
   * WA-6: an open socket is re-authorised on a timer, not only at a push: past its (capped) expiry it closes 4401; a person whose Store membership is gone, or whose session
   * is revoked, closes 4403; a changed role is re-read and applied (downgrade). A check that cannot be answered (Store or accounts down) leaves the socket for the next sweep: the lifetime cap bounds that window.
   */
  private async sweepSockets(nowS: number): Promise<void> {
    const bridge = bridgeForWorkspace(this.env, this.workspaceId);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      const close = (code: number, why: string) => { try { ws.close(code, why); } catch { /* already closed */ } };
      if (!att || att.exp <= nowS) { close(WS_CLOSE_TOKEN_EXPIRED, 'token expired'); continue; }
      if (att.sessionId && (await writeSessionState(this.env, att.sessionId)) === 'revoked') { close(WS_CLOSE_NO_SEAT, 'session revoked'); continue; }
      if (bridge && att.userId && (att.role === 'owner' || att.role === 'staff')) {
        const live = await bridge.memberRole(this.workspaceId, att.userId);
        if (live.ok && live.value.role === null) close(WS_CLOSE_NO_SEAT, 'not a member');
        // A role that changed since the socket opened (owner demoted to staff, or the reverse) is rewritten now, so the next push applies the LIVE role: a demoted owner
        // is then subject to the staff seat check (closeUnseatedSockets) instead of keeping owner reach for the rest of the socket's life.
        else if (live.ok && live.value.role !== null && live.value.role !== att.role) ws.serializeAttachment({ ...att, role: live.value.role } satisfies SocketAttachment);
      }
    }
  }

  private broadcast(): void {
    const pending = this.sql.exec<{ seq: number; payload: string }>('SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq', this.lastBroadcast).toArray();
    if (!pending.length) return;
    this.lastBroadcast = pending[pending.length - 1]!.seq;
    const nowS = Date.now() / 1000;
    const sockets = this.ctx.getWebSockets().filter((ws) => {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      // No attachment or no expiry = not a socket we vetted: refuse it as well.
      if (att && att.exp > nowS) return true;
      try {
        ws.close(WS_CLOSE_TOKEN_EXPIRED, 'token expired');
      } catch {
        // already closed
      }
      return false;
    });
    const allowed = this.closeUnseatedSockets(sockets); // backstop: re-checked at every push, whatever closed (or failed to close) a socket earlier
    if (!allowed.length) return;
    for (const e of pending) {
      const frame = JSON.stringify({ ...(JSON.parse(e.payload) as object), seq: e.seq });
      for (const ws of allowed) {
        try {
          ws.send(frame);
        } catch {
          // a dead socket is closed by the runtime; the client resyncs by seq
        }
      }
    }
  }

  /** Events after `after`, oldest first (at most the 1,000 kept). A first item whose seq is not after+1 means the gap is too old: reload the list. */
  async eventsAfter(after: number): Promise<{ items: unknown[]; latestSeq: number }> {
    const items = this.sql
      .exec<{ seq: number; payload: string }>('SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?', after, EVENTS_KEPT)
      .toArray()
      .map((e) => ({ ...(JSON.parse(e.payload) as object), seq: e.seq }));
    const latestSeq = this.sql.exec<{ s: number | null }>('SELECT max(seq) AS s FROM events').one().s ?? after;
    return { items, latestSeq: Math.max(latestSeq, 0) };
  }

  private emitMessageCreated(messageId: number): void {
    const row = this.sql.exec<MessageRow & { conversation_id: number }>(`SELECT ${MESSAGE_COLUMNS}, m.conversation_id FROM messages m WHERE m.id = ?`, messageId).toArray()[0];
    if (row) this.recordEvent({ type: 'message.created', conversationId: row.conversation_id, message: messageDto(row, this.workspaceId) });
  }

  /** Voice note outcome (see LinkHost.recordVoice). The transcript is stored like typed text: body, preview, search index. */
  private recordVoice(messageId: number, transcript: string | null): boolean {
    return this.ctx.storage.transactionSync(() => {
      const cur = this.sql.exec<{ voice_state: string | null }>('SELECT voice_state FROM messages WHERE id = ?', messageId).toArray()[0];
      if (!cur) return false; // erased meanwhile
      if (cur.voice_state) return true; // first write wins (a retried task never rewrites it)
      const preview = transcript ? previewOf(transcript) : null;
      this.sql.exec('UPDATE messages SET voice_state = ?, body = ?, preview = ?, updated_at = ? WHERE id = ?', transcript ? 'ok' : 'failed', transcript, preview, Date.now(), messageId);
      this.indexMessage(messageId, preview);
      this.emitMessageCreated(messageId);
      return true;
    });
  }

  private emitMessageStatus(messageId: number): void {
    const m = this.sql.exec<{ conversation_id: number; status: string | null; error_code: number | null }>('SELECT conversation_id, status, error_code FROM messages WHERE id = ?', messageId).toArray()[0];
    if (m?.status) this.recordEvent({ type: 'message.status', conversationId: m.conversation_id, messageId, status: m.status, errorCode: m.error_code });
  }

  /** Public only so tests can fill the log; callers inside the DO use it after changing a conversation. */
  emitConversationUpdated(conversationId: number): void {
    const conversation = this.conversationById(conversationId, Date.now());
    if (conversation) this.recordEvent({ type: 'conversation.updated', conversation });
  }

  // ---- media ------------------------------------------------------------------------------------------------------

  /** Downloads an inbound file to R2 and tells clients the media is ready. A message erased meanwhile leaves nothing behind. */
  private async fetchInboundMedia(messageId: number, mediaId: string, phoneNumberId?: string): Promise<void> {
    const msg = this.sql.exec<{ wamid: string | null; media_mime: string | null }>('SELECT wamid, media_mime FROM messages WHERE id = ?', messageId).toArray()[0];
    if (!msg?.wamid) return; // erased before we got to it
    const key = `media/${this.workspaceId}/${msg.wamid}`;
    // The file is fetched with the token of the number it arrived on (a task queued before this field existed falls back to the workspace's active number).
    const via = phoneNumberId ?? (await activeNumberFor(this.env.DB, this.workspaceId))?.phoneNumberId;
    const token = via ? await graphTokenFor(this.env, { phoneNumberId: via }) : this.env.META_SYSTEM_TOKEN;
    const got = await downloadToR2(this.env, token, mediaId, key, msg.media_mime ?? 'application/octet-stream');
    const stillThere = this.ctx.storage.transactionSync(() => {
      const r = this.sql.exec('UPDATE messages SET media_r2_key = ?, media_size = ?, media_mime = ?, updated_at = ? WHERE id = ?', key, got.size, got.mime, Date.now(), messageId);
      if (r.rowsWritten === 0) return false;
      this.emitMessageCreated(messageId);
      return true;
    });
    if (!stillThere) await this.env.MEDIA.delete(key);
  }

  /** Where a message's file lives in R2 (inbound after download, outbound from upload). Null when it has none yet. */
  async getMedia(messageId: number): Promise<{ key: string; mime: string; size: number | null } | null> {
    const m = this.sql.exec<{ media_r2_key: string | null; media_mime: string | null; media_size: number | null }>('SELECT media_r2_key, media_mime, media_size FROM messages WHERE id = ?', messageId).toArray()[0];
    return m?.media_r2_key && m.media_mime ? { key: m.media_r2_key, mime: m.media_mime, size: m.media_size } : null;
  }

  /** A file we uploaded to Meta, kept in R2 so the inbox can show it and a later send can reference it. */
  async recordUpload(u: { id: string; metaMediaId: string; mime: string; size: number; filename: string; r2Key: string }): Promise<void> {
    this.sql.exec('INSERT INTO uploads (id, meta_media_id, mime, size, filename, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', u.id, u.metaMediaId, u.mime, u.size, u.filename, u.r2Key, Date.now());
  }

  // ---- search index ----------------------------------------------------------------------------------------------

  /** Adds one message to the full-text index. Text is normalised here and at query time with the same function. */
  private indexMessage(messageId: number, preview: string | null, fold: (t: string) => string = searchFoldOf(this.sql)): void {
    const t = preview ? fold(preview) : '';
    if (t) this.sql.exec('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)', messageId, t);
  }

  /** Rebuilds the index from message previews (after a restore, or for rows older than the index). */
  private rebuildFts(): void {
    this.ctx.storage.transactionSync(() => {
      rebuildContactIndex(this.sql);
      this.sql.exec('DELETE FROM messages_fts');
      const fold = searchFoldOf(this.sql); // read the marker once for the whole rebuild
      for (const m of this.sql.exec<{ id: number; preview: string }>('SELECT id, preview FROM messages WHERE preview IS NOT NULL').toArray()) this.indexMessage(m.id, m.preview, fold);
    });
  }

  /** Contacts that predate `contacts_fts` (v31) get their names indexed once, when the DO wakes; afterwards every name write maintains it. */
  private reindexContactsIfEmpty(): void {
    if (this.sql.exec('SELECT 1 FROM contacts_fts LIMIT 1').toArray().length) return;
    if (this.sql.exec('SELECT 1 FROM contacts WHERE profile_name IS NOT NULL LIMIT 1').toArray().length) this.ctx.storage.transactionSync(() => rebuildContactIndex(this.sql));
  }

  private reindexIfEmpty(): void {
    if (this.sql.exec('SELECT 1 FROM messages_fts LIMIT 1').toArray().length) return;
    if (this.sql.exec('SELECT 1 FROM messages WHERE preview IS NOT NULL LIMIT 1').toArray().length) this.rebuildFts();
  }

  // ---- inbox reads and edits --------------------------------------------------------------------------------------

  private static readonly CONVERSATION_SELECT = `SELECT c.id, ct.wa_id, ct.profile_name, ct.opted_out_at, ct.last_inbound_at, c.unread, c.assignee_user_id, c.last_message_at,
      lm.preview AS lm_preview, lm.direction AS lm_direction, lm.type AS lm_type, lm.status AS lm_status, lm.created_at AS lm_at
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN messages lm ON lm.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1)`;

  private tagsFor(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!ids.length) return out;
    for (const t of this.sql.exec<{ conversation_id: number; tag: string }>(`SELECT conversation_id, tag FROM conversation_tags WHERE conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`, ...ids)) {
      (out.get(t.conversation_id) ?? out.set(t.conversation_id, []).get(t.conversation_id)!).push(t.tag);
    }
    return out;
  }

  private conversationById(id: number, now: number): ConversationDto | null {
    const row = this.sql.exec<ConversationRow>(`${WorkspaceDO.CONVERSATION_SELECT} WHERE c.id = ?`, id).toArray()[0];
    return row ? conversationDto(row, this.tagsFor([id]).get(id) ?? [], now) : null;
  }

  /** The inbox filter as SQL conditions on `c` (conversations). `mine` needs the caller. */
  private filterWhere(filter: 'all' | 'unread' | 'mine' | 'unassigned', userId: string, where: string[], params: SqlStorageValue[]): void {
    if (filter === 'unread') where.push('c.unread > 0');
    else if (filter === 'mine') { where.push('c.assignee_user_id = ?'); params.push(userId); }
    else if (filter === 'unassigned') where.push('c.assignee_user_id IS NULL');
  }

  private conversationDtos(rows: ConversationRow[], now: number): ConversationDto[] {
    const tags = this.tagsFor(rows.map((r) => r.id));
    return rows.map((r) => conversationDto(r, tags.get(r.id) ?? [], now));
  }

  /** Newest first by (last_message_at, id); `cursor` is the opaque "<at>.<id>" of the last row of the previous page. */
  async listConversations(opts: { filter: 'all' | 'unread' | 'mine' | 'unassigned'; userId: string; cursor?: string; limit: number }, now = Date.now()): Promise<{ items: ConversationDto[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    this.filterWhere(opts.filter, opts.userId, where, params);
    const m = opts.cursor ? /^(\d+)\.(\d+)$/.exec(opts.cursor) : null;
    if (m) { where.push('(c.last_message_at, c.id) < (?, ?)'); params.push(Number(m[1]), Number(m[2])); }
    const rows = this.sql
      .exec<ConversationRow>(`${WorkspaceDO.CONVERSATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`, ...params, opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return { items: this.conversationDtos(page, now), nextCursor: rows.length > opts.limit && last ? `${last.last_message_at ?? 0}.${last.id}` : null };
  }

  /**
   * Typeahead over conversations: the contact's name (every typed word is a prefix of a name word), the number (`wa_id` contains the typed digits,
   * only from 3 digits so one or two digits never scan), or a message (messages_fts). Newest activity first, at most `limit`, same DTO as the list.
   * The query is only ever a bound parameter or a token quoted by ftsMatch (inner quotes doubled); it is never logged.
   */
  async searchConversations(q: string, filter: 'all' | 'unread' | 'mine' | 'unassigned', limit: number, userId: string, now = Date.now()): Promise<ConversationDto[]> {
    const tokens = searchWords(this.sql, q);
    const digits = phoneDigits(q);
    const match = ftsMatch(tokens);
    const any: string[] = [];
    const params: SqlStorageValue[] = [];
    if (tokens.length) {
      any.push('c.contact_id IN (SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ?)');
      params.push(match);
      any.push('c.id IN (SELECT m.conversation_id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ?)');
      params.push(match);
    }
    if (digits.length >= 3) { any.push('instr(ct.wa_id, ?) > 0'); params.push(digits); }
    if (!any.length) return [];
    const where = [`(${any.join(' OR ')})`];
    this.filterWhere(filter, userId, where, params);
    const rows = this.sql
      .exec<ConversationRow>(`${WorkspaceDO.CONVERSATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`, ...params, limit)
      .toArray();
    return this.conversationDtos(rows, now);
  }

  /** The newest `limit` messages before message id `before`, oldest first. Null when the conversation does not exist. */
  async getMessages(conversationId: number, before: number | undefined, limit: number): Promise<{ items: MessageDto[]; nextBefore: number | null } | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const workspaceId = this.workspaceId;
    const rows = this.sql
      .exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.conversation_id = ? ${before !== undefined ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
        ...(before !== undefined ? [conversationId, before, limit + 1] : [conversationId, limit + 1]),
      )
      .toArray();
    const page = rows.slice(0, limit).reverse();
    return { items: page.map((r) => messageDto(r, workspaceId)), nextBefore: rows.length > limit && page[0] ? page[0].id : null };
  }

  /** The whole text of a message whose body lives in R2 (or inline). Null when there is no such message. */
  async getBody(messageId: number): Promise<{ text: string } | null> {
    const m = this.sql.exec<{ body: string | null; body_r2_key: string | null; preview: string | null }>('SELECT body, body_r2_key, preview FROM messages WHERE id = ?', messageId).toArray()[0];
    if (!m) return null;
    if (m.body !== null) return { text: m.body };
    if (m.body_r2_key) {
      const obj = await this.env.MEDIA.get(m.body_r2_key);
      if (obj) return { text: await obj.text() };
    }
    return { text: m.preview ?? '' };
  }

  async markRead(conversationId: number, now = Date.now()): Promise<ConversationDto | null> {
    this.sql.exec('UPDATE conversations SET unread = 0 WHERE id = ?', conversationId);
    this.emitConversationUpdated(conversationId);
    return this.conversationById(conversationId, now);
  }

  /**
   * Assigns (or clears) the owner of a conversation. Staff lists live in the Store, which this service cannot ask yet, so
   * only a user the server can vouch for is accepted: null, the caller, or someone already assigned in this workspace.
   */
  async assign(conversationId: number, userId: string | null, callerUserId: string, now = Date.now()): Promise<{ ok: true; conversation: ConversationDto } | { ok: false; reason: 'not_found' | 'unknown_assignee' }> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return { ok: false, reason: 'not_found' };
    if (userId !== null && userId !== callerUserId && !this.sql.exec('SELECT 1 FROM conversations WHERE assignee_user_id = ? LIMIT 1', userId).toArray().length) {
      return { ok: false, reason: 'unknown_assignee' };
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE conversations SET assignee_user_id = ? WHERE id = ?', userId, conversationId);
      // A person owns the chat now: the agent stays out of it for the handoff window.
      const wa = userId === null ? undefined : this.sql.exec<{ wa_id: string }>('SELECT ct.wa_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?', conversationId).toArray()[0]?.wa_id;
      if (wa) staffReplied(this.host(), wa, now);
    });
    this.emitConversationUpdated(conversationId);
    const conversation = await this.conversationById(conversationId, now);
    return conversation ? { ok: true, conversation } : { ok: false, reason: 'not_found' };
  }

  async setTags(conversationId: number, tags: string[], now = Date.now()): Promise<ConversationDto | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]; // lower-cased like a contact's tags: "VIP" and "vip" are one tag
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM conversation_tags WHERE conversation_id = ?', conversationId);
      for (const t of clean) this.sql.exec('INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', conversationId, t);
      this.emitConversationUpdated(conversationId);
    });
    return this.conversationById(conversationId, now);
  }

  // ---- Quick replies (A25): the merchant's canned texts for the composer ----------------------------------------------------------
  async listQuickReplies(): Promise<QuickReplyDto[]> {
    return this.sql.exec<{ id: number; text: string; position: number; created_at: number }>('SELECT id, text, position, created_at FROM quick_replies ORDER BY position, id').toArray()
      .map((r) => ({ id: r.id, text: r.text, position: r.position, createdAt: r.created_at }));
  }

  async createQuickReply(a: { text: string; actor: string }, now = Date.now()): Promise<{ ok: true; reply: QuickReplyDto } | { ok: false; reason: 'limit' | 'duplicate' }> {
    return this.ctx.storage.transactionSync(() => {
      const have = this.sql.exec<{ n: number; p: number }>('SELECT count(*) AS n, coalesce(max(position), 0) AS p FROM quick_replies').one();
      if (have.n >= MAX_QUICK_REPLIES) return { ok: false as const, reason: 'limit' as const };
      if (this.sql.exec('SELECT 1 FROM quick_replies WHERE text = ?', a.text).toArray().length) return { ok: false as const, reason: 'duplicate' as const };
      const id = this.sql.exec<{ id: number }>('INSERT INTO quick_replies (text, position, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id', a.text, have.p + 1, a.actor, now).one().id;
      return { ok: true as const, reply: { id, text: a.text, position: have.p + 1, createdAt: now } };
    });
  }

  async updateQuickReply(id: number, text: string): Promise<{ ok: true; reply: QuickReplyDto } | { ok: false; reason: 'not_found' | 'duplicate' }> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ position: number; created_at: number }>('SELECT position, created_at FROM quick_replies WHERE id = ?', id).toArray()[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (this.sql.exec('SELECT 1 FROM quick_replies WHERE text = ? AND id <> ?', text, id).toArray().length) return { ok: false as const, reason: 'duplicate' as const };
      this.sql.exec('UPDATE quick_replies SET text = ? WHERE id = ?', text, id);
      return { ok: true as const, reply: { id, text, position: row.position, createdAt: row.created_at } };
    });
  }

  async deleteQuickReply(id: number): Promise<boolean> {
    return this.sql.exec('DELETE FROM quick_replies WHERE id = ?', id).rowsWritten > 0;
  }

  async addNote(conversationId: number, authorUserId: string, text: string, now = Date.now()): Promise<NoteDto | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const id = this.sql.exec<{ id: number }>('INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id', conversationId, authorUserId, text, now).one().id;
    return { id, authorUserId, text, at: now };
  }

  async listNotes(conversationId: number): Promise<NoteDto[] | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    return this.sql
      .exec<{ id: number; author_user_id: string; text: string; created_at: number }>('SELECT id, author_user_id, text, created_at FROM notes WHERE conversation_id = ? ORDER BY id', conversationId)
      .toArray()
      .map((n) => ({ id: n.id, authorUserId: n.author_user_id, text: n.text, at: n.created_at }));
  }

  /** Full-text search over message previews: every word is a prefix match, both sides normalised the same way. */
  async search(q: string, limit: number): Promise<{ conversationId: number; messageId: number; snippet: string; at: number }[]> {
    const tokens = searchWords(this.sql, q);
    if (!tokens.length) return [];
    // ftsMatch quotes every token and doubles any inner quote, so no typed text reaches the FTS5 grammar.
    const match = ftsMatch(tokens);
    return this.sql
      .exec<{ id: number; conversation_id: number; preview: string | null; created_at: number }>(
        'SELECT m.id, m.conversation_id, m.preview, m.created_at FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?',
        match, limit,
      )
      .toArray()
      .map((r) => ({ conversationId: r.conversation_id, messageId: r.id, snippet: Array.from(r.preview ?? '').slice(0, 160).join(''), at: r.created_at }));
  }

  /** Schedules the nightly backup and R2 drain if they are not pending yet (idempotent; cheap enough for every ingest). */
  private ensureDaily(now: number): boolean {
    const have = new Set(this.sql.exec<{ kind: string }>("SELECT kind FROM scheduled_tasks WHERE kind IN ('backup', 'r2_drain', 'retention_purge')").toArray().map((r) => r.kind));
    let added = false;
    for (const kind of DAILY_KINDS) {
      if (have.has(kind)) continue;
      addTask(this.sql, kind, nextLocalHour(now, dailyHour(kind), BACKUP_TIME_ZONE));
      added = true;
    }
    return added;
  }

  private async ensureBackupAlarm(): Promise<void> {
    if (this.ensureDaily(Date.now())) await this.arm();
  }

  /** The one DO alarm always points at the earliest pending task. */
  private async arm(): Promise<void> {
    const next = earliestDue(this.sql);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Schedules a task and re-arms the alarm. Backup and r2_drain keep only their earliest due time. */
  async schedule(kind: TaskKind, dueAt: number, payload?: TaskPayload): Promise<void> {
    addTask(this.sql, kind, dueAt, payload);
    await this.arm();
  }

  /** The alarm's run while it is in flight: a direct caller of runDueTasks waits for it (see there). */
  private alarmRun: Promise<unknown> | null = null;

  async alarm(): Promise<void> {
    if (this.offboarded || this.offboarding) return;
    const run = this.drainDueTasks(Date.now());
    this.alarmRun = run;
    try {
      await run;
    } finally {
      if (this.alarmRun === run) this.alarmRun = null;
    }
  }

  /**
   * Runs every due task, then waits for an alarm run that was already in flight. A task the alarm had claimed (leased) is skipped by
   * our own pass, so without the wait a caller could return while that task's work (e.g. a hand-over to the send queue) was still
   * underway, and see a state that is about to change.
   */
  async runDueTasks(now = Date.now()): Promise<{ ran: number; failed: number }> {
    const r = await this.drainDueTasks(now);
    if (this.alarmRun) await this.alarmRun.catch(() => undefined);
    return r;
  }

  /**
   * Runs every due task, each in isolation: a failure is recorded with exponential backoff and never stops the others.
   * A handler may return the next due time (daily tasks reschedule themselves) or nothing (the task is done).
   */
  private async drainDueTasks(now: number): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    for (;;) {
      const due = claimDueTasks(this.sql, now, 50);
      if (!due.length) break;
      for (const t of due) {
        ran++;
        try {
          const nextDue = await this.runTask(t.kind, t.payload, now, t.attempts);
          // The row may have been deleted while the task ran (erasure) and its id reused by a NEW task: only touch the leased row we claimed.
          if (nextDue === undefined) this.sql.exec('DELETE FROM scheduled_tasks WHERE id = ? AND kind = ? AND lease_until IS NOT NULL', t.id, t.kind);
          else this.sql.exec('UPDATE scheduled_tasks SET due_at = ?, attempts = 0, last_error = NULL, lease_until = NULL WHERE id = ? AND kind = ? AND lease_until IS NOT NULL', nextDue, t.id, t.kind);
        } catch (err) {
          failed++;
          const attempts = t.attempts + 1;
          this.sql.exec('UPDATE scheduled_tasks SET attempts = ?, due_at = ?, last_error = ?, lease_until = NULL WHERE id = ? AND kind = ? AND lease_until IS NOT NULL', attempts, now + retryDelayMs(err, attempts), safeMessage(err), t.id, t.kind);
          alert(`${t.kind}_failed`, { workspace: this.workspaceId, attempts, error: errClass(err) });
        }
      }
    }
    this.ensureDaily(now);
    await this.arm();
    return { ran, failed };
  }

  /** One task. Returns the next due time for self-rescheduling tasks. Throws to be retried with backoff. */
  private async runTask(kind: TaskKind, payload: string | null, now: number, attempts: number): Promise<number | undefined> {
    switch (kind) {
      case 'backup': {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: BACKUP_TIME_ZONE }).format(now);
        await this.exportSnapshot(date);
        return nextLocalHour(now + 3_600_000, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE);
      }
      case 'retention_purge': {
        const r = await this.retentionPurge(now);
        return r.more ? now + 60_000 : nextLocalHour(now + 3_600_000, dailyHour('retention_purge'), BACKUP_TIME_ZONE);
      }
      case 'handoff_digest': {
        const pn = (await this.env.DB.prepare("SELECT phone_number_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY phone_number_id LIMIT 1").bind(this.workspaceId).first<{ phone_number_id: string }>())?.phone_number_id ?? null;
        await prepareOwnerNotice(this.host());
        runHandoffDigest(this.host(), pn, now);
        return readAgentSettings(this.sql).notifyPhone ? nextLocalHour(now + 3_600_000, DIGEST_HOUR_LOCAL, BACKUP_TIME_ZONE) : undefined; // asked for only while an owner number is set
      }
      case 'template_refresh': {
        // No polling while nothing is waiting: the task is armed by a submission and ends when no template is PENDING any more.
        const number = await this.env.DB.prepare("SELECT waba_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid LIMIT 1").bind(this.workspaceId).first<{ waba_id: string }>();
        if (number && (await this.pendingTemplates(0, now)).length > 0) {
          const a = { token: await graphTokenFor(this.env, { wabaId: number.waba_id }), graphVersion: this.env.META_GRAPH_VERSION, wabaId: number.waba_id };
          const r = await refreshPendingWith(this, a, TEMPLATE_PENDING_AFTER_MS, now);
          if (!r.ok) throw new Error(`template refresh: ${r.message}`); // a Graph failure retries on the task backoff ladder
        }
        return this.sql.exec("SELECT 1 FROM templates WHERE status = 'PENDING' LIMIT 1").toArray().length > 0 ? now + TEMPLATE_PENDING_AFTER_MS : undefined;
      }
      case 'ws_sweep': {
        await this.sweepSockets(now / 1000);
        return this.ctx.getWebSockets().length ? now + WS_SWEEP_MS : undefined;
      }
      case 'r2_drain': {
        const stillOwed = await this.drainR2Deletes();
        if (stillOwed > 0) {
          alert('r2_deletes_still_owed', { workspace: this.workspaceId, keys: stillOwed });
          return now + 3_600_000;
        }
        return nextLocalHour(now + 3_600_000, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE);
      }
      case 'send_release': {
        const job = sendJobSchema.safeParse((JSON.parse(payload ?? 'null') as { job?: unknown } | null)?.job);
        if (!job.success) {
          alert('scheduled_task_invalid', { kind, workspace: this.workspaceId });
          return undefined; // a payload that can never parse must not retry forever
        }
        await this.env.SEND_QUEUE.sendBatch([{ body: job.data }]);
        return undefined;
      }
      case 'media_fetch': {
        const p = JSON.parse(payload ?? 'null') as { messageId?: number; mediaId?: string; phoneNumberId?: string } | null;
        if (typeof p?.messageId !== 'number' || typeof p.mediaId !== 'string') return undefined;
        try {
          await this.fetchInboundMedia(p.messageId, p.mediaId, p.phoneNumberId);
        } catch (err) {
          if (attempts + 1 < MEDIA_FETCH_MAX_ATTEMPTS) throw err;
          // Meta media ids live 30 days and we retried for hours: stop, say so, keep the message (without its media).
          alert('media_fetch_abandoned', { workspace: this.workspaceId, attempts: attempts + 1, error: errClass(err) });
        }
        return undefined;
      }
      case 'cod_outcome_push': {
        const orderId = (JSON.parse(payload ?? 'null') as { orderId?: string } | null)?.orderId;
        if (typeof orderId === 'string') await pushCodOutcome(this.host(), orderId, now);
        return undefined;
      }
      case 'opt_out_push':
        await pushOptOut(this.host(), payload);
        return undefined;
      case 'erased_order_notify':
        await pushErasedOrders(this.host());
        return undefined;
      case 'cod_no_reply': {
        const orderId = (JSON.parse(payload ?? 'null') as { orderId?: string } | null)?.orderId;
        if (typeof orderId === 'string') this.ctx.storage.transactionSync(() => closeUnanswered(this.host(), orderId, now));
        return undefined; // the push it schedules runs in this same pass
      }
      case 'instapay_overdue': {
        const id = (JSON.parse(payload ?? 'null') as { instapayRequestId?: string } | null)?.instapayRequestId;
        if (typeof id === 'string') await overdueOne(this.env, id, now);
        return undefined;
      }
      case 'bot_turn': {
        const input = botInputSchema.safeParse(JSON.parse(payload ?? 'null'));
        if (!input.success) {
          alert('scheduled_task_invalid', { kind, workspace: this.workspaceId });
          return undefined;
        }
        try {
          await runTurn(this.host(), input.data, now);
        } catch (err) {
          // Give up quietly after a few tries: the customer can simply write again.
          if (attempts + 1 < BOT_TURN_MAX_ATTEMPTS) throw err;
          alert('bot_turn_abandoned', { workspace: this.workspaceId, attempts: attempts + 1, error: errClass(err) });
          // A voice note whose file never arrived is never dropped silently: the inbox says so and the customer is asked to type.
          if (input.data.type === 'audio') await abandonVoiceTurn(this.host(), input.data, now).catch(() => undefined);
        }
        return undefined;
      }
      case 'kb_index':
        return runKbIndex(this.host(), now);
      case 'catalog_embed':
        return runCatalogEmbed(this.host(), now);
      case 'proactive_recs':
        return runProactiveRecs(this.host(), payload, now, attempts);
      case 'catalog_sync':
        return runCatalogSync(this.host(), now);
      case 'catalog_reconcile':
        return runCatalogReconcile(this.host(), now);
      case 'campaign_step':
        return sweepCampaigns(this.host(), now);
      case 'wallet_sweep':
        return this.ctx.storage.transactionSync(() => this.billing.sweep(now)) ?? undefined;
      case 'wallet_debt_sync':
        // WA-DEBT-1: a debt hold pauses running / scheduled campaigns (reason wallet_empty, queued pages parked, nothing resumes them) and D1 is derived from the flags.
        if (debtHold(this.sql)) await this.pauseCampaignsOn(null, 'wallet_empty', now, true);
        await syncSuspendedMirror(this.env.DB, this.workspaceId, suspensionState(this.sql), now);
        return undefined;
      case 'ledger_drain': {
        const r = await drainOutbox(this.env, this.sql, this.workspaceId, now);
        return r.remaining > 0 ? now + 5_000 : undefined;
      }
      case 'wallet_wait': {
        const job = sendJobSchema.safeParse((JSON.parse(payload ?? 'null') as { job?: unknown } | null)?.job);
        if (!job.success) return undefined;
        return this.releaseWaiting(job.data, now);
      }
      case 'shared_number_trueup': {
        const month = (JSON.parse(payload ?? 'null') as { month?: string } | null)?.month;
        if (typeof month !== 'string') return undefined;
        const again = await runTrueup(this.env, this.sql, this.billing, (f) => this.ctx.storage.transactionSync(f), this.workspaceId, month, now);
        return again ?? undefined;
      }
      case 'funnel_rollup':
        return funnelRollup(this.sql, now);
      case 'credit_month':
        return this.ctx.storage.transactionSync(() => runCreditMonth(this.sql, now));
      case 'subscription_expire': {
        // A paid early renewal queued behind this period starts now instead of the plan expiring (the control plane owns the queue).
        try {
          await rollRenewals(this.env, this.workspaceId, now);
          // ALWAYS load the control plane's current subscription and apply it when it is newer: a roll that committed in an earlier attempt
          // (whose push then failed) has nothing left to roll now, but the paid period it started must still reach this workspace.
          const ev = await currentEvent(this.env, this.workspaceId);
          if (ev) await this.applyEntitlement(ev, now);
        } catch (err) {
          alert('queued_period_roll_failed', { workspace: this.workspaceId, error: errClass(err) });
          return now + 60_000; // never expire a renewal that was paid for because D1 blinked
        }
        return this.ctx.storage.transactionSync(() => expireSubscription(this.sql, now)) ?? undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Writes every table as NDJSON plus a manifest (row count + sha256 per table) to R2.
   * Chunked and streamed (src/core/backup-export.ts, T17): NO single transaction over the workspace. Rowid tables stop at a high-water mark taken at the start, so a child never refers
   * to a parent the snapshot lacks; a row DELETED below the mark while the export runs (the retention purge, which runs at another hour) is tolerated, a row that is missing is not.
   */
  async exportSnapshot(date: string): Promise<BackupManifest> {
    if (this.offboarding || this.offboarded) throw new Error('workspace is being deleted');
    const run = this.writeSnapshot(date);
    this.snapshotRuns.add(run);
    try {
      return await run;
    } finally {
      this.snapshotRuns.delete(run);
    }
  }

  private async writeSnapshot(date: string): Promise<BackupManifest> {
    const workspaceId = this.workspaceId;
    const manifest: BackupManifest = { workspaceId, date, schemaVersion: DO_MIGRATIONS.length, tables: {} as BackupManifest['tables'] };
    const prefix = backupPrefix(workspaceId, date);
    // T17: chunked and streamed (src/core/backup-export.ts); the only transaction is the tiny read of the high-water marks.
    const marks = highWaterMarks(this.sql, this.ctx.storage, BACKUP_TABLES);
    for (const t of BACKUP_TABLES) {
      manifest.tables[t] = await exportTable({ sql: this.sql, bucket: this.env.BACKUPS, key: `${prefix}${t}.ndjson`, table: t, highWater: marks[t], chunkRows: this.backupChunkRows, ...(this.backupHooks.afterChunk ? { afterChunk: this.backupHooks.afterChunk } : {}) });
    }
    // M-174: signed when BACKUP_HMAC_KEY is set. The signature is part of the stored manifest and of the returned one.
    if (this.env.BACKUP_HMAC_KEY) manifest.signature = await signManifest(manifest, this.env.BACKUP_HMAC_KEY);
    await this.env.BACKUPS.put(`${prefix}manifest.json`, JSON.stringify(manifest));
    return manifest;
  }

  /** Rows per read of the chunked export (a field so a test can shrink it). */
  backupChunkRows = DEFAULT_CHUNK_ROWS;
  /** Test seam: runs after every chunk of every table, between reads. */
  backupHooks: { afterChunk?: (table: string, chunk: number) => Promise<void> } = {};

  /** Restores a snapshot into THIS workspace, which must be empty. Verifies counts and hashes before writing anything. */
  async importSnapshot(prefix: string): Promise<{ ok: true; manifest: BackupManifest; erasedSkipped?: number } | { ok: false; reason: string }> {
    try {
      const { manifest, erasedSkipped } = await this.importSnapshotOrThrow(prefix);
      // A restored campaign that was running has no workflow in this account's engine: the sweep starts one.
      addTask(this.sql, 'retention_purge', Date.now() + 60_000); // history the window already deleted must not come back with an old backup
      if (this.sql.exec("SELECT 1 FROM campaigns WHERE status IN ('scheduled', 'running') LIMIT 1").toArray().length) addTask(this.sql, 'campaign_step', Date.now() + 60_000);
      await this.ensureBackupAlarm();
      await this.arm();
      return { ok: true, manifest, ...(erasedSkipped ? { erasedSkipped } : {}) };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  private async importSnapshotOrThrow(prefix: string): Promise<{ manifest: BackupManifest; erasedSkipped: number }> {
    const manifestObj = await this.env.BACKUPS.get(`${prefix}manifest.json`);
    if (!manifestObj) throw new Error('backup manifest not found');
    const parsed = backupManifestSchema.safeParse(await manifestObj.json().catch(() => null));
    if (!parsed.success) throw new Error('backup manifest is invalid');
    const manifest = parsed.data;
    // M-174: with a key the manifest MUST carry a valid signature (an unsigned one is a stripped signature, not a legacy backup); a signed manifest is never
    // restored where nothing can check it. With no key and no signature the old integrity-only behaviour stands.
    const hmacKeys = [this.env.BACKUP_HMAC_KEY, this.env.BACKUP_HMAC_KEY_PREVIOUS].filter((k): k is string => !!k);
    if (hmacKeys.length) {
      if (!manifest.signature) throw new Error('backup manifest is not signed');
      if (!(await verifyManifestSignature(manifest, hmacKeys))) throw new Error('backup manifest signature invalid');
    } else if (manifest.signature) {
      throw new Error('backup manifest is signed but BACKUP_HMAC_KEY is not set');
    }
    // The signature proves the manifest is ours, not that it belongs HERE: a genuine signed manifest of another workspace or date, dropped into this folder
    // next to copies of that workspace's files, would pass every hash and the signature. It must name exactly the folder it is read from.
    if (backupPrefix(manifest.workspaceId, manifest.date) !== prefix) throw new Error('backup manifest is for another workspace or date');
    if (manifest.schemaVersion > DO_MIGRATIONS.length) throw new Error('backup is newer than this schema');
    const files: { t: (typeof BACKUP_TABLES)[number]; rows: Record<string, unknown>[] }[] = [];
    for (const t of BACKUP_TABLES) {
      const entry = manifest.tables[t];
      if (!entry) {
        files.push({ t, rows: [] }); // a Phase 1 backup has no entry for the Phase 2 tables
        continue;
      }
      const body = (await (await this.env.BACKUPS.get(`${prefix}${t}.ndjson`))?.text()) ?? '';
      if ((await sha256Hex(body)) !== entry.sha256) throw new Error(`backup checksum mismatch: ${t}`);
      const rows = body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      if (rows.length !== entry.rows) throw new Error(`backup row count mismatch: ${t}`);
      files.push({ t, rows });
    }
    // Everyone erased after this backup was taken is dropped before a single row is written (B3): an erased contact never comes back.
    const erasedSkipped = await dropErased(this.env, manifest.workspaceId, files);
    this.ctx.storage.transactionSync(() => {
      for (const t of BACKUP_TABLES) {
        if (this.sql.exec(`SELECT 1 FROM ${t} LIMIT 1`).toArray().length) throw new Error('restore target workspace is not empty');
      }
      for (const { t, rows } of files) {
        const allowed = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).toArray().map((c) => c.name));
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.some((c) => !allowed.has(c))) throw new Error(`backup has an unknown column in ${t}`);
          this.sql.exec(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as SqlStorageValue));
        }
      }
      // WA-RECS-1: a backup without a recommendProducts row (taken before the ruling) must stay OFF in a fresh, marked-ON workspace. The marker is dropped here;
      // agent_state is restored EXACTLY as backed up (no extra row), the default comes from workspace_meta, which is not a backed-up table.
      if (!this.sql.exec("SELECT 1 FROM agent_state WHERE key = 'setting.recommendProducts'").toArray().length) this.sql.exec("DELETE FROM workspace_meta WHERE key = 'recs_default_on'");
    });
    this.rebuildFts();
    return { manifest, erasedSkipped };
  }

  /**
   * Erases one contact (data-protection request): the contact, its conversation, every message in and out and their
   * status events. R2 body keys are recorded in r2_pending_deletes in the SAME transaction as the row deletes, and a
   * key leaves that table only after R2 confirms; any leftover is retried on the next erase and by the nightly alarm.
   */
  async eraseContact(waId: string): Promise<EraseResult> {
    const found = this.ctx.storage.transactionSync(() => {
      const contact = this.sql.exec<{ id: number; buyer_key: string | null; profile_name: string | null }>('SELECT id, buyer_key, profile_name FROM contacts WHERE wa_id = ?', waId).toArray()[0];
      if (!contact) return { found: false, keys: 0, messages: 0, statusEvents: 0 };
      forgetBuyer(this.host(), contact.buyer_key);
      dropProfile(this.host(), waId); // the agent's in-memory copy of the customer's Store profile (name, address) goes with the contact
      const conv = this.sql.exec<{ id: number }>('SELECT id FROM conversations WHERE contact_id = ?', contact.id).toArray()[0];
      const msgs = conv
        ? this.sql.exec<{ wamid: string | null; body_r2_key: string | null; media_r2_key: string | null; idempotency_key: string | null; direction: string }>('SELECT wamid, body_r2_key, media_r2_key, idempotency_key, direction FROM messages WHERE conversation_id = ?', conv.id).toArray()
        : [];
      let statusEvents = 0;
      let keys = 0;
      // Jobs already in the queue (or waiting in the scheduler) name this contact: cancel the waiting ones and remember the
      // keys of the rest so claimSend drops them. The keys are opaque ids (wamid / client uuid), not personal data.
      this.sql.exec("DELETE FROM scheduled_tasks WHERE kind IN ('send_release', 'wallet_wait') AND json_extract(payload, '$.job.to') = ?", waId);
      for (const m of msgs) {
        if (m.idempotency_key) {
          this.sql.exec('INSERT OR IGNORE INTO erased_keys (key) VALUES (?)', m.idempotency_key);
          this.billing.settleHold(m.idempotency_key, 'erased', Date.now()); // the hold goes back; the money rows and billable_sends stay
        }
        if (m.direction === 'in' && m.wamid) this.sql.exec('INSERT OR IGNORE INTO erased_keys (key) VALUES (?)', `reply:${m.wamid}`);
        for (const k of [m.body_r2_key, m.media_r2_key]) {
          if (!k) continue;
          // RETENTION's rule: a key another conversation's message still points at (a campaign image sent to many contacts) is kept, with its uploads row.
          if (conv && stillReferenced(this.sql, k, conv.id)) continue;
          this.sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', k);
          this.sql.exec('DELETE FROM uploads WHERE r2_key = ?', k);
          keys++;
        }
        if (!m.wamid) continue;
        // Count first (the delete is the shared list's, below): rowsWritten also counts index entries, so it is not a row count.
        statusEvents += this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM message_status_events WHERE wamid = ?', m.wamid).one().n;
      }
      // What is left of the customer goes through the ONE list the restore also filters by (src/core/erasure-targets.ts). The rows that hold keys to other
      // rows (agent turns, search, events) are removed first, because the list's `messages` step removes the rows they are found through.
      if (conv) this.sql.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE conversation_id = ?)', conv.id); // (the list below removes the rows it is found through)
      this.sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'bot_turn' AND json_extract(payload, '$.from') = ?", waId);
      deleteTargets(this.sql, { waId, contactId: contact.id, convId: conv?.id ?? null });
      this.sql.exec('DELETE FROM contacts_fts WHERE rowid = ?', contact.id);
      // The assistant's masked journal may carry this person's name (a customer list it read for the merchant): those rows go with them.
      doStorageOps(this.sql, (f) => this.ctx.storage.transactionSync(f)).eraseMentions([contact.profile_name ?? '', waId]);
      return { found: true, keys, messages: msgs.length, statusEvents };
    });
    // After the delete (a turn recording a step checks the message still exists, so nothing new can land): their unrolled analytics markers go too.
    await eraseFunnelMarkers(this.sql, waId);
    // The shared platform number keeps (in D1) which store wrote to this customer: that is this store's record too, so it goes with the contact.
    await eraseSharedFor(this.env, this.workspaceId, waId, (keys) => this.ctx.storage.transactionSync(() => { for (const k of keys) this.sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', k); }));
    // An import still running holds this phone in its uploaded file: end it and delete the file (a finished one was deleted already).
    for (const imp of this.sql.exec<{ id: string }>("SELECT id FROM imports WHERE status IN ('pending', 'running')").toArray()) failImport(this.host(), imp.id, 'contact_erased', Date.now());
    const r2Pending = await this.drainR2Deletes();
    if (r2Pending > 0) await this.schedule('r2_drain', Date.now() + 3_600_000); // R2 refused some deletes: try again within the hour
    return { found: found.found, messages: found.messages, statusEvents: found.statusEvents, r2Objects: found.keys, r2Pending, completedAt: Date.now() };
  }

  /**
   * Workspace deletion (OFFBOARD-1): removes this workspace's vectors, closes its sockets, cancels the alarm and erases ALL storage, leaving one
   * tombstone so a stray call can never recreate the schema. Idempotent. R2 objects are deleted by the caller (by prefix), after this.
   */
  async offboardWipe(): Promise<{ vectors: number }> {
    if (this.offboarded) return { vectors: 0 };
    // From here no new alarm run or backup starts, and the ones already running finish BEFORE anything is erased (their R2 writes are then visible to the caller's backups step).
    this.offboarding = true;
    await Promise.allSettled([this.alarmRun, ...this.snapshotRuns]);
    let vectors = 0;
    const v = this.env.VECTORIZE;
    if (v) {
      const ids = [
        ...this.sql.exec<{ vec_id: string }>('SELECT vec_id FROM kb_chunks').toArray(),
        ...this.sql.exec<{ vec_id: string }>('SELECT vec_id FROM catalog_vectors').toArray(),
      ].map((r) => r.vec_id);
      for (let i = 0; i < ids.length; i += 500) {
        await v.deleteByIds(ids.slice(i, i + 500));
        vectors += Math.min(500, ids.length - i);
      }
    }
    for (const sock of this.ctx.getWebSockets()) {
      try { sock.close(1001, 'workspace deleted'); } catch { /* already closed */ }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put('offboarded', Date.now());
    this.offboarded = true;
    return { vectors };
  }

  /** The assistant's journal (SL-CHAT-1). One RPC for the whole SmartLayerStorage; every op runs synchronously here, so each compare-and-set is atomic. */
  async smartLayer(op: SlOp, args: unknown[]): Promise<unknown> {
    if (!SL_OPS.includes(op)) throw new Error('unknown smart layer op');
    const ops = doStorageOps(this.sql, (f) => this.ctx.storage.transactionSync(f));
    return (ops[op] as (...a: unknown[]) => unknown)(...args);
  }

  /** This workspace's assistant mode (the per-store rollout flag, default off). Set only by an operator (`setAssistantMode`); a merchant can never raise it. */
  async assistantMode(): Promise<'off' | 'answer-only' | 'suggest' | 'act'> {
    const v = this.sql.exec<{ value: string }>("SELECT value FROM agent_state WHERE key = 'assistant.mode'").toArray()[0]?.value;
    return v === 'answer-only' || v === 'suggest' || v === 'act' ? v : 'off';
  }

  async setAssistantMode(mode: 'off' | 'answer-only' | 'suggest' | 'act'): Promise<void> {
    this.ctx.storage.transactionSync(() => this.sql.exec("INSERT INTO agent_state (key, value) VALUES ('assistant.mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mode));
  }

  /** Heavy assistant jobs spend AI credits: hold first (the cost was shown), settle on success, release on failure. Same ledger as the agent, note `assistant`. */
  async assistantHold(ref: string, credits: number, now = Date.now()): Promise<HoldResult> {
    return this.ctx.storage.transactionSync(() => holdCredits(this.sql, ref, now, credits));
  }
  async assistantSettle(ref: string, now = Date.now()): Promise<'charged' | 'refused' | 'noop'> {
    return this.ctx.storage.transactionSync(() => settleHold(this.sql, ref, now, this.workspaceId, 'assistant'));
  }
  async assistantRelease(ref: string, now = Date.now()): Promise<void> {
    this.ctx.storage.transactionSync(() => releaseHold(this.sql, ref, now));
  }

  // ---- Retention (B4 / T7), data-subject export (B5), contact edit and merge (M-175) -------------------------------------------------

  /** Proactive post-order suggestions (CHAT-RECS-SWITCH-1): the owner's switch and template name. Role is checked by the route. */
  async getProactiveRecs() {
    return proactiveRecsView(this.host());
  }

  async setProactiveRecs(patch: { enabled?: boolean; templateName?: string | null }) {
    return this.ctx.storage.transactionSync(() => writeProactiveRecs(this.host(), patch));
  }

  async getRetention() {
    return retentionView(this.sql);
  }

  /** The owner's window (null = the platform default). A shorter window is applied soon, not at the next night. */
  async setRetention(days: number | null, now = Date.now()) {
    this.ctx.storage.transactionSync(() => writeRetentionDays(this.sql, days));
    await this.schedule('retention_purge', now + 60_000);
    return retentionView(this.sql);
  }

  /** Deletes messages older than the window, a bounded number per pass; a backlog continues in a minute. Returns how many went and whether more are due. */
  async retentionPurge(now = Date.now(), opts: { batch?: number; maxBatches?: number } = {}): Promise<{ deleted: number; more: boolean }> {
    const cutoff = cutoffFor(this.sql, now);
    let deleted = 0;
    for (let i = 0; i < (opts.maxBatches ?? RETENTION_MAX_BATCHES); i++) {
      const n = this.ctx.storage.transactionSync(() => purgeBatch(this.sql, cutoff, opts.batch ?? RETENTION_BATCH));
      deleted += n;
      if (n < (opts.batch ?? RETENTION_BATCH)) break;
    }
    this.ctx.storage.transactionSync(() => purgeOldEvents(this.sql, cutoff)); // the realtime log is capped by age too, not only by count
    this.ctx.storage.transactionSync(() => doStorageOps(this.sql, (f) => this.ctx.storage.transactionSync(f)).purgeBefore(now - 90 * 86_400_000)); // the assistant's journal keeps 90 days (spec 6.9)
    if (deleted > 0) {
      const owed = await this.drainR2Deletes();
      if (owed > 0) await this.schedule('r2_drain', now + 3_600_000);
    }
    const more = hasExpired(this.sql, cutoff);
    if (more) await this.schedule('retention_purge', now + 60_000);
    return { deleted, more };
  }

  async exportContact(waId: string, after: number, limit: number) {
    return exportContact(this.sql, this.env.MEDIA, waId, after, limit);
  }

  async renameContact(waId: string, name: string | null) {
    return this.ctx.storage.transactionSync(() => renameContact(this.sql, waId, name));
  }

  async mergeContacts(fromWaId: string, intoWaId: string) {
    return this.ctx.storage.transactionSync(() => mergeContacts(this.sql, fromWaId, intoWaId, (id) => this.emitConversationUpdated(id)));
  }

  /** Deletes owed R2 objects in batches; returns how many are still owed (0 when R2 confirmed them all). */
  private async drainR2Deletes(): Promise<number> {
    for (;;) {
      const batch = this.sql.exec<{ key: string }>('SELECT key FROM r2_pending_deletes ORDER BY key LIMIT ?', R2_DELETE_BATCH).toArray().map((r) => r.key);
      if (!batch.length) return 0;
      try {
        await this.env.MEDIA.delete(batch);
      } catch (err) {
        alert('r2_delete_failed', { workspace: this.workspaceId, keys: batch.length, error: errClass(err) });
        return this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM r2_pending_deletes').one().n;
      }
      this.ctx.storage.transactionSync(() => {
        for (const k of batch) this.sql.exec('DELETE FROM r2_pending_deletes WHERE key = ?', k);
      });
    }
  }
}
