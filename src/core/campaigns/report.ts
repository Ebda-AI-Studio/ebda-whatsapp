/**
 * Compliance evidence a merchant can hand to Meta or keep (capabilities campaigns.report-export, compliance.opt-out-evidence). Both are read-only views of
 * what is already stored: no new table, no number in the campaign report (counts and reasons only), and the consent list is paged and owner-only.
 */
import type { CampaignDto } from '../api/contract';
import { latestProofs } from '../consent-proof';
import type { LinkHost } from '../store-link/host';
import { getCampaign } from './campaigns';

type Sql = DurableObjectStorage['sql'];

export type CampaignReport = {
  campaign: { id: string; name: string; status: CampaignDto['status']; template: CampaignDto['template']; category: string; createdAt: number; startedAt: number | null; finishedAt: number | null };
  /** Every recipient is queued through the consent gate: a contact with no consent, or who opted out, is skipped and never messaged. */
  consentGated: true;
  totals: CampaignDto['totals'];
  clicks: CampaignDto['clicks'];
  /** Why recipients were not messaged, by reason (counts only). */
  skippedByReason: Record<string, number>;
};

export async function campaignReport(host: LinkHost, id: string): Promise<CampaignReport | null> {
  const c = await getCampaign(host, id);
  if (!c) return null;
  const skippedByReason: Record<string, number> = {};
  for (const r of host.sql.exec<{ reason: string | null; n: number }>("SELECT coalesce(skip_reason, 'unknown') AS reason, count(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND state = 'skipped' GROUP BY reason", id).toArray()) skippedByReason[r.reason ?? 'unknown'] = r.n;
  return {
    campaign: { id: c.id, name: c.name, status: c.status, template: c.template, category: c.category, createdAt: c.createdAt, startedAt: c.startedAt, finishedAt: c.finishedAt },
    consentGated: true, totals: c.totals, clicks: c.clicks, skippedByReason,
  };
}

/** A spreadsheet cell that cannot run as a formula (a leading = + - @ is neutralised) and is quoted when it needs to be. */
export const csvCell = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function campaignReportCsv(r: CampaignReport): string {
  const rows: Array<[string, string | number | null]> = [
    ['campaign', r.campaign.name], ['status', r.campaign.status], ['template', `${r.campaign.template.name} (${r.campaign.template.language})`], ['category', r.campaign.category],
    ['started_at', r.campaign.startedAt ? new Date(r.campaign.startedAt).toISOString() : null], ['finished_at', r.campaign.finishedAt ? new Date(r.campaign.finishedAt).toISOString() : null],
    ['consent_gated', 'yes: only contacts with a consent on record and not opted out were messaged'],
    ['recipients', r.totals.recipients], ['sent', r.totals.sent], ['delivered', r.totals.delivered], ['read', r.totals.read], ['failed', r.totals.failed], ['skipped', r.totals.skipped], ['pending', r.totals.pending],
    ['link_clicks_unique', r.clicks.unique], ['link_clicks_total', r.clicks.total],
    ...Object.entries(r.skippedByReason).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]): [string, number] => [`skipped_${k}`, n]),
  ];
  return `field,value\r\n${rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`).join('\r\n')}\r\n`;
}

export const CONSENT_PAGE_MAX = 500;
export type ConsentEvidenceRow = { waId: string; name: string | null; consentSource: string | null; consentAt: number | null; optedOutAt: number | null; proof: { source: string; wording: string; at: number } | null };
export type ConsentEvidence = {
  summary: { contacts: number; withConsent: number; withConsentProof: number; optedOut: number; consentBySource: Record<string, number> };
  items: ConsentEvidenceRow[];
  nextAfter: number | null;
};

/** The counts (whole workspace) and one page of the per-contact consent / opt-out record, newest id first after the cursor. Times are epoch ms. */
export function consentEvidence(sql: Sql, after: number, limit: number): ConsentEvidence {
  const n = Math.min(Math.max(limit, 1), CONSENT_PAGE_MAX);
  const agg = sql.exec<{ contacts: number; with_consent: number; opted_out: number }>('SELECT count(*) AS contacts, coalesce(sum(consent_at IS NOT NULL), 0) AS with_consent, coalesce(sum(opted_out_at IS NOT NULL), 0) AS opted_out FROM contacts').one();
  const proofCount = sql.exec<{ n: number }>('SELECT count(DISTINCT contact_id) AS n FROM consent_proofs').one().n;
  const consentBySource: Record<string, number> = {};
  for (const r of sql.exec<{ s: string; n: number }>('SELECT consent_source AS s, count(*) AS n FROM contacts WHERE consent_at IS NOT NULL AND consent_source IS NOT NULL GROUP BY consent_source').toArray()) consentBySource[r.s] = r.n;
  const page = sql.exec<{ id: number; wa_id: string; profile_name: string | null; consent_source: string | null; consent_at: number | null; opted_out_at: number | null }>(
    'SELECT id, wa_id, profile_name, consent_source, consent_at, opted_out_at FROM contacts WHERE id > ? AND (consent_at IS NOT NULL OR opted_out_at IS NOT NULL) ORDER BY id LIMIT ?', after, n + 1,
  ).toArray();
  const rows = page.slice(0, n);
  const proofs = latestProofs(sql, rows.map((r) => r.id));
  return {
    summary: { contacts: agg.contacts, withConsent: agg.with_consent, withConsentProof: proofCount, optedOut: agg.opted_out, consentBySource },
    items: rows.map((r) => ({ waId: r.wa_id, name: r.profile_name, consentSource: r.consent_source, consentAt: r.consent_at, optedOutAt: r.opted_out_at, proof: proofs.has(r.id) ? { source: proofs.get(r.id)!.source, wording: proofs.get(r.id)!.wording, at: proofs.get(r.id)!.at } : null })),
    nextAfter: page.length > n ? rows[rows.length - 1]!.id : null,
  };
}

export function consentEvidenceCsv(e: ConsentEvidence): string {
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
  const head = 'wa_id,name,consent_source,consent_at,opted_out_at,proof_source,proof_wording,proof_at';
  const lines = e.items.map((r) => [r.waId, r.name, r.consentSource, iso(r.consentAt), iso(r.optedOutAt), r.proof?.source, r.proof?.wording, r.proof ? iso(r.proof.at) : ''].map((v) => csvCell(v as string)).join(','));
  return `${[head, ...lines].join('\r\n')}\r\n`;
}
