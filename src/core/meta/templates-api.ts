import { z } from 'zod';
import { componentsSchema } from '../templates';
import { fetchWithTimeout } from '../net/fetch-with-timeout';

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

const metaTemplateSchema = z.object({
  id: z.string().default(''),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  components: componentsSchema.default([]),
  rejected_reason: z.string().optional(),
}).loose();
export type MetaTemplate = z.infer<typeof metaTemplateSchema>;

type Auth = { token: string; graphVersion: string; wabaId: string };
export type TemplatesApiResult<T> = { ok: true; value: T } | { ok: false; message: string; retryable: boolean };

/** Every template of the WABA (follows paging). Any failed page fails the whole call so a sync never half-applies. */
export async function fetchTemplates(a: Auth, opts: { name?: string } = {}): Promise<TemplatesApiResult<MetaTemplate[]>> {
  const out: MetaTemplate[] = [];
  let url: string | null = `https://graph.facebook.com/${a.graphVersion}/${a.wabaId}/message_templates?limit=100&fields=id,name,language,category,status,components,rejected_reason${opts.name ? `&name=${encodeURIComponent(opts.name)}` : ''}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${a.token}` } }, { label: 'meta.templates.list', timeoutMs: TIMEOUT_MS });
    } catch (err) {
      return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown[]; paging?: { next?: string }; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    for (const item of json.data) {
      const t = metaTemplateSchema.safeParse(item);
      if (t.success) out.push(t.data);
      else console.warn('templates sync: item rejected');
    }
    url = json.paging?.next ?? null;
  }
  if (url) return { ok: false, message: 'too many template pages', retryable: false };
  return { ok: true, value: out };
}

export async function submitTemplate(a: Auth, body: { name: string; language: string; category: string; components: unknown[] }): Promise<TemplatesApiResult<{ id: string; status: string; category: string; categoryConfirmed: boolean }>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`https://graph.facebook.com/${a.graphVersion}/${a.wabaId}/message_templates`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, { label: 'meta.templates.submit', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as { id?: string; status?: string; category?: string; error?: { message?: string; error_user_msg?: string } } | null;
  // `categoryConfirmed` = Meta itself stated the category (it may differ from the requested one); when absent, `category` is only what we asked for.
  if (res.ok && json?.id) return { ok: true, value: { id: json.id, status: json.status ?? 'PENDING', category: json.category ?? body.category, categoryConfirmed: typeof json.category === 'string' } };
  return { ok: false, message: json?.error?.error_user_msg ?? json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
}

type GraphError = { error?: { message?: string; error_user_msg?: string } };
const failure = (res: Response, json: GraphError | null): { ok: false; message: string; retryable: boolean } => ({
  ok: false, message: json?.error?.error_user_msg ?? json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429,
});

/** Edit a template (`POST /{template-id}`). Meta replaces the components wholesale and re-reviews it, so the new status is PENDING. Meta answers `{ success: true }`. */
export async function editTemplate(a: Auth, templateId: string, body: { category?: string; components: unknown[] }): Promise<TemplatesApiResult<{ status: string }>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`https://graph.facebook.com/${a.graphVersion}/${encodeURIComponent(templateId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, { label: 'meta.templates.edit', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as ({ success?: boolean } & GraphError) | null;
  if (res.ok && json?.success === true) return { ok: true, value: { status: 'PENDING' } };
  return failure(res, json);
}

/** Delete a template. With `metaId` (`hsm_id`) only that one language goes; without it Meta deletes EVERY language of the name. */
export async function deleteTemplate(a: Auth, p: { name: string; metaId?: string }): Promise<TemplatesApiResult<{ deleted: true }>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`https://graph.facebook.com/${a.graphVersion}/${a.wabaId}/message_templates?name=${encodeURIComponent(p.name)}${p.metaId ? `&hsm_id=${encodeURIComponent(p.metaId)}` : ''}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${a.token}` },
    }, { label: 'meta.templates.delete', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as ({ success?: boolean } & GraphError) | null;
  if (res.ok && json?.success === true) return { ok: true, value: { deleted: true } };
  return failure(res, json);
}
